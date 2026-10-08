// 这里要的是**值**导入而不是 `import type`：下面判断唯一约束冲突时
// 要用 `error instanceof Prisma.PrismaClientKnownRequestError`，
// 而 instanceof 的右边必须是一个运行时的类。类型用法（Prisma.xxx）不受影响
import { Prisma } from "@/generated/prisma/client"
import {
  canTransition,
  isNoteEditable,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_VALUES,
  ORDER_TIMEOUT_MINUTES,
  shouldRestoreCoupon,
  shouldRestoreStock,
  type OrderStatus,
} from "@/lib/constants"
import { resolveCouponDiscount, type CouponRule } from "@/lib/coupons"
import {
  COUPON_RULE_SELECT,
  getOwnedCoupon,
  toCouponRule,
} from "@/lib/coupons-db"
import { todayRange } from "@/lib/dates"
import { parseImages } from "@/lib/format"
import { prisma } from "@/lib/prisma"

// ============================================================================
// 下单：事务扣库存
//
// 这是整个项目最核心的一段代码，也是「防超卖」唯一需要看懂的地方。
//
// ---------------------------------------------------------------------------
// 【一、为什么不能「先查再改」】
//
// 最容易写出来的版本是这样的：
//
//     const sku = await prisma.sku.findUnique({ where: { id } })
//     if (sku.stock < qty) throw new Error("库存不足")
//     await prisma.sku.update({ where: { id }, data: { stock: sku.stock - qty } })
//
// 单线程跑没问题，并发下必炸。库存只剩 1 件，两个请求同时来：
//
//     时刻  A 请求                    B 请求                 数据库 stock
//     t1    读到 stock = 1                                   1
//     t2                            读到 stock = 1           1
//     t3    1 >= 1，通过                                      1
//     t4                            1 >= 1，通过             1
//     t5    写入 stock = 1 - 1 = 0                            0
//     t6                            写入 stock = 1 - 1 = 0   0   ← 卖出 2 件，库存却只减了 1
//
// 这叫「丢失更新」——两个请求都基于同一个旧快照做判断，后面的覆盖了前面的。
// 卖出去 2 件，库存只扣了 1 件，这就是超卖。
//
// ---------------------------------------------------------------------------
// 【二、正确做法：把「判断」和「扣减」压成一条 SQL】
//
//     UPDATE skus SET stock = stock - ? WHERE id = ? AND stock >= ?
//
// WHERE 里的 stock >= ? 是数据库在执行这条语句的瞬间拿到的值，
// 而且整条语句是原子的（SQLite 同一时刻只有一个写入者）。
// 所以并发来时它们会被串行执行：
//
//     A: stock=1，1>=1 成立 → 扣完 stock=0，影响 1 行
//     B: stock=0，0>=1 不成立 → 影响 0 行
//
// 我们靠「影响了几行」反推成功与否：
//     count === 0  →  这条 SKU 没扣成，说明库存不够（或者商品被删了）
//
// Prisma 里对应的是 updateMany：
//     where: { id, stock: { gte: qty } }   →  WHERE id = ? AND stock >= ?
//     data:  { stock: { decrement: qty } } →  SET stock = stock - ?
// 返回值 { count } 就是受影响行数。
//
// 注意这里**不能**用 update：update 的 where 只接受唯一字段，写不了 stock >= ?。
//
// ---------------------------------------------------------------------------
// 【三、事务解决的是另一个问题】
//
// 上面那条 SQL 保证了「一件商品」不会被超卖。
// 但一个订单可能有多件商品，需要它们**要么全扣、要么全不扣**：
//
//     订单里有 A、B 两件，A 扣成功了，B 发现库存不够 →
//     如果不回滚，A 的库存就白白被扣掉了，用户没下单成功却少了一件货。
//
// 这就是 $transaction 的作用：回调里任何一步抛错，整段里的所有写操作
// 全部撤销，数据库回到事务开始前的样子。
// ============================================================================

/** 库存不足。用独立的类是为了能被 instanceof 精确识别，不跟别的错误混淆 */
export class InsufficientStockError extends Error {
  /** 具体是哪个 SKU 不够 —— 前端拿到它可以定位到购物车/结算页对应那一行 */
  skuId: string

  constructor(skuId: string, message: string) {
    super(message)
    this.name = "InsufficientStockError"
    this.skuId = skuId
  }
}

/**
 * 这张券用不了（过期、停用、被别人抢完了、或者不是你的）。
 *
 * 【为什么要单独一个错误类】
 * 和 InsufficientStockError 一样：调用方（Server Action）需要把它
 * 翻译成「给用户看的一句话」而不是一个 500 页面。用 message 判断
 * 字符串太脆（改个措辞就失效），用 instanceof 是编译期就能查的。
 */
export class CouponUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CouponUnavailableError"
  }
}

export type CreateOrderInput = {
  address: string
  phone: string
  /**
   * 选填的买家备注。归一化（trim、空串变 null）在 orderNoteSchema 里做，
   * 到了这一层要么是一句非空的话，要么是 null。
   *
   * 【为什么标成可选】它本来就是选填的 —— 要求调用方显式写
   * `note: null` 只是徒增噪音，而少写一个字段和写 null 在语义上
   * 完全一样。真正需要「必须给个明确值」的是地址和手机号
   */
  note?: string | null
  /**
   * 选填：要用哪张券。传的是 **UserCoupon 的 id**，不是 Coupon 的 id。
   *
   * 【为什么传「我的券」的 id 而不是「券」的 id】
   * 券是模板，人手一份的实例才是可用的东西。传 Coupon.id 的话，
   * 服务端还得自己去猜「这个人领没领过这张券、领的哪一张」——
   * 而传 UserCoupon.id，配上下面的 `where: { id, userId }`，
   * 「这张券是不是你的」就成了查询条件的一部分，压根不需要业务判断。
   *
   * 【注意这只是「意向」】
   * 客户端说「我想用这张」，服务端仍然要自己查库、自己算折扣。
   * 浏览器里的金额永远是预览，不是依据
   */
  userCouponId?: string | null
  /**
   * 选填：本次结算的幂等键，由客户端在**进入结算页时**生成一次并保持不变。
   *
   * 【它是干什么的】用户双击提交、网络超时后重试、两个请求同时在途 ——
   * 这些都会让同一个「结算意图」到达服务端两次。带上同一个键，
   * 第二次到达时就只是把第一次那一单还回去，不会再扣一次库存、建第二笔订单。
   *
   * 【为什么可选】不传就是「不做幂等」，行为和加这个字段之前完全一样。
   * 内部调用（脚本、测试造数）不需要它。
   */
  idempotencyKey?: string | null
}

/**
 * 判断错误是不是「唯一约束冲突」（P2002）。
 *
 * 和 favorites-db.ts、coupons-db.ts 里是同一个写法：先 instanceof
 * 再比 code。用 instanceof 而不是只看 `error.code === "P2002"`，
 * 是为了不把「别的库里恰好也有个 code 字段」当成数据库错误。
 *
 * 【注意它只说「有唯一约束被撞了」，没说撞的是哪一个】
 * orders 表上 orderNo 和 (userId, idempotencyKey) 各有一条唯一约束，
 * 撞了都长这样。要区分得看约束名，而 Prisma 7 的 P2002 的 meta 里
 * 只有 { driverAdapterError, table } —— 约束名埋在驱动错误的深层结构
 * 里，去挖它等于把 Prisma 的内部实现焊进业务代码，换个版本就碎。
 * 所以这个函数只负责「是不是唯一冲突」，具体是哪一个由调用方
 * 查一次库来判断（见下面的 catch）。查询本身就是判据
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  )
}

export type CreateOrderResult =
  | { ok: true; orderId: string; orderNo: string }
  | { ok: false; error: string; insufficientSkuId?: string }

/**
 * 生成订单号：SO + 年月日时分秒 + 6 位随机数，例如 SO20261001143025654321。
 *
 * 【为什么不用自增 id 当订单号】
 * 自增 id 会暴露「你是第几个下单的」这种商业信息，也容易被遍历。
 * 订单号是给用户看的，用时间戳 + 随机数即可。
 *
 * 【碰撞怎么办】
 * orderNo 上有 @unique，真撞了数据库会抛 P2002，用户会看到下单失败。
 * 6 位随机数在「同一秒内」的空间是 100 万，学习项目足够。
 * 严肃场景应该用雪花算法或专门的发号服务。
 */
function generateOrderNo(at: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, "0")
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  const random = p(Math.floor(Math.random() * 1_000_000), 6)
  return `SO${stamp}${random}`
}

/**
 * 从购物车创建订单。
 *
 * 参数只有 userId 和收货信息 —— 商品、数量、价格、总价**全部**从数据库读。
 * 绝不能让客户端传价格上来：那样用户把 899 改成 1 分钱，我们就亏 898.99。
 * 这是「服务端永远不信任客户端」的又一处体现。
 */
export async function createOrderFromCart(
  userId: string,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  // ---- 0. 幂等早查：这个键已经下过单，就把那一单原样还回去 ----
  //
  // 【为什么这一步必须排在「读购物车」前面】
  // 重复提交时购物车很可能已经被第一次提交清空了。先读购物车的话，
  // 第二次请求会撞上下面的「购物车是空的」，用户看到一句误导的话 ——
  // 而他其实早就下单成功了。顺序在这里是有意义的，不是随手放的。
  //
  // 空字符串/纯空白一律归成 null：HTML 表单里的隐藏字段没渲染出来时
  // 就是空串，那等于「没带键」，不能被当成一个有效的幂等键
  const idempotencyKey = input.idempotencyKey?.trim() || null
  if (idempotencyKey) {
    const existing = await prisma.order.findUnique({
      // userId_idempotencyKey 是 schema 里 @@unique([userId, idempotencyKey])
      // 自动生成的复合键名。带上 userId 一起查，键的作用域就锁死在本人
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: { id: true, orderNo: true },
    })

    if (existing) {
      return { ok: true, orderId: existing.id, orderNo: existing.orderNo }
    }
  }

  // ---- 1. 读购物车（放在事务外面）----
  // 为了写注释清楚，这一步先读出来。真正需要原子性的只有下面的扣减，
  // 而且购物车内容读完之后就算被并发改动了，也不会影响扣减的正确性 ——
  // 因为扣减的守门人是那条 SQL，不是这份快照。
  const cartItems = await prisma.cartItem.findMany({
    where: { userId },
    include: {
      sku: {
        select: {
          id: true,
          size: true,
          color: true,
          price: true,
          skuCode: true,
          product: { select: { name: true } },
        },
      },
    },
  })

  if (cartItems.length === 0) {
    return { ok: false, error: "购物车是空的" }
  }

  // ---- 2. 金额在服务端算，用数据库里的价格 ----
  // 单位是「分」，全是整数运算，不会出现 0.1 + 0.2 !== 0.3 那种浮点误差。
  const itemsTotal = cartItems.reduce(
    (sum, item) => sum + item.sku.price * item.quantity,
    0,
  )

  const now = new Date()

  // ---- 2b. 优惠券：查出来、校验、算折扣 ----
  // 【这一段为什么放在事务外面】
  // 它全是**读**。真正需要原子性的是下面「占券槽位」那一步 ——
  // 这里是「先看看能不能用」，让用户在扣库存之前就得到一句明确的
  // 「这张券已过期」，而不是在事务里抛错回滚。
  // 当然，读到算完之间券可能刚好被别人抢完，所以事务里还要再判一次，
  // 那一次才是说了算的
  let userCoupon: { userCouponId: string; coupon: CouponRule } | null = null
  let discountAmount = 0

  if (input.userCouponId) {
    // where 里带 userId：查不到就是「不是你的券」，不需要业务判断
    userCoupon = await getOwnedCoupon(userId, input.userCouponId)
    if (!userCoupon) {
      return { ok: false, error: "这张券不存在或不属于你" }
    }

    // 【用同一个纯函数算折扣】结算页预览用的就是它（见 src/lib/coupons-db.ts）。
    // 页面算一遍、这里再算一遍，两遍必须是同一个结果 —— 所以共用一份代码
    const resolution = resolveCouponDiscount(userCoupon.coupon, itemsTotal, now)
    if (!resolution.ok) {
      return { ok: false, error: `这张券用不了：${resolution.reason}` }
    }
    discountAmount = resolution.discountCents
  }

  // 实付 = 商品原价合计 - 优惠。discountAmount 已经被夹在 [0, itemsTotal] 里，
  // 所以这个数不可能为负
  const totalAmount = itemsTotal - discountAmount

  // 支付倒计时。存成字段而不是「查询时用 createdAt 现算」，
  // 是因为第 8 步的定时扫描要按 (status, expiresAt) 建索引去查，
  // 现算的话每一行都要做一次日期加法，索引也用不上。
  const expiresAt = new Date(now.getTime() + ORDER_TIMEOUT_MINUTES * 60 * 1000)
  const orderNo = generateOrderNo(now)

  try {
    const orderId = await prisma.$transaction(async (tx) => {
      // ---- 3a. 逐件扣库存。这是整个下单流程唯一需要原子性的地方 ----
      for (const item of cartItems) {
        const result = await tx.sku.updateMany({
          // 关键：stock: { gte: quantity } 会编译进 WHERE，
          // 让「够不够」和「减多少」在同一条语句里完成
          where: { id: item.skuId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        })

        // count === 0 说明 WHERE 没匹配上：库存不够，或商品已被删除
        if (result.count === 0) {
          // 商品名本身已经带书名号，别再套一层引号。
          // 把 skuId 一起带上 —— 前端不只显示这句话，还要定位到对应那一行
          throw new InsufficientStockError(
            item.skuId,
            `${item.sku.product.name} ${item.sku.color} / ${item.sku.size}码 ` +
              `库存不足，你选了 ${item.quantity} 件`,
          )
        }
        // 这里抛出去后，本次事务里前面已经扣掉的库存会全部撤销
      }

      // ---- 3a-2. 占住这张券的一个名额 ----
      //
      // 【为什么必须用原生 SQL，不能写成 updateMany】
      // 要表达的条件是 usedCount < totalLimit —— **同一行的两个列比大小**。
      // Prisma 的 updateMany.where 里 `totalLimit` 只会被当成字面量，
      // 写 `usedCount: { lt: coupon.totalLimit }` 等于把「查出来的旧值」
      // 焊死在 SQL 里，那正是我们要避免的「先查后写」。
      // 所以退回原生 SQL，和扣库存是同一个思路：
      //
      //     UPDATE coupons SET usedCount = usedCount + 1
      //      WHERE id = ? AND usedCount < totalLimit
      //
      // 影响 0 行 = 没抢到名额（被别人抢完了，或这张券刚被删）。
      //
      // 【并发下为什么这条安全 —— 别再用 SQLite 时代的理由】
      // 这里原来写的是「并发下 SQLite 会把这两条语句串行执行」。那是 SQLite
      // 的机制（全局写锁），换到 PostgreSQL 之后已经不成立了。
      // PostgreSQL 保证它靠的是另一件事：UPDATE 拿到目标行的锁之后，会拿
      // **最新提交的版本重算一遍 WHERE**（EvalPlanQual），算不过就不改。
      // 所以并发的第 N 个请求即便在应用层读到的是旧值也没关系 —— 真正决定
      // 成败的是重算那一刻的值，超了就是影响 0 行。
      //
      // 【这就是「条件更新」和「INSERT ... SELECT」的分界线】
      // 条件更新会重算 WHERE，所以能替代应用层加锁；INSERT ... SELECT 不会，
      // 所以它并不安全 —— 领券那处踩的就是这个坑，见 coupons-db.ts 里的
      // pg_advisory_xact_lock。
      //
      // 【注意表名写的是 coupons 而不是 Coupon】
      // $executeRaw 绕过 Prisma 的模型层，直接面对物理表，
      // @@map("coupons") 那层映射在这里是不存在的。
      //
      // 【列名为什么都带双引号 —— PostgreSQL 迁移时踩出来的】
      // PostgreSQL 会把不加引号的标识符一律折叠成小写，而建表时
      // 列名是带引号的 "usedCount" / "totalLimit"（大小写敏感）。
      // 裸写就是「字段 "usedcount" 不存在」（SQLSTATE 42703）。
      // 表名 coupons 本身是小写，加引号只是为了保持一致的写法。
      if (userCoupon) {
        const taken = await tx.$executeRaw`
          UPDATE "coupons" SET "usedCount" = "usedCount" + 1
          WHERE "id" = ${userCoupon.coupon.id} AND "usedCount" < "totalLimit"
        `

        if (taken === 0) {
          throw new CouponUnavailableError("这张券已经被抢完了，换一张试试")
        }
      }

      // ---- 3b. 建订单 + 订单项 ----
      const order = await tx.order.create({
        data: {
          orderNo,
          userId,
          // 幂等键落到订单上，成为「这次结算已经发生过」的唯一凭证。
          // 没带键就是 NULL —— PostgreSQL 的唯一索引把多个 NULL 视为
          // 互不相等，所以不带键的订单彼此不冲突
          idempotencyKey,
          // 新订单一律是「待支付」。状态机见 src/lib/constants.ts
          status: ORDER_STATUS.PENDING_PAYMENT,
          totalAmount,
          // 券的痕迹：用了哪张、减了多少。没用券时是 NULL / 0
          couponId: userCoupon?.coupon.id ?? null,
          discountAmount,
          address: input.address,
          phone: input.phone,
          // 显式 ?? null 而不是直接写 input.note：字段缺失时是 undefined，
          // 让「没写备注」在库里只有一个表示（NULL），而不是 undefined/NULL 两说
          note: input.note ?? null,
          expiresAt,
          items: {
            // 【订单快照】把商品信息复制一份存进订单项，而不是只存 skuId。
            // 因为几个月后商家可能改价格、改名字、下架这个 SKU，
            // 但用户订单里必须永远显示「当时买的是什么、多少钱」。
            // skuId 仍然保留（可空），只用于关联查询，不承担展示职责。
            create: cartItems.map((item) => ({
              skuId: item.skuId,
              productName: item.sku.product.name,
              size: item.sku.size,
              color: item.sku.color,
              price: item.sku.price,
              quantity: item.quantity,
              skuCode: item.sku.skuCode,
            })),
          },
        },
        select: { id: true },
      })

      // ---- 3b-2. 把「我的这张券」标记成已核销 ----
      //
      // 【为什么是一次条件更新，而不是 update】
      // 条件是 usedAt: null —— 只有「还没用过」才改成已用。
      // 影响 0 行说明这张券已经被别的订单核销了（同一个券 id 被提交了两次，
      // 或者用户在两个标签页里同时下单）。这时候必须整单回滚：
      // 上面那个名额已经占掉了，不退回去的话券的名额就白扣一张。
      //
      // 用 orderId 而不是 usedAt 之外再存一份关系，是因为
      // UserCoupon.orderId 上有 @unique —— 「一张券只能被一个订单核销」
      // 在数据库层面也是成立的，万一将来有别的入口忘了判断，
      // 数据库会当场拒绝而不是静默地重复用券。
      if (userCoupon) {
        const consumed = await tx.userCoupon.updateMany({
          where: { id: userCoupon.userCouponId, userId, usedAt: null },
          data: { usedAt: now, orderId: order.id },
        })

        if (consumed.count === 0) {
          throw new CouponUnavailableError("这张券已经用过了，换一张试试")
        }
      }

      // ---- 3c. 清空购物车，和下单同一个事务 ----
      // 如果这一步失败，前面的扣库存也要一起撤销，
      // 否则会出现「库存扣了、购物车没清、订单也没建」的脏状态
      await tx.cartItem.deleteMany({ where: { userId } })

      return order.id
    })

    return { ok: true, orderId, orderNo }
  } catch (error) {
    // 库存不足是「业务上的正常失败」，转成友好提示返回给用户，
    // 不该让它变成一个 500。事务已经在这之前回滚干净了。
    if (error instanceof InsufficientStockError) {
      return {
        ok: false,
        error: error.message,
        insufficientSkuId: error.skuId,
      }
    }

    // 券的问题同理：这是「业务上的正常失败」（券被抢完了、券用过了），
    // 不是系统故障。事务已经回滚干净 —— 库存扣了又还、券的名额占了又退
    if (error instanceof CouponUnavailableError) {
      return { ok: false, error: error.message }
    }

    // ---- 幂等键撞了唯一约束：并发下的兜底 ----
    //
    // 走到这里说明上面那次早查没查到 —— 另一个请求几乎同时在途，
    // 两边都以为自己是第一次。数据库的唯一索引只放行了一个，
    // 输的那个在建单那一步被拒（P2002），整个事务已经回滚干净：
    // 扣掉的库存退回去了、占掉的券名额也退回去了。
    //
    // 所以这里只要把赢家那一单查出来还回去就行。对用户来说，
    // 「点了几次，看到的永远是同一笔订单」——这正是幂等要的结果。
    //
    // 【为什么能查到】唯一索引拒绝了这次插入，说明冲突的那一行已经
    // 提交成功（还没提交的话这次插入会先被阻塞，而不是直接报错）。
    //
    // 【这一步查库同时兼任「区分撞的是哪条约束」】
    // orderNo 撞了也是 P2002，但那是真失败，不该去捞别人的订单。
    // 判断办法不是去看错误里的约束名，而是直接按 (userId, idempotencyKey)
    // 查一次：查得到 = 刚才是它挡的，把这一单还回去；查不到 = 撞的是
    // 订单号，落到函数末尾原样抛出去。查询结果自己就是判据，
    // 不依赖任何 Prisma 的内部结构
    if (idempotencyKey && isUniqueConstraintError(error)) {
      const winner = await prisma.order.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        select: { id: true, orderNo: true },
      })

      // 查不到只会出现在「赢家又被删了」这种极端情况，
      // 那就当作普通失败抛出去，不要硬编一个订单号
      if (winner) {
        return { ok: true, orderId: winner.id, orderNo: winner.orderNo }
      }
    }

    // 其他错误（数据库连不上、订单号撞了……）是我们没预料到的，
    // 原样抛出去，交给 app/error.tsx 兜底并留下堆栈
    throw error
  }
}

// ============================================================================
// 模拟支付
//
// 【和扣库存是同一个套路：把「判断」塞进 WHERE】
//
// 支付这里最怕的是「重复支付」：用户手抖点两下、或者网络重试，
// 同一个订单被扣两次钱。最容易写出来的版本又是「先查再改」：
//
//     const order = await prisma.order.findUnique({ where: { id } })
//     if (order.status !== "PENDING_PAYMENT") return "已经付过了"
//     await prisma.order.update({ where: { id }, data: { status: "PAID" } })
//
// 两个请求同时进来，都在第一行读到 PENDING_PAYMENT，都通过检查，
// 于是都去写 PAID、都记了一次支付时间 —— 在某些接真实支付的场景里，
// 这意味着真的调了两次支付网关。
//
// 正确做法和扣库存一模一样：把状态判断写进 WHERE，靠受影响行数反推成败。
//
//     UPDATE orders SET status='PAID', paidAt=?
//     WHERE id=? AND userId=? AND status='PENDING_PAYMENT' AND expiresAt > ?
//
// 并发时只有第一个能匹配上（count=1），其余的 count=0 直接被拒。
// ============================================================================

/**
 * 「把订单推成已支付」那条 UPDATE 的**唯一出处**。
 *
 * 【为什么必须抽出来，而不是两个入口各写一遍】
 * 有两个入口会把订单推成已支付：
 *   - payOrder               用户点「去支付」
 *   - markOrderPaidFromStripe 支付网关的 webhook
 * 它们的 WHERE 只差一处（要不要卡支付时限），但「把判断塞进 WHERE、
 * 靠影响行数反推成败」这条核心逻辑必须**一模一样**。
 * 抄两遍的话，哪天有人给其中一处补了个条件、忘了另一处，两边的并发语义
 * 就分叉了 —— 而且分叉得毫无提示，只有在并发压测里才看得出来。
 *
 * 【为什么用两个显式布尔开关，而不是把 userId / expiresAt 做成可选参数】
 * 照的是下面 makeTransition 的写法（发货 / 确认收货那一段）。
 * 「WHERE 里少写一个 userId，就能改别人的订单」这种事，靠**省略参数**
 * 来表达太危险 —— 读代码的人看不出这里是有意省略还是漏了。
 * 所以安全的写法必须被显式写出来，再配一条运行时断言兜底。
 *
 * @returns 抢占成功（真的把这一行从「待支付」改走了）返回 true
 */
async function claimOrderPaid(
  client: TxClient,
  options: {
    orderId: string
    /** 要写入的支付时间。抽成参数是为了让两个入口各自用「它那一瞬间」的时间 */
    paidAt: Date
    /** 是否把订单限定在某个用户名下。用户点的支付必须传 true */
    scopeToUser: boolean
    userId?: string
    /**
     * 要不要卡支付时限。
     *   true  —— 用户点的支付：过了时限就不该再让他付
     *            （expiresAt > now 进 WHERE）
     *   false —— 支付网关的回调：**钱已经收了**，时限不再是拒绝的理由。
     *            这时候唯一该看的条件是 status 还没被 cron 改走
     */
    requireNotExpired: boolean
  },
): Promise<boolean> {
  if (options.scopeToUser && !options.userId) {
    throw new Error("claimOrderPaid: scopeToUser 为真时必须给 userId")
  }

  const result = await client.order.updateMany({
    where: {
      id: options.orderId,
      // userId 进 WHERE 而不是查出来再 if：越权在数据层就被挡死
      ...(options.scopeToUser ? { userId: options.userId } : {}),
      status: ORDER_STATUS.PENDING_PAYMENT,
      // 和 paidAt 用同一个时刻：这条判断必须在「改的瞬间」成立
      ...(options.requireNotExpired ? { expiresAt: { gt: options.paidAt } } : {}),
    },
    data: {
      status: ORDER_STATUS.PAID,
      paidAt: options.paidAt,
    },
  })

  return result.count === 1
}

export type PayOrderResult = { ok: true } | { ok: false; error: string }

/**
 * 模拟支付：把订单从「待支付」推到「已支付」，并记录支付时间。
 *
 * 【为什么叫「模拟」】
 * 没有接任何真实支付网关。真实流程应该是：
 *   下单 → 调支付平台拿支付链接/token → 用户在他们页面付款 →
 *   支付平台回调我们的 webhook → **在回调里**改状态
 * 关键区别：真实场景下**绝不能**由前端点一下就改状态，
 * 必须等支付平台的异步回调（而且要验签、要防重放）。
 * 这里为了学习订单状态机，用一次按钮点击代替整个回调链路。
 */
export async function payOrder(
  orderId: string,
  userId: string,
): Promise<PayOrderResult> {
  const now = new Date()

  // 一次条件更新搞定三件事（条件本身写在 claimOrderPaid 里，两个入口共用）：
  //   1. 订单必须是这个人的          → scopeToUser + userId
  //   2. 必须是待支付状态            → status（防止重复支付）
  //   3. 必须还没过支付时限          → requireNotExpired（第 8 步的自动取消
  //      是兜底，但用户不该在两个 cron 之间钻空子付一笔已经超时的订单）
  const claimed = await claimOrderPaid(prisma, {
    orderId,
    paidAt: now,
    scopeToUser: true,
    userId,
    // 用户点的支付要卡时限。网关回调不卡 —— 那一边钱已经收了，
    // 理由见 markOrderPaidFromStripe
    requireNotExpired: true,
  })

  if (claimed) return { ok: true }

  // ---- 没改成，回去查清楚到底是哪一条不满足，给用户一个能看懂的提示 ----
  // 这一步只是「事后解释」，不承担并发安全 —— 安全已经由上面那条 SQL 保证了
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { status: true, expiresAt: true },
  })

  // 查不到 = 订单不存在，或者不是这个人的。
  // 两种都返回同一句话，不泄露「这个订单号是否存在」
  if (!order) return { ok: false, error: "订单不存在" }

  const status = order.status as OrderStatus

  if (status === ORDER_STATUS.PAID) {
    return { ok: false, error: "这笔订单已经支付过了" }
  }
  if (status === ORDER_STATUS.CANCELLED) {
    return { ok: false, error: "订单已取消，无法支付" }
  }
  if (order.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, error: "订单已超过支付时限，请重新下单" }
  }
  // 用状态机给出兜底提示，而不是硬编码一句话
  if (!canTransition(status, ORDER_STATUS.PAID)) {
    return { ok: false, error: `订单当前是「${ORDER_STATUS_LABEL[status]}」，无法支付` }
  }

  return { ok: false, error: "支付失败，请稍后重试" }
}

// ============================================================================
// 支付网关回调：把订单推成已支付
//
// 【它和上面 payOrder 唯一的差别，就是「不卡支付时限」】
//
// payOrder 的 WHERE 里有 expiresAt > now，理由是「用户不该在两个 cron
// 之间钻空子，付一笔已经超时的订单」—— 那时候拒绝是**安全**的，
// 因为钱还没扣，用户看到一句「已超时，请重新下单」就走了。
//
// 回调这边的前提整个反了：**钱已经在 Stripe 那边收了**。
// 此时「超过时限」不再是拒绝的理由 —— 拒收一笔已经到账的钱，
// 换来的是「钱收了、订单却永远停在待支付」。
//
// 所以回调只认一个条件：status 还是不是 PENDING_PAYMENT。
//   - 是   → 收下，推成已支付。哪怕此刻已经过了 expiresAt 也没关系，
//            只要 cron 还没把这单扫走，库存就还锁着，收下不亏
//   - 不是 → 说明 cron 先动手了（或者这单早就付过），交给调用方分辨
//
// 【为什么不让 payOrder 收一个 ignoreExpiry: boolean】
// 见 claimOrderPaid 的注释：危险的能力不该藏在可选参数里。
// 写成两个各自命名的函数，光看函数名就知道走的是哪条路。
// ============================================================================

/**
 * 这次回调的结局。调用方（webhook handler）靠它决定 `appliedAt` 写不写。
 */
export type StripePaidOutcome =
  /** 订单确实是「待支付」，这次被推成了「已支付」—— 正常路径 */
  | "applied"
  /**
   * 订单已经在收款之后的状态了（已支付 / 已发货 / 已完成 / 退款中 / 已退款）。
   *
   * 这几个状态都意味着「这笔钱已经记过一次」，所以不需要做任何事，
   * 也不需要人来处理 —— 它和 applied 一样是「自洽」的结局
   */
  | "already_paid"
  /**
   * 订单已经被超时取消，钱却收了。
   *
   * 【这是最需要人看到的一种结局】
   * 库存已经被 cron 还回池子、可能已经被别人买走，券也退给用户了，
   * 而钱在 Stripe 那边是真的扣了。这一轮的处理是「拒收 + 留痕」：
   * 不改订单状态，由 webhook handler 记一行 appliedAt 为空的事件
   * 等人处理（那个空值就是告警口径，见 prisma/schema.prisma 的
   * WebhookEvent.appliedAt）。
   *
   * 【为什么不去恢复订单（CANCELLED → PAID）】
   * 恢复要重新扣一次库存，而库存可能已经卖给下一个人了 —— 那就是超卖。
   * 扣不到又只能退回「留痕等人处理」，等于多写一段永远走不通的代码。
   * 加上 CANCELLED 本来就是状态机里的终态（见 constants.ts），
   * 为一条罕见路径破掉它不划算
   */
  | "cancelled"
  /** metadata 指的订单不存在。同样是「钱收了但没落到订单上」，同样要留痕 */
  | "not_found"

/**
 * 支付网关确认收款后，把订单推成「已支付」。
 *
 * 【为什么必须由调用方传 tx，而不是自己开事务】
 * 调用方要在这**同一笔事务**里再插一行 webhook_events（见
 * src/lib/stripe-webhook.ts）。两件事必须一起提交或一起回滚：
 * 如果只记了「事件已处理」却没改成订单，那这个事件以后重投时会被幂等
 * 直接跳过，订单就永远停在待支付 —— 这是最坏的结局（静默丢单）。
 * 所以事务边界归调用方，这个函数只负责其中一步。
 *
 * 【为什么不收 userId】
 * 回调不是「某个用户在支付」，它没法也不该说明是谁付的。订单是靠
 * metadata.orderId 定位的。这也是它不能复用 PayOrderResult 那套
 * 「查一次、给用户选一句话」的原因 —— 这里根本没有用户可解释。
 */
export async function markOrderPaidFromStripe(
  tx: TxClient,
  orderId: string,
  paidAt: Date = new Date(),
): Promise<StripePaidOutcome> {
  const claimed = await claimOrderPaid(tx, {
    orderId,
    paidAt,
    // 回调不带用户：订单已经由 id 定位好了，
    // 而「谁付的」这个问题在 webhook 里没有答案（也不需要有）
    scopeToUser: false,
    // 【和 payOrder 唯一的差别在这里】钱已经收了，时限不再是理由
    requireNotExpired: false,
  })

  if (claimed) return "applied"

  // 没抢到，回查一次把「为什么没抢到」翻译成一个明确的结局。
  // 这一步不承担并发安全 —— 安全已经由上面那条 SQL 保证了
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  })

  // 订单不存在（metadata 指向了一个不存在的 id）
  if (!order) return "not_found"

  // 被 cron 取消了：钱收了、单没了，要留痕等人处理
  if (order.status === ORDER_STATUS.CANCELLED) return "cancelled"

  // 其余状态都在收款之后，说明这笔钱早就记过了
  return "already_paid"
}

// ============================================================================
// 超时未支付自动取消 —— 第 8 步
//
// 【要解决的两个问题】
//
// 1. 为什么必须取消
//    下单时库存就被扣掉了（第 6 步）。如果用户下单后一直不付钱，那些库存
//    就永远锁死在一个死订单里，别人买不到。所以超时必须有回收机制。
//
// 2. 为什么不能简单地「查出过期的 → 逐个改成 CANCELLED → 加回库存」
//    因为「改状态」和「还库存」这两步之间，可能插进来一个支付请求：
//
//      时刻  扫描器                        用户
//       t1   查出订单 X 已过期
//       t2                                 点「去支付」，订单变 PAID，钱扣了
//       t3   把 X 改成 CANCELLED
//       t4   把库存加回去
//
//    结果：用户付了钱，订单却是「已取消」，货还被还回了库存。
//    这是最严重的资损场景 —— 收了钱不给货。
//
//    注意这和扣库存的竞态长得不一样（那个是「读-改-写」丢更新），
//    但根因是同一个：**先判断后动作**，判断和动作之间有窗口。
//
//    【解法仍然是同一招】把判断塞进 UPDATE 的 WHERE：
//
//      UPDATE orders SET status='CANCELLED', cancelledAt=?
//      WHERE id=? AND status='PENDING_PAYMENT' AND expiresAt <= ?
//
//    这条语句是「抢占」：谁先把这行从 PENDING_PAYMENT 改走，谁就赢。
//    支付和取消都在抢同一个状态位，数据库保证只有一个能成功：
//
//      - 用户先支付成功 → 扫描器 count=0 → 不改状态、不还库存（正确）
//      - 扫描器先取消   → 支付 count=0  → 报「订单已取消，无法支付」（正确）
//
//    所以「还库存」必须放在抢占成功之后，绝不能放在前面。
// ============================================================================

/** 事务里能用的 Prisma 客户端（就是 $transaction 回调收到的那个 tx） */
type TxClient = Prisma.TransactionClient

/**
 * 把一张订单占用的库存还回去。
 *
 * 【这个函数不判断「该不该还」，判断权归调用方】
 * 第 7 步（退款）之前，这里是 `if (!shouldRestoreStock(statusBeforeCancel)) return 0` ——
 * 状态判断写死在函数里。加了退款之后这条规则不再成立：
 *
 *     取消订单（SHIPPED / COMPLETED）→ 不还库存（货在路上，售后问题）
 *     批准退款（SHIPPED / COMPLETED）→ **要还库存**（钱都退了，货是平台的）
 *
 * 同一个状态、两个相反的结论，说明「该不该还」根本不是状态的函数。
 * 所以闸门挪到两个调用点，各自写清楚自己的规则：
 *   - cancelOneExpiredOrder：用 shouldRestoreStock 卡住
 *   - approveRefund：无条件还（退款成立就等于这笔交易作废，货退回仓库）
 *
 * 【为什么不是传一个 shouldRestore: boolean 参数】
 * 那样函数签名上就看不出调用方的意图了，而这两个调用点的差别
 * 恰恰是这块业务里最容易搞错的地方 —— 必须让它在代码里显眼。
 */
export async function restoreStockForOrder(
  tx: TxClient,
  orderId: string,
): Promise<number> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { skuId: true, quantity: true },
  })

  let restored = 0
  for (const item of items) {
    // skuId 可空：SKU 被物理删除后置为 NULL。商品都没了，没有库存可还
    if (!item.skuId) continue

    await tx.sku.update({
      where: { id: item.skuId },
      data: { stock: { increment: item.quantity } },
    })
    restored += item.quantity
  }

  return restored
}

/**
 * 把这张订单用掉的券退回用户手里。
 *
 * 【和 restoreStockForOrder 是同一个套路，但顺序必须反着来】
 * 还库存是「加回 SKU.stock」，退券是「把 UserCoupon 恢复成未使用」+
 * 「把 Coupon.usedCount 减回去」。
 *
 * 【「该不该退」同样交给调用方判断】
 * 理由和 restoreStockForOrder 一模一样（见那里的注释）：取消订单要按
 * shouldRestoreCoupon 卡住，而批准退款时必须无条件退 —— 钱都退给用户了，
 * 那张券当然也要还回去（券是平台自己发的，不是买家买的商品）。
 *
 * 【为什么先改 UserCoupon 再减 usedCount，而且要看影响行数】
 * 因为「退回」这个动作可能被执行两次（定时任务扫一遍、用户又手动取消、
 * 或者将来加了别的取消入口）。UserCoupon 上的 orderId 是**条件**：
 * 只有这张券还挂在这一单上，才把它摘下来。摘下来了（count=1）
 * 才轮到 usedCount 减一 —— 顺序反过来的话，重复执行会平白多减几次，
 * 券的余量比实际的多，就又能多卖出去几单。
 *
 * 【退款路径复用这个函数的额外好处】
 * 上面那套「摘下来才减」的幂等保证，正好也是退款需要的：
 * 万一批准退款的事务被重放，usedCount 不会掉两次。
 *
 * 【usedCount 会不会被减成负数】
 * 不会：条件里带了 usedCount > 0。真出现负数说明数据已经不一致了，
 * 这时候宁可少减一次（让管理员看得见），也不要写出一个负数余量 ——
 * 负余量会让并发判断 `usedCount < totalLimit` 永远成立，等于无限量发券。
 */
export async function restoreCouponForOrder(
  tx: TxClient,
  orderId: string,
): Promise<boolean> {
  const used = await tx.userCoupon.findUnique({
    where: { orderId },
    select: { id: true, couponId: true },
  })

  // 这一单压根没用券
  if (!used) return false

  const released = await tx.userCoupon.updateMany({
    // orderId 一起当条件：这张券必须还挂在这一单上才退。
    // 已经退过（orderId 被置空）就再也不会命中
    where: { id: used.id, orderId },
    data: { usedAt: null, orderId: null },
  })

  if (released.count === 0) return false

  await tx.coupon.updateMany({
    where: { id: used.couponId, usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  })

  return true
}

/**
 * 尝试取消【一张】超时未支付的订单。
 *
 * @returns 抢占失败返回 null（说明已支付/已取消/还没到期）；
 *          抢占成功返回归还的库存件数（可能是 0，比如商品已被删除）
 */
async function cancelOneExpiredOrder(
  order: { id: string; status: OrderStatus },
  now: Date,
): Promise<number | null> {
  // 兜底断言：确认「当前状态 → CANCELLED」这条边在状态机里是允许的。
  // 真正的守门人是下面 SQL 的 WHERE，这里只是防止将来有人改了 SQL、
  // 却忘了回头维护 ORDER_STATUS_TRANSITIONS 那张表
  if (!canTransition(order.status, ORDER_STATUS.CANCELLED)) return null

  return prisma.$transaction(async (tx) => {
    // ---- 抢占 ----
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id,
        // 这两条是抢占的关键：改的瞬间再确认一次状态和到期时间
        status: ORDER_STATUS.PENDING_PAYMENT,
        expiresAt: { lte: now },
      },
      data: {
        status: ORDER_STATUS.CANCELLED,
        cancelledAt: now,
      },
    })

    // 没抢到 = 有人先下手了（多半是用户刚好付了钱）。什么都不做，
    // 尤其**不要**还库存，否则就是「收了钱不给货」
    if (claimed.count === 0) return null

    // ---- 抢到了才还库存 / 退券，同一个事务，要么都成要么都不成 ----
    // 两件事放在一个事务里不是为了「一起成功」，而是为了**一起失败**：
    // 如果退了券却没还库存（或者反过来），订单会是「已取消」但资源没退干净
    // 的状态 —— 那种半拉子状态没有第二次机会去修（订单已经不在
    // 「待支付」里了，扫描器再也不会扫到它）。所以宁可整条回滚，
    // 让下一次扫描重新来一遍
    //
    // 【闸门为什么写在这里，而不是函数内部】
    // 见 restoreStockForOrder 的注释：加了退款之后「什么状态该退资源」
    // 不再是一句话能说清的事（批准退款时明明要退）。
    // 取消这条路径的规则是：PENDING_PAYMENT / PAID 才退，
    // SHIPPED / COMPLETED 的取消属于售后，库存和券都留着。
    //
    // 注意传的是 order.status —— **取消前**读到的那个状态。
    // 上面已经把它改成 CANCELLED 了，但改的是数据库，
    // 这个内存里的对象还是旧的，所以要在这里判断。
    if (shouldRestoreCoupon(order.status)) {
      await restoreCouponForOrder(tx, order.id)
    }
    return shouldRestoreStock(order.status)
      ? await restoreStockForOrder(tx, order.id)
      : 0
  })
}

export type CancelExpiredResult = {
  /** 本次扫到的候选订单数 */
  scanned: number
  /** 真正被取消的订单数 */
  cancelled: number
  /** 归还的库存总件数 */
  restoredUnits: number
}

/**
 * 扫描并取消所有超时未支付的订单。
 *
 * 【两种触发方式，都指向这一个函数】
 *
 *   1. 定时任务（正路子）
 *      由 /api/cron/expire-orders 暴露出来，交给外部调度器定期调用。
 *      生产环境就是 crontab / systemd timer / 云厂商的定时任务。
 *      本项目没有引入任何调度库 —— Next.js 进程里跑 setInterval 在
 *      serverless 下会被随时杀掉，本地又在热重载时不断叠加定时器，
 *      都不是好主意。**把定时这件事交给操作系统，是更简单也更可靠的选择**。
 *
 *   2. 查询时兜底（lazy）
 *      订单列表页和详情页在渲染前顺手扫一遍。这样即使用户电脑上
 *      根本没配 cron，功能看起来也是正常的，不会出现「过期了还显示待支付」。
 *
 *      代价是每次访问都要多跑一条查询。所以这个方法支持 userId 参数 ——
 *      页面里只扫当前用户自己的订单，命中 userId 索引，量很小。
 *      全表扫描那种交给 cron 去干。
 *
 * 【为什么要 limit】
 * 万一积压了几万条过期订单，一次全扫完会把数据库锁住很久。
 * 分批发，一次处理一批，剩下的下次再说。
 */
export async function cancelExpiredOrders(options?: {
  /** 只扫这个用户的订单（页面兜底用）。不传则全表扫（cron 用） */
  userId?: string
  /** 单次最多处理多少条，默认 200 */
  limit?: number
  /** 现在时刻。抽出来是为了测试时能伪造时间，正常调用不用传 */
  now?: Date
}): Promise<CancelExpiredResult> {
  const now = options?.now ?? new Date()
  const limit = options?.limit ?? 200

  // ---- 1. 找出候选 ----
  // 走的是 @@index([status, expiresAt])，两条条件都能用上索引，
  // 不用全表扫描
  const candidates = await prisma.order.findMany({
    where: {
      status: ORDER_STATUS.PENDING_PAYMENT,
      expiresAt: { lte: now },
      ...(options?.userId ? { userId: options.userId } : {}),
    },
    orderBy: { expiresAt: "asc" }, // 先处理过期最久的
    take: limit,
    select: { id: true, status: true },
  })

  if (candidates.length === 0) {
    return { scanned: 0, cancelled: 0, restoredUnits: 0 }
  }

  // ---- 2. 逐条抢占 ----
  // 【为什么逐条开事务，而不是一个大事务套住所有订单】
  // 大事务会长时间持有写锁，把并发的下单/支付全部堵死；
  // 而且一条订单还库存失败会导致整批回滚，前面的白干。
  // 逐条处理，每条自己的事务，一条失败不影响其他条。
  let cancelled = 0
  let restoredUnits = 0

  for (const order of candidates) {
    const restored = await cancelOneExpiredOrder(
      { id: order.id, status: order.status as OrderStatus },
      now,
    )

    // null = 没抢到（用户在这几毫秒里把钱付了）。跳过，不计数
    if (restored === null) continue

    cancelled += 1
    restoredUnits += restored
  }

  return { scanned: candidates.length, cancelled, restoredUnits }
}

// ============================================================================
// 发货 / 确认收货 —— 第 9 步，状态机的最后两跳
//
//   PAID ──管理员发货──> SHIPPED ──用户确认收货──> COMPLETED
//
// 【为什么这两步不碰库存】
// 库存是在**下单那一刻**就扣掉的（第 6 步），不是发货时扣的。
// 这是「下单即锁库存」策略：用户下单后 15 分钟内的货是给他留着的，
// 别人买不走。所以发货只是把货从仓库拿出来寄出去，库存数字早就变过了。
//
// 反面做法是「付款才扣库存」，那样用户填完地址还得抢一次库存，
// 抢不到就得退款，体验和实现都更差。
// ============================================================================

export type TransitionOrderResult = { ok: true } | { ok: false; error: string }

/**
 * 生成一个「状态流转」函数。发货和确认收货的骨架完全一样：
 *
 *     UPDATE orders SET status = ?, <时间字段> = ?
 *     WHERE id = ? AND status = ?            ← 期望的当前状态
 *     [AND userId = ?]                        ← 只有用户自己的操作才需要
 *
 * 又是那个套路：把「现在是不是这个状态」写进 WHERE，靠受影响行数判断成败。
 *
 * 【这一步防的是什么】
 * 和支付不同，这里没有资损风险，防的是**重复操作和乱序操作**：
 *   - 两个管理员同时点「发货」→ 只有第一个成功，不会写两次 shippedAt
 *   - 已经发货的订单又被点一次「发货」→ 被拒，而不是把已经走远的状态倒退回去
 *   - 用户对还没发货的订单点「确认收货」→ 被拒
 *
 * 还有一个更隐蔽的：管理员在 A 页面看到订单是 PAID，去泡了杯咖啡，
 * 回来点「发货」—— 这中间用户可能已经取消了订单。WHERE 里的状态条件
 * 保证这条指令只在「现在仍是 PAID」时才生效，而不是基于他屏幕上的旧快照。
 */
function makeTransition(options: {
  /** 允许从哪个状态出发 */
  from: OrderStatus
  /** 流转到哪个状态 */
  to: OrderStatus
  /** 要写入的时间字段名 */
  timeField: "shippedAt" | "completedAt"
  /** 传了就带上 userId 条件（用户自己的操作必须传） */
  scopeToUser: boolean
  /** 操作的中文名，用于拼错误提示。如「发货」→「订单当前是「待支付」，不能发货」 */
  actionLabel: string
}) {
  return async function transition(
    orderId: string,
    userId?: string,
  ): Promise<TransitionOrderResult> {
    // 状态机白名单。写死 from/to 是常量，这里其实是编译期就确定的，
    // 但保留这行是为了让「改状态必须过状态机」成为肌肉记忆
    if (!canTransition(options.from, options.to)) {
      throw new Error(`状态机里不允许 ${options.from} → ${options.to}`)
    }

    if (options.scopeToUser && !userId) {
      throw new Error("这个操作必须指定 userId")
    }

    const result = await prisma.order.updateMany({
      where: {
        id: orderId,
        status: options.from,
        // 只有当前状态确实是 from 时才改得动 —— 这一条就是全部的安全性
        ...(options.scopeToUser ? { userId } : {}),
      },
      data: {
        status: options.to,
        [options.timeField]: new Date(),
      },
    })

    if (result.count === 1) return { ok: true }

    // 没改成，回去查清楚原因给个能看懂的提示
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        ...(options.scopeToUser ? { userId } : {}),
      },
      select: { status: true },
    })

    // 查不到 = 订单不存在，或者不是这个人的。两种情况返回同一句话
    if (!order) return { ok: false, error: "订单不存在" }

    const status = order.status as OrderStatus

    if (status === options.to) {
      return { ok: false, error: `这笔订单已经是「${ORDER_STATUS_LABEL[status]}」了` }
    }

    return {
      ok: false,
      // 不要拼成「不能已发货」——「已发货」是状态名不是动词。
      // 用操作名才能拼出人话：「订单当前是「待支付」，不能发货」
      error: `订单当前是「${ORDER_STATUS_LABEL[status]}」，不能${options.actionLabel}`,
    }
  }
}

/**
 * 管理员发货：PAID → SHIPPED。
 *
 * 【为什么不传 userName / 不记录「谁发的货」】
 * 真实系统需要一张操作日志表记下「哪个管理员在什么时候做了什么」，
 * 出问题时要能追溯。这属于审计功能，学习项目先不做，
 * 但要知道这里的缺口在哪。
 */
export const shipOrder = makeTransition({
  from: ORDER_STATUS.PAID,
  to: ORDER_STATUS.SHIPPED,
  timeField: "shippedAt",
  // 管理员的操作，不带 userId —— 订单本来就不属于他
  scopeToUser: false,
  actionLabel: "发货",
})

/**
 * 用户确认收货：SHIPPED → COMPLETED。
 *
 * 【为什么这个要带 userId】
 * 和支付一样，这是用户对自己订单的操作。带 userId 条件后，
 * 拿别人的订单 id 来调只会 count = 0，越权在数据层就被挡死。
 */
export const confirmReceipt = makeTransition({
  from: ORDER_STATUS.SHIPPED,
  to: ORDER_STATUS.COMPLETED,
  timeField: "completedAt",
  scopeToUser: true,
  actionLabel: "确认收货",
})

// ============================================================================
// 订单备注 —— 唯一一个「订单创建后还能改」的字段
//
// 【为什么不复用一个 makeTransition 那样的生成器】
// 前面那几个函数改的是 status 和对应的时间戳，骨架一模一样，所以抽得出来。
// 备注改的是 data 的内容，WHERE 条件更是完全不同（状态不是「等于某一个」
// 而是「在某个集合里」）。硬凑成一个生成器，参数会比实现还长。
//
// 【真正的看点是 WHERE】
// 「发货之后不能改」这条规则，不是靠「先查状态、再决定改不改」实现的 ——
// 那是典型的先判断后动作，判断和写入之间正好够插进来一次发货。
// 规则被直接编译进了 UPDATE 的 WHERE：状态不满足匹配不上，一个字都不会写。
// 这和扣库存、抢状态位用的是同一招。
// ============================================================================

/**
 * 「可以改备注」的状态集合 —— 从 isNoteEditable 推出来，不手写第二遍。
 *
 * 【为什么要推出来，而不是直接写 ["PENDING_PAYMENT", "PAID"]】
 * 界面上「能不能看到编辑按钮」用的是 isNoteEditable，SQL 用的是这个数组。
 * 手写两遍的话，哪天规则改了（比如允许已取消的订单补个备注），
 * 很容易只改了其中一处 —— 结果是按钮出现了、点下去必然失败，
 * 用户看到一句莫名其妙的错误却完全不知道自己做错了什么。
 */
const NOTE_EDITABLE_STATUSES = ORDER_STATUS_VALUES.filter(isNoteEditable)

export type UpdateOrderNoteResult = { ok: true } | { ok: false; error: string }

/**
 * 改订单备注（买家本人）。
 *
 * @param note 已经过 orderNoteSchema 归一化：没填就是 null，不会是空串
 */
export async function updateOrderNote(
  orderId: string,
  userId: string,
  note: string | null,
): Promise<UpdateOrderNoteResult> {
  const result = await prisma.order.updateMany({
    // userId 也在 WHERE 里：拿别人的订单 id 来调只会 count = 0
    where: { id: orderId, userId, status: { in: NOTE_EDITABLE_STATUSES } },
    data: { note },
  })

  if (result.count > 0) return { ok: true }

  // ---- 没匹配上，得分清是哪一种 ----
  // 上面那条 UPDATE 只告诉我们「不行」，不告诉我们「为什么」。
  // 再查一次只为拿到准确文案（用户看到「已发货不能改」和看到
  // 「订单不存在」是完全不同的两件事）。
  //
  // 【注意这里也带 userId】不带的话，就能拿别人的订单 id 试探出
  // 「这单是不是已经发货了」—— 一次探测本身没什么，但这类接口
  // 会被批量扫，攒起来就是别人的经营数据
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { status: true },
  })

  if (!order) return { ok: false, error: "订单不存在" }

  const label = ORDER_STATUS_LABEL[order.status as OrderStatus] ?? "当前状态"
  return { ok: false, error: `订单${label}，备注不能再改了` }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export type OrderItemView = {
  id: string
  productName: string
  size: string
  color: string
  price: number
  quantity: number
  skuCode: string | null
  /**
   * 这款商品现在的 id，顺着 skuId 关联上来的。
   *
   * 【为什么订单项不直接存一个 productId 快照】
   * 订单快照存的是「当时买的是什么、多少钱」——那些值**可能被商家改**，
   * 所以必须复制一份冻结住。而 productId 是商品的**身份**，它不会变，
   * 而且 skuId 已经指向了一个唯一的 SKU，SKU 又必然属于某一款商品，
   * 再存一份只是冗余。跳过 skuId 关联即可。
   *
   * 唯一的例外是 SKU 被物理删除（skuId 置空）—— 这时取不到 productId，
   * 返回 null，「去评价」按钮就不会出现。而实际上 deleteSku 会拒绝删除
   * 被订单引用过的规格，所以正常路径下它一定有值。
   */
  productId: string | null
  /**
   * 这条订单项已经写过的评价 id，没评过就是 null。
   * 订单页靠它决定显示「去评价」还是「已评价」。
   */
  reviewId: string | null
}

export type OrderDetail = {
  id: string
  orderNo: string
  status: OrderStatus
  statusLabel: string
  /**
   * 商品原价合计（分），也就是「没用券的话要付多少」。
   *
   * 【为什么这个数不存进数据库，而是每次由订单项现加】
   * 因为它完全由订单项快照决定：price × quantity 逐项相加。
   * 存一份就多一个会和订单项对不上的地方 —— 而它对不上时没人知道该信哪个。
   * 真正必须冻结的是**优惠了多少钱**（外部因素算出来的，事后无法复现）
   * 和**实付**（真收了多少），所以那两个是字段。原价是推导值。
   *
   * OrderItemsCard 就靠 itemsTotal / discountAmount / totalAmount 这三行
   * 画「原价 / 优惠 / 实付」
   */
  itemsTotal: number
  /** 用券减掉的钱（分）。没用券就是 0 */
  discountAmount: number
  /** 这一单用了哪张券。没用券、或者券被删了就是 null */
  coupon: CouponRule | null
  /** 实付（分）= itemsTotal - discountAmount */
  totalAmount: number
  address: string
  phone: string
  /**
   * 买家备注，没写就是 null。
   *
   * 【为什么类型是 string | null 而不是空串】
   * 归一化在下单和改备注时做（见 orderNoteSchema），到了这一层
   * 「有没有备注」就只剩一个判断：note === null。
   * 界面于是可以简单地三分：null 显示「未填写」，有值就显示原文。
   */
  note: string | null
  createdAt: Date
  expiresAt: Date
  paidAt: Date | null
  shippedAt: Date | null
  completedAt: Date | null
  cancelledAt: Date | null
  /** 退款到账时间。没退过就是 null（时间线靠它决定显不显示这一行） */
  refundedAt: Date | null
  items: OrderItemView[]
}

/** 订单项 + 订单的固定 select，两个详情查询共用，避免抄两份抄漏字段 */
const ORDER_DETAIL_SELECT = {
  id: true,
  orderNo: true,
  status: true,
  totalAmount: true,
  discountAmount: true,
  // 用了哪张券。select 用的是券那边定义的同一份字段清单，
  // 少一个字段会在 CouponRule 的类型上直接报错（见 COUPON_RULE_SELECT）
  coupon: { select: COUPON_RULE_SELECT },
  address: true,
  phone: true,
  note: true,
  createdAt: true,
  expiresAt: true,
  paidAt: true,
  shippedAt: true,
  completedAt: true,
  cancelledAt: true,
  refundedAt: true,
  items: {
    select: {
      id: true,
      productName: true,
      size: true,
      color: true,
      price: true,
      quantity: true,
      skuCode: true,
      // 商品 id 顺着 skuId 关联上来（订单项快照里没有它，理由见 OrderItemView）
      sku: { select: { productId: true } },
      // 这条订单项已经被评价过的话，带上评价 id
      review: { select: { id: true } },
    },
  },
} as const

/** 订单项那一行查询出来的原始形状（比 OrderItemView 多了两个待转换的关联） */
type OrderItemRow = {
  id: string
  productName: string
  size: string
  color: string
  price: number
  quantity: number
  skuCode: string | null
  sku: { productId: string } | null
  review: { id: string } | null
}

type OrderDetailRow = {
  id: string
  orderNo: string
  status: string
  totalAmount: number
  discountAmount: number
  /** 券的关联字段（和 COUPON_RULE_SELECT 一一对应），没用券时为 null */
  coupon: {
    id: string
    code: string
    type: string
    value: number
    minSpend: number
    maxDiscount: number | null
    startAt: Date
    endAt: Date
    isActive: boolean
  } | null
  address: string
  phone: string
  note: string | null
  createdAt: Date
  expiresAt: Date
  paidAt: Date | null
  shippedAt: Date | null
  completedAt: Date | null
  cancelledAt: Date | null
  refundedAt: Date | null
  items: OrderItemRow[]
}

/**
 * 把订单项的关联「拍平」成前端好用的两个平字段。
 *
 * 为什么不干脆把 sku / review 原样透传给页面？
 * 那样每个用到的地方都得写一遍 item.sku?.productId，而且「sku 是 null」
 * 这个分支会散落在组件里。拍平之后组件只判断 productId 有没有值。
 */
function toOrderItemView(item: OrderItemRow): OrderItemView {
  return {
    id: item.id,
    productName: item.productName,
    size: item.size,
    color: item.color,
    price: item.price,
    quantity: item.quantity,
    skuCode: item.skuCode,
    productId: item.sku?.productId ?? null,
    reviewId: item.review?.id ?? null,
  }
}

/** 把数据库行转成给页面用的形状。两个详情查询都走这里，保证字段一致 */
function toOrderDetail(order: OrderDetailRow): OrderDetail {
  const status = order.status as OrderStatus

  // 原价由订单项快照现加（见 OrderDetail.itemsTotal 的注释）
  const itemsTotal = order.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  )

  return {
    id: order.id,
    orderNo: order.orderNo,
    status,
    statusLabel: ORDER_STATUS_LABEL[status] ?? order.status,
    itemsTotal,
    discountAmount: order.discountAmount,
    coupon: order.coupon ? toCouponRule(order.coupon) : null,
    totalAmount: order.totalAmount,
    address: order.address,
    phone: order.phone,
    note: order.note,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    refundedAt: order.refundedAt,
    items: order.items.map(toOrderItemView),
  }
}

/**
 * 查订单详情（用户视角）。
 *
 * 【为什么必须带 userId 条件】
 * 如果不带，任何人都能把 URL 里的 id 换成别人的订单号看到别人的
 * 收货地址和手机号 —— 这叫 IDOR（越权访问对象引用），是电商最常见的漏洞之一。
 * 把 userId 写进 where 而不是「查出来再 if 判断」，是从根上杜绝忘记判断。
 */
export async function getOrderDetail(
  orderId: string,
  userId: string,
): Promise<OrderDetail | null> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: ORDER_DETAIL_SELECT,
  })

  return order ? toOrderDetail(order) : null
}

export type OrderDetailForAdmin = OrderDetail & {
  /** 买家信息。管理员要联系买家，所以这里必须带出来 */
  buyer: { id: string; name: string; email: string }
}

/**
 * 查订单详情（管理员视角）。
 *
 * 【和 getOrderDetail 就差一个 userId】
 * 两个函数长得很像，但**绝对不能合并成一个带可选 userId 的函数**：
 *
 *     getOrderDetail(id, userId?)   // ← 危险
 *
 * 一旦 userId 变成可选参数，就存在「某处忘了传」的可能，
 * 而忘记传的后果是**静默地**把别人的订单暴露出去 —— 没有报错，
 * 没有类型错误，只有泄露。宁可写两个函数，让「要不要越权」这件事
 * 在调用点上白纸黑字地写出来。
 *
 * 这也是「让危险的写法在语法上就不可能发生」的一个例子。
 */
export async function getOrderDetailForAdmin(
  orderId: string,
): Promise<OrderDetailForAdmin | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      ...ORDER_DETAIL_SELECT,
      user: { select: { id: true, name: true, email: true } },
    },
  })

  if (!order) return null

  return { ...toOrderDetail(order), buyer: order.user }
}

export type OrderSummary = {
  id: string
  orderNo: string
  status: OrderStatus
  statusLabel: string
  totalAmount: number
  createdAt: Date
  expiresAt: Date
  /** 订单里第一件商品的图，列表里当缩略图用 */
  coverImage: string | null
  /** 商品种类数，用来显示「等 N 件商品」 */
  itemKindCount: number
  /** 总件数（数量相加），不是种类数 */
  totalQuantity: number
}

/**
 * 查某个人的订单列表，最新的在前。
 *
 * 【两处必须注意的地方】
 *
 * 1. where 里带 userId —— 和 getOrderDetail 同一个道理，IDOR 防线。
 *    订单列表页如果没有这条，登录用户就能看到全站订单。
 *
 * 2. 不能用 include: { items: true } 把订单项全查出来再在内存里算件数。
 *    这叫 N+1 查询的变体：一页 20 个订单，每个订单 5 个订单项，
 *    就是 1 + 20 条 SQL，其中一条还带回了 100 行明细，而我们只想显示「共 3 件」。
 *    这里用 take: 1 只取第一件（拿图和数量），
 *    再用 _count 让数据库自己数 —— _count 会编译成子查询，
 *    不会把明细行搬到应用层内存里。
 *
 *    （学习项目里数据量小，N+1 也能跑。但「列表页别把明细全捞出来」
 *      是必须养成的习惯，等数据上万条时再改就晚了。）
 */
export async function getOrdersByUser(userId: string): Promise<OrderSummary[]> {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderNo: true,
      status: true,
      totalAmount: true,
      createdAt: true,
      expiresAt: true,
      items: {
        take: 1,
        select: {
          quantity: true,
          // 图片存在 Product 上（一个 SPU 下所有 SKU 共用一组图），
          // 订单项快照里没有图 —— 换个图不影响历史订单金额的正确性，
          // 所以这里顺着可空的 skuId 关联。SKU 被删了 skuId 会变 null，
          // 查不到就显示占位图（可选链会一路短路成 undefined）
          sku: { select: { product: { select: { images: true } } } },
        },
      },
      // _count 让数据库帮我们数，不把行捞回应用层
      _count: { select: { items: true } },
    },
  })

  // 总件数 = 所有订单项的 quantity 之和。
  // _count 只能给「条数」，给不了「求和」，所以这里单独用 aggregate。
  // 学习项目为了少写一条 SQL，直接在下面用一次 groupBy 拿全部订单的件数。
  const quantityMap = await quantityByOrder(
    orders.map((order) => order.id),
  )

  return orders.map((order) => ({
    id: order.id,
    orderNo: order.orderNo,
    status: order.status as OrderStatus,
    statusLabel:
      ORDER_STATUS_LABEL[order.status as OrderStatus] ?? order.status,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    coverImage: order.items[0]?.sku
      ? (parseImages(order.items[0].sku.product.images)[0] ?? null)
      : null,
    itemKindCount: order._count.items,
    totalQuantity: quantityMap.get(order.id) ?? 0,
  }))
}

/**
 * 一次查出多个订单各自的「总件数」。
 *
 * 也可以用 _count 的思路给每个订单单独发一条 aggregate，
 * 但那样又是 N 条 SQL。groupBy 一条搞定：
 *
 *     SELECT orderId, SUM(quantity) FROM order_items
 *     WHERE orderId IN (...) GROUP BY orderId
 */
async function quantityByOrder(
  orderIds: string[],
): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map()

  const rows = await prisma.orderItem.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orderIds } },
    _sum: { quantity: true },
  })

  return new Map(rows.map((row) => [row.orderId, row._sum.quantity ?? 0]))
}

// ---------------------------------------------------------------------------
// 管理后台：全站订单
// ---------------------------------------------------------------------------

export type AdminOrderRow = {
  id: string
  orderNo: string
  status: OrderStatus
  statusLabel: string
  totalAmount: number
  createdAt: Date
  paidAt: Date | null
  itemKindCount: number
  totalQuantity: number
  /** 买家。管理员对着订单要能看出是谁买的 */
  buyer: { name: string; email: string }
}

export type AdminOrderPage = {
  rows: AdminOrderRow[]
  total: number
  page: number
  pageCount: number
}

/** 管理后台一页显示多少条 */
export const ADMIN_PAGE_SIZE = 20

/**
 * 全站订单列表（管理员）。
 *
 * 【和 getOrdersByUser 的差别】
 *   1. **没有 userId 条件** —— 这正是管理员该看的东西。所以这个函数
 *      的调用点必须自己做权限校验（见 src/app/actions/admin.ts 的 requireAdmin）。
 *      「查询函数故意开得很宽，把守门的责任放在调用点」是后台代码的常态，
 *      但代价是每个调用点都不能忘 —— 这也是为什么 admin 相关的代码
 *      全部集中在 src/app/admin/ 下面，而不是散落各处。
 *   2. 多了状态筛选和分页。订单只会越积越多，列表页必须有分页，
 *      否则某天打开后台就是一次全表查询 + 渲染十万行。
 *
 * 【为什么 count 和 list 要放在一次 $transaction 里】
 * 两条查询分开跑的话，中间可能插入一笔新订单，导致「共 3 页」但实际有
 * 3 页零 1 条这种对不上的情况。放进同一个事务读，拿到的是同一个快照。
 */
export async function getAdminOrders(options?: {
  status?: OrderStatus
  page?: number
  /**
   * 只看**今天下的**单（按 createdAt）。
   *
   * 这个筛选存在的唯一理由是：后台首页那张「今日订单数」卡片要能点进来。
   * 卡片上的数字是 count(createdAt ∈ 今天)，点进来的列表必须用**同一个**
   * 条件 —— 否则管理员点过去发现「卡片写 7 笔，列表里 12 条」，
   * 他不知道该信哪个，两个数字就都废了。
   * 这类「数字和它的下钻页面必须是同一个 where」的要求，
   * 在写任何看板时都要主动想一遍。
   */
  createdToday?: boolean
  /**
   * 只看**今天付款的**单（按 paidAt，已排除已取消）。
   *
   * 对应首页的「今日销售额」卡片。销售额是按 paidAt 算的
   * （理由见 src/lib/dashboard.ts 里那条 aggregate 的注释），
   * 所以下钻页面也只能按 paidAt 筛。
   */
  paidToday?: boolean
}): Promise<AdminOrderPage> {
  // 【为什么不能只写 Math.max(1, Math.floor(x))】
  // Math.max 遇到 NaN 会把 NaN 原样传出来（Math.max(1, NaN) === NaN），
  // 于是 skip 变成 NaN，Prisma 会当成「参数缺失」直接抛
  // PrismaClientValidationError —— 一个 500，而不是「显示第一页」。
  //
  // 现在页面那边是自己用 Number.isFinite 洗过一遍的，所以线上没炸过。
  // 但那是**调用方的自觉**，不是这个函数的保证 —— 下一处调用忘了洗就中招。
  // 这种「函数只在被正确调用时才正确」的假设，正是最该消掉的。
  const rawPage = options?.page ?? 1
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1

  // 【为什么手写这个类型而不是用 Prisma.OrderWhereInput】
  // 能用 Prisma 的类型当然更好，但这里显式写出来是为了让「这个 where
  // 只可能有这三种条件」这件事一眼可见 —— 后台列表的筛选条件是有限集合，
  // 看到 where 全貌就放心了。真正的类型检查交给下面赋值时的那一行。
  const where: {
    status?: OrderStatus | { not: OrderStatus }
    createdAt?: { gte: Date; lt: Date }
    paidAt?: { gte: Date; lt: Date }
  } = {}

  // 顺序有讲究：paidToday 先设一个宽松的 status 条件，
  // 后面显式的 status 再覆盖它。
  // 这样 ?status=PAID&paidToday=1 得到的是「今天付款且状态是 PAID」——
  // 用户明确点名了状态，就该听他的。
  if (options?.paidToday) {
    where.paidAt = todayRange()
    where.status = { not: ORDER_STATUS.CANCELLED }
  }

  if (options?.status) where.status = options.status
  if (options?.createdToday) where.createdAt = todayRange()

  const [total, orders] = await prisma.$transaction([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      // skip/take 就是 SQL 的 OFFSET/LIMIT。
      // 数据量很大时 OFFSET 会越来越慢（数据库仍要扫过前面所有行），
      // 那时应该改成游标分页（where: { createdAt: { lt: 上一页最后一条的时间 } }）。
      // 学习项目用 OFFSET 足够，知道这条路什么时候会走不通就行。
      skip: (page - 1) * ADMIN_PAGE_SIZE,
      take: ADMIN_PAGE_SIZE,
      select: {
        id: true,
        orderNo: true,
        status: true,
        totalAmount: true,
        createdAt: true,
        paidAt: true,
        user: { select: { name: true, email: true } },
        _count: { select: { items: true } },
      },
    }),
  ])

  const quantityMap = await quantityByOrder(orders.map((o) => o.id))

  return {
    rows: orders.map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      status: order.status as OrderStatus,
      statusLabel: ORDER_STATUS_LABEL[order.status as OrderStatus] ?? order.status,
      totalAmount: order.totalAmount,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      itemKindCount: order._count.items,
      totalQuantity: quantityMap.get(order.id) ?? 0,
      buyer: order.user,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)),
  }
}

/**
 * 各状态的订单数，后台首页用。
 *
 * 用 groupBy 让数据库一次算完，而不是查 5 次 count()。
 * 虽然这个项目里 5 次也很快，但「能在一条 SQL 里做完就别发 N 条」是习惯问题。
 */
export async function getAdminOrderStats(): Promise<
  Record<OrderStatus, number> & { total: number }
> {
  const rows = await prisma.order.groupBy({
    by: ["status"],
    _count: { _all: true },
  })

  // 先把五个状态都填 0，再把查出来的覆盖上去 ——
  // 这样前端拿到的永远是一个完整的 Record，不用到处写 ?? 0
  const stats = Object.fromEntries(
    ORDER_STATUS_VALUES.map((status) => [status, 0]),
  ) as Record<OrderStatus, number>

  let total = 0
  for (const row of rows) {
    const status = row.status as OrderStatus
    // 数据库里可能存着非法状态（SQLite 没有 enum），静默忽略比崩掉好
    if (!(status in stats)) continue
    stats[status] = row._count._all
    total += row._count._all
  }

  return { ...stats, total }
}
