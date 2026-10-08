// ============================================================================
// 商品的批量操作：批量上下架 / 批量改价 / 批量调库存
//
// 【这一节唯一要记住的事：失败一定要「抛」，不能「return」】
//
// 假设批量下架 10 款商品，改到第 7 款时发现它已经被别人删了。
// 这时如果写的是：
//
//     for (const id of ids) {
//       if (await 商品不存在(id)) return { ok: false, error: "..." }   // ✗
//       await 下架(id)
//     }
//
// 那么前 6 款**已经改完了**，而且会就这样留在库里 ——
// 返回一个「失败」的提示，数据却半新半旧。管理员看到报错，
// 刷新一下发现 6 款真的下架了，于是彻底搞不清到底发生了什么。
//
// 正确写法是在事务里 throw：
//
//     await prisma.$transaction(async (tx) => {
//       ...
//       throw new BulkAbort("...")   // ✓ Prisma 捕获后回滚整个事务
//     })
//
// 回滚之后数据库回到操作前的样子，前 6 款商品原封不动。
// 「报错时什么都不该发生」—— 这是事务存在的全部意义，
// 也是这个文件所有函数共用的骨架（见下面的 runInTransaction）。
//
// 【顺带一提：为什么不用 prisma.$transaction([a, b, c]) 数组形式】
// 那种写法确实也是一次事务，但它没法做「先查、根据查到的结果决定要不要继续」——
// 数组里每个操作在构造时就已经定死了。而这里每一步都要看前面的结果
// （商品还在不在？新价格合不合法？库存够不够？），所以必须用交互式事务。
// ============================================================================

import type { Prisma } from "@/generated/prisma/client"
import {
  BULK_MAX_SKUS,
  MAX_PRICE_CENTS,
  MAX_STOCK_DELTA,
} from "@/lib/constants"
import { prisma } from "@/lib/prisma"

export type BulkOperationResult =
  | { ok: true; affected: number; message: string }
  | { ok: false; error: string }

/**
 * 专门用来「主动放弃整批操作」的异常。
 *
 * 【为什么自定义一个类，而不是直接 throw new Error】
 * 因为要把它和**意外**的异常分开处理：
 *   - BulkAbort  → 是我们自己判断出来的业务问题，message 是写给管理员看的，
 *                  原样透出去（「XX 款只有 3 件，不够出库 10 件」）
 *   - 其他异常   → 没预料到的（约束冲突、连接断了），
 *                  给管理员一句能看懂的兜底话，真正的原因写进服务器日志
 * 混在一起的话，要么把数据库错误原样弹给管理员看，
 * 要么把「库存不够」这种有用信息也吞掉
 */
class BulkAbort extends Error {}

/**
 * 所有批量操作的统一外壳：**一个事务，失败整体回滚**。
 *
 * 业务逻辑只管在 work 里干活、发现问题就 throw BulkAbort，
 * 回滚、错误分类、日志这些横切的事都在这里做一次。
 */
async function runInTransaction(
  work: (
    tx: Prisma.TransactionClient,
  ) => Promise<{ affected: number; message: string }>,
): Promise<BulkOperationResult> {
  try {
    const result = await prisma.$transaction(work, {
      // 【为什么要显式放宽超时】
      // Prisma 交互式事务默认 5 秒。批量操作要挨个更新几十上百个 SKU，
      // 慢一点的机器上真的可能超。
      // 超时的后果是**回滚**（安全，数据不会坏），但管理员会看到一次
      // 莫名其妙的失败 —— 而重试一次又成功了，于是开始怀疑这个功能靠不靠谱。
      timeout: 15_000,
      // 等待拿到数据库写锁的时间。SQLite 是单写入者，
      // 如果有别的写请求在跑，这里要等一会儿，不该立刻失败
      maxWait: 5_000,
    })

    return { ok: true, ...result }
  } catch (error) {
    if (error instanceof BulkAbort) {
      return { ok: false, error: error.message }
    }

    // 走到这里说明是没预料到的错误。事务已经回滚，数据是干净的 ——
    // 对管理员来说「失败 = 什么都没变」，这一句就够他决定要不要重试了。
    // 真正的原因留在日志里给开发看
    console.error("[bulk] 批量操作失败，已整体回滚：", error)
    return { ok: false, error: "批量操作失败，已全部回滚，请重试" }
  }
}

type BulkSku = {
  id: string
  price: number
  stock: number
  size: string
  color: string
  productName: string
}

/**
 * 取出这批商品下的所有 SKU，顺便做两项前置检查。
 *
 * 【为什么「商品少了几个」要当成错误】
 * 批量用的 id 是管理员勾选那一刻的快照。从勾选到点确认之间，
 * 别人可能已经删掉了其中一款（比如开了两个后台页面）。
 * 这时 updateMany 会**静默跳过**不存在的 id，只改剩下的 ——
 * 界面弹「已下架 7 款」，他会以为 10 款都成功了。
 * 少改比改错好，但最好的是**明确告诉他少改了**。
 */
async function loadSkusOfProducts(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<BulkSku[]> {
  const found = await tx.product.count({ where: { id: { in: ids } } })
  if (found !== ids.length) {
    throw new BulkAbort(
      `勾选的 ${ids.length} 款商品里有 ${ids.length - found} 款已经不存在了，请刷新页面后重试`,
    )
  }

  const rows = await tx.sku.findMany({
    where: { productId: { in: ids } },
    select: {
      id: true,
      price: true,
      stock: true,
      size: true,
      color: true,
      product: { select: { name: true } },
    },
  })

  if (rows.length > BULK_MAX_SKUS) {
    throw new BulkAbort(
      `勾选的商品一共有 ${rows.length} 个规格，超过单次上限 ${BULK_MAX_SKUS} 个，请分批操作`,
    )
  }

  return rows.map((row) => ({
    id: row.id,
    price: row.price,
    stock: row.stock,
    size: row.size,
    color: row.color,
    productName: row.product.name,
  }))
}

/** 错误信息里怎么称呼一个规格：「XX 款 / 黑色 42 码」 */
function skuLabel(sku: BulkSku): string {
  return `${sku.productName} 的 ${sku.color} ${sku.size} 码`
}

// ---------------------------------------------------------------------------
// 批量上架 / 下架
// ---------------------------------------------------------------------------

/**
 * 一次性把多款商品设为上架或下架。
 *
 * 【为什么不返回「哪几款被改了」】
 * 因为这是一个**全有或全无**的操作：要么 10 款全改完，要么一款都没动。
 * 返回部分成功的列表，等于给了调用方一个「可能有中间状态」的错觉，
 * 而实际上不存在这种状态。
 */
export async function bulkSetProductActive(
  ids: string[],
  isActive: boolean,
): Promise<BulkOperationResult> {
  return runInTransaction(async (tx) => {
    const found = await tx.product.count({ where: { id: { in: ids } } })
    if (found !== ids.length) {
      throw new BulkAbort(
        `勾选的 ${ids.length} 款商品里有 ${ids.length - found} 款已经不存在了，请刷新页面后重试`,
      )
    }

    const result = await tx.product.updateMany({
      where: { id: { in: ids } },
      data: { isActive },
    })

    return {
      affected: result.count,
      message: `已${isActive ? "上架" : "下架"} ${result.count} 款商品`,
    }
  })
}

// ---------------------------------------------------------------------------
// 批量改价
// ---------------------------------------------------------------------------

export type BulkPriceMode = "percent" | "set"

/**
 * 批量改价。改的是所选商品下的**全部 SKU**。
 *
 * @param mode    percent = 按百分比调整；set = 统一设为固定价
 * @param value   percent 模式：整数百分比（-90 ~ 500）；set 模式：单价，单位分
 *
 * 【为什么要先把 48 个新价格全算完，再开始写】
 * 校验和写入分成两趟，是「整体回滚」在业务层的体现。
 * 如果边算边写，那么算到第 37 个发现「降 100% 会变成 0 分」时，
 * 前 36 个已经写进事务了 —— 虽然有事务兜底（抛异常就全回滚），
 * 但那时你根本不知道自己抛得对不对。
 * 先算完再写，逻辑上就只有两种结局：全部成功，或者一个都没写。
 *
 * 另一个好处是错误信息能说得具体：是**哪个**规格、
 * 改完是**多少**分、为什么不行。这比「第 37 条 UPDATE 失败」有用得多。
 */
export async function bulkUpdateProductPrice(
  ids: string[],
  mode: BulkPriceMode,
  value: number,
): Promise<BulkOperationResult> {
  return runInTransaction(async (tx) => {
    const skus = await loadSkusOfProducts(tx, ids)

    if (skus.length === 0) {
      throw new BulkAbort("勾选的商品都还没有规格，没有价格可以改")
    }

    const updates = skus.map((sku) => {
      // 【为什么是 Math.round 而不是直接除】
      // 降价 15% 时 89900 * 85 / 100 = 76415，整好；
      // 但 89999 * 85 / 100 = 76499.15，必须落到分。
      // 银行家舍入、向上取整这些规则各有各的说法，这里用最直白的四舍五入 ——
      // 重要的是**只在一个地方决定舍入规则**，而不是每个调用点各写一套。
      //
      // 这里的算术为什么不会丢精度：price 和 value 都是整数，
      // price * (100 + value) 最大也就 1e10 量级，远在 JS 安全整数
      // (2^53) 之内，乘法是精确的。只有最后那一次除法会产生小数，
      // 而它立刻被 round 掉了
      const next =
        mode === "percent" ? Math.round((sku.price * (100 + value)) / 100) : value

      // 【为什么下限是 1 分而不是 0】
      // 价格 0 在系统里是个「能走通但没意义」的状态：
      // 下单、算总价、生成订单全都不会报错，只会让每一笔都白送。
      // 这种「不报错的错误」最难发现，所以在入口就挡死。
      // 想白送就下架或另做一个 0 元赠品流程，别用改价来达成
      if (next < 1) {
        throw new BulkAbort(
          `${skuLabel(sku)} 改完的价格是 ${(next / 100).toFixed(2)} 元，不能低于 0.01 元。请调小降价幅度`,
        )
      }
      if (next > MAX_PRICE_CENTS) {
        throw new BulkAbort(
          `${skuLabel(sku)} 改完的价格超过上限，请检查是不是输入多打了一位`,
        )
      }

      return { id: sku.id, price: next, before: sku.price }
    })

    // 【这里是 N 条 UPDATE，会不会有问题】
    // 有问题，但可以接受，而且**只在这一处**可以接受：
    //   - 它们是同一个事务里的一串语句，不是「每条都重新查一次」的 N+1
    //   - 真正的风险是持有写锁的时间。所以上面限了 BULK_MAX_SKUS=500，
    //     500 条本地 UPDATE 在毫秒量级
    // 要压成一条 SQL 得用 CASE WHEN 拼裸 SQL，可读性换来的那点性能
    // 在这个规模上不划算。等真有几千个 SKU 要批量改，再考虑
    for (const update of updates) {
      await tx.sku.update({
        where: { id: update.id },
        data: { price: update.price },
      })
    }

    // 「几个规格的价格变了」比「改了几个规格」更接近管理员的心里预期：
    // 统一设为 899 时，本来就是 899 的那些其实没变
    const changed = updates.filter((u) => u.before !== u.price).length

    return {
      affected: changed,
      message:
        mode === "percent"
          ? `已调整 ${updates.length} 个规格的价格（±${value}%），其中 ${changed} 个发生变化`
          : `已把 ${updates.length} 个规格的价格统一设为 ¥${(value / 100).toFixed(2)}`,
    }
  })
}

// ---------------------------------------------------------------------------
// 批量调库存
// ---------------------------------------------------------------------------

/**
 * 批量调整库存。对所选商品下的**每一个 SKU** 各加/减同样的数量。
 *
 * 【为什么是「增减」而不是「设为」】
 * 和单个 SKU 的 adjustSkuStock 是同一条理由，而且批量把它放得更大：
 * 先读后写的话，你在 48 个规格上同时制造了 48 个竞态窗口。
 * 详见 src/lib/products.ts 里那段长注释。
 *
 * @param delta 正数入库，负数出库。0 由 schema 拦下（没有意义）
 */
export async function bulkAdjustProductStock(
  ids: string[],
  delta: number,
): Promise<BulkOperationResult> {
  return runInTransaction(async (tx) => {
    // 兜底。正常路径上 schema 已经拦过了，但 lib 不该假设
    // 「调用方一定校验过」—— 这也是能被集成测试直接调用的前提
    if (!Number.isInteger(delta) || delta === 0) {
      throw new BulkAbort("调整数量必须是非 0 整数")
    }
    if (Math.abs(delta) > MAX_STOCK_DELTA) {
      throw new BulkAbort(`单次调整不能超过 ${MAX_STOCK_DELTA} 件`)
    }

    const skus = await loadSkusOfProducts(tx, ids)
    if (skus.length === 0) {
      throw new BulkAbort("勾选的商品都还没有规格，没有库存可以调")
    }

    // 【出库为什么要先预检一遍「够不够」，明明下面的 UPDATE 已经带了保护】
    // 预检不是为了正确性 —— 正确性靠下面的条件更新。
    // 预检是为了**错误信息**：条件更新只会告诉你「有一行没更新成功」，
    // 说不清是哪一行、差多少。预检能说出
    // 「XX 款的 黑色 42 码只有 3 件，不够出库 10 件」，
    // 管理员看一眼就知道该改成多少。
    //
    // 那预检查完、到真正 UPDATE 之间不是有窗口吗？有。
    // 那一小段由 WHERE stock >= ? 兜住 —— 两道防线各管各的：
    // 预检管「话说得清楚」，条件更新管「数据不出错」
    if (delta < 0) {
      const need = -delta
      const short = skus.find((sku) => sku.stock < need)
      if (short) {
        throw new BulkAbort(
          `${skuLabel(short)} 只有 ${short.stock} 件，不够出库 ${need} 件。整批操作已取消`,
        )
      }
    }

    for (const sku of skus) {
      // 【绝对不能写成 data: { stock: sku.stock + delta }】
      // 那就是「先读后写」：读到的 sku.stock 是**刚才 loadSkusOfProducts
      // 那一刻**的值，如果这中间有买家下单扣了库存，我们这一次写
      // 会把那个扣减整个覆盖掉 —— 超卖。
      //
      // 用 increment / decrement 是把「加多少」交给数据库，
      // 它拿着**当前**的值去算，中间隔着多久都不影响结果。
      //
      // 出库时把「够不够扣」一起塞进 WHERE，判断和扣减在同一条 SQL 里完成，
      // 中间没有可以被插队的缝隙
      const result = await tx.sku.updateMany({
        where: {
          id: sku.id,
          ...(delta < 0 ? { stock: { gte: -delta } } : {}),
        },
        data: {
          stock: delta > 0 ? { increment: delta } : { decrement: -delta },
        },
      })

      if (result.count === 0) {
        // 预检通过之后还是撞上了 —— 说明就在那一瞬间货被买走了。
        // 抛异常，整批回滚（包括前面已经加过库存的那些规格）
        throw new BulkAbort(
          `${skuLabel(sku)} 的库存在操作期间被买走了，库存不足。请刷新后重试`,
        )
      }
    }

    return {
      affected: skus.length,
      message:
        delta > 0
          ? `已给 ${skus.length} 个规格各入库 ${delta} 件`
          : `已给 ${skus.length} 个规格各出库 ${-delta} 件`,
    }
  })
}
