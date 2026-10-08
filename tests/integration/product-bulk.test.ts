import { beforeEach, describe, expect, it } from "vitest"

import { BULK_MAX_SKUS, LOW_STOCK_THRESHOLD, MAX_PRICE_CENTS } from "@/lib/constants"
import {
  bulkAdjustProductStock,
  bulkSetProductActive,
  bulkUpdateProductPrice,
} from "@/lib/product-bulk"
import { getAdminProducts } from "@/lib/products"
import {
  makeProduct,
  makeSku,
  prisma,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 商品的批量操作 —— 集成测试
//
// 【这个文件里 90% 的断言，写的是同一句话：失败时什么都没变】
//
// 批量操作只有两种合法结局：全部成功，或者全部没发生。
// 「改了 3 个、第 4 个报错、剩下的没动」是不存在的状态 ——
// 真出现那种数据，事后没人能修得好，因为没人知道改到哪了。
//
// 所以每个「应该失败」的用例，断言的重点都不是「返回了 ok: false」
// （那太容易做到了，return 一个错误对象就行），而是
// **回数据库里逐行核对，值还是原来的值**。
// 只断言返回值的话，一个「先写了一半再 return」的实现照样能通过。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

/** 一次读回所有 SKU 的价格，方便整批比对 */
async function pricesOf(ids: string[]): Promise<Record<string, number>> {
  const rows = await prisma.sku.findMany({
    where: { id: { in: ids } },
    select: { id: true, price: true },
  })
  return Object.fromEntries(rows.map((row) => [row.id, row.price]))
}

/** 一次读回所有 SKU 的库存 */
async function stocksOf(ids: string[]): Promise<Record<string, number>> {
  const rows = await prisma.sku.findMany({
    where: { id: { in: ids } },
    select: { id: true, stock: true },
  })
  return Object.fromEntries(rows.map((row) => [row.id, row.stock]))
}

/** 造一款商品 + n 个规格，返回商品和 SKU 列表 */
async function makeProductWithSkus(
  n: number,
  sku?: { price?: number; stock?: number },
) {
  const product = await makeProduct()
  const skus = []
  for (let i = 0; i < n; i++) {
    skus.push(
      await makeSku(product.id, {
        size: String(40 + i),
        price: sku?.price,
        stock: sku?.stock,
      }),
    )
  }
  return { product, skus }
}

// ---------------------------------------------------------------------------
// 批量上下架
// ---------------------------------------------------------------------------

describe("bulkSetProductActive：批量上架 / 下架", () => {
  it("把勾选的商品全部下架", async () => {
    const a = await makeProductWithSkus(2)
    const b = await makeProductWithSkus(1)

    const result = await bulkSetProductActive([a.product.id, b.product.id], false)

    expect(result).toEqual({ ok: true, affected: 2, message: "已下架 2 款商品" })

    // 不信返回值，去库里看一眼
    const rows = await prisma.product.findMany({
      where: { id: { in: [a.product.id, b.product.id] } },
      select: { isActive: true },
    })
    expect(rows.every((row) => !row.isActive)).toBe(true)
  })

  it("没勾中的商品不受影响", async () => {
    const selected = await makeProductWithSkus(1)
    const other = await makeProductWithSkus(1)

    await bulkSetProductActive([selected.product.id], false)

    const untouched = await prisma.product.findUniqueOrThrow({
      where: { id: other.product.id },
      select: { isActive: true },
    })
    expect(untouched.isActive).toBe(true)
  })

  it("有商品已经不存在 → 整批取消，剩下的也不许动", async () => {
    const real = await makeProductWithSkus(1)

    // 模拟「勾选之后、点确认之前，别人把这款删了」
    const result = await bulkSetProductActive(
      [real.product.id, "已经被删掉的商品id"],
      false,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("已经不存在")
    expect(result.error).toContain("1 款")

    // 【这一行才是这个用例的重点】
    // 如果实现用的是 updateMany 且不做前置检查，它会静默跳过缺失的 id、
    // 把 real 下架掉，然后弹一句「已下架 1 款」—— 管理员以为 2 款都成功了。
    // 逐个 update 再 return 错误的实现，则会留下「第一款已改」的中间状态。
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: real.product.id },
      select: { isActive: true },
    })
    expect(after.isActive).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 批量改价
// ---------------------------------------------------------------------------

describe("bulkUpdateProductPrice：批量改价", () => {
  it("按百分比下调，作用于所选商品下的每一个 SKU", async () => {
    const { product, skus } = await makeProductWithSkus(3, { price: 10_000 })

    // 下调 15%：10000 * 85 / 100 = 8500
    const result = await bulkUpdateProductPrice([product.id], "percent", -15)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.affected).toBe(3)

    const prices = await pricesOf(skus.map((s) => s.id))
    expect(Object.values(prices)).toEqual([8500, 8500, 8500])
  })

  it("百分比下调的余数落到分，不产生小数", async () => {
    // 89999 * 85 / 100 = 76499.15 —— 必须落到整数分
    const { product, skus } = await makeProductWithSkus(1, { price: 89_999 })

    await bulkUpdateProductPrice([product.id], "percent", -15)

    const prices = await pricesOf([skus[0].id])
    expect(prices[skus[0].id]).toBe(76_499)
    expect(Number.isInteger(prices[skus[0].id])).toBe(true)
  })

  it("按百分比上调", async () => {
    const { product, skus } = await makeProductWithSkus(2, { price: 10_000 })

    await bulkUpdateProductPrice([product.id], "percent", 20)

    const prices = await pricesOf(skus.map((s) => s.id))
    expect(Object.values(prices)).toEqual([12_000, 12_000])
  })

  it("统一设为固定价，多个 SKU 变成同一个价", async () => {
    const product = await makeProduct()
    const cheap = await makeSku(product.id, { price: 5_000, size: "40" })
    const pricey = await makeSku(product.id, { price: 50_000, size: "44" })

    const result = await bulkUpdateProductPrice([product.id], "set", 19_900)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.message).toContain("¥199.00")

    const prices = await pricesOf([cheap.id, pricey.id])
    expect(prices[cheap.id]).toBe(19_900)
    expect(prices[pricey.id]).toBe(19_900)
  })

  it("affected 数的是「真的变了几个」，不是「改了几个」", async () => {
    // 统一设为 199 元时，本来就是这个价的那个其实没变。
    // 报「已改 3 个」不算错，但报「2 个发生变化」才对得上管理员的预期
    const product = await makeProduct()
    await makeSku(product.id, { price: 19_900, size: "40" })
    await makeSku(product.id, { price: 5_000, size: "41" })
    await makeSku(product.id, { price: 50_000, size: "42" })

    const result = await bulkUpdateProductPrice([product.id], "set", 19_900)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.affected).toBe(2)
    expect(result.message).toContain("3 个规格")
  })

  it("某个 SKU 改完会变成 0 分 → 整批回滚，**一个价格都没变**", async () => {
    const product = await makeProduct()
    // 【这两个价格是专门挑的，让**只有一个**越界】
    // 降价 99% 后取整到分：
    //   100 分 → round(1)     = 1   分，合法
    //    40 分 → round(0.4)   = 0   分，越界
    // 如果两个都越界（比如降 100%），那先撞上哪个取决于 findMany 的返回顺序 ——
    // 而它没带 orderBy，顺序本来就不保证，断言会时对时错。
    // 只让一个越界，就不依赖顺序了
    const survives = await makeSku(product.id, { price: 100, size: "40" })
    const doomed = await makeSku(product.id, { price: 40, size: "41" })

    const before = await pricesOf([survives.id, doomed.id])

    // 【为什么绕过 schema 直接调 lib】
    // bulkPriceSchema 把百分比卡在 -90，正常入口走不到这里。
    // 但 lib 层的兜底不能因此就省掉 —— 它是最后一道防线，
    // 而且 schema 的范围将来可能被放宽、或者有别的地方直接调这个函数
    const result = await bulkUpdateProductPrice([product.id], "percent", -99)

    expect(result.ok).toBe(false)
    if (result.ok) return
    // 错误信息要说清是哪个规格、改完是多少 ——
    // 只说「第 2 条 UPDATE 失败」的话，管理员完全不知道该改什么
    expect(result.error).toContain("不能低于 0.01 元")
    expect(result.error).toContain("黑色 41 码")

    // 【这一行才是重点】
    // survives 那个 SKU 是合法的新价格，logically 已经算出来了。
    // 「边算边写」的实现在这里会把它写进库 —— 事务会兜住没错，
    // 但那种写法下你根本不知道自己抛得对不对。
    // 先算完再写，才有「要么全成、要么一个没写」这句话
    const after = await pricesOf([survives.id, doomed.id])
    expect(after).toEqual(before)
    expect(after[survives.id]).toBe(100)
    expect(after[doomed.id]).toBe(40)
  })

  it("某个 SKU 改完超过价格上限 → 整批回滚", async () => {
    const product = await makeProduct()
    const normal = await makeSku(product.id, { price: 89_900, size: "40" })
    const huge = await makeSku(product.id, { price: 20_000_000, size: "41" })

    const before = await pricesOf([normal.id, huge.id])

    // 20000000 * 600 / 100 = 120000000 > MAX_PRICE_CENTS
    const result = await bulkUpdateProductPrice([product.id], "percent", 500)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("超过上限")
    expect(await pricesOf([normal.id, huge.id])).toEqual(before)
    expect(MAX_PRICE_CENTS).toBeLessThan(120_000_000)
  })

  it("勾选的商品还没有规格 → 报错而不是静默成功", async () => {
    const product = await makeProduct() // 故意不建 SKU

    const result = await bulkUpdateProductPrice([product.id], "set", 19_900)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("还没有规格")
  })

  it("勾选多款商品时只改这些商品的价格，别的商品不碰", async () => {
    const selected = await makeProductWithSkus(2, { price: 10_000 })
    const other = await makeProductWithSkus(1, { price: 10_000 })

    await bulkUpdateProductPrice([selected.product.id], "set", 88_800)

    const prices = await pricesOf([
      ...selected.skus.map((s) => s.id),
      other.skus[0].id,
    ])
    for (const sku of selected.skus) expect(prices[sku.id]).toBe(88_800)
    expect(prices[other.skus[0].id]).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// 批量调库存
// ---------------------------------------------------------------------------

describe("bulkAdjustProductStock：批量入库 / 出库", () => {
  it("批量入库：每个 SKU 各加那么多", async () => {
    const { product, skus } = await makeProductWithSkus(3, { stock: 10 })

    const result = await bulkAdjustProductStock([product.id], 5)

    expect(result).toEqual({
      ok: true,
      affected: 3,
      message: "已给 3 个规格各入库 5 件",
    })

    const stocks = await stocksOf(skus.map((s) => s.id))
    expect(Object.values(stocks)).toEqual([15, 15, 15])
  })

  it("批量出库：每个 SKU 各减那么多", async () => {
    const { product, skus } = await makeProductWithSkus(2, { stock: 10 })

    const result = await bulkAdjustProductStock([product.id], -4)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.message).toContain("出库 4 件")

    const stocks = await stocksOf(skus.map((s) => s.id))
    expect(Object.values(stocks)).toEqual([6, 6])
  })

  it("出库刚好扣到 0 是允许的", async () => {
    const { product, skus } = await makeProductWithSkus(1, { stock: 7 })

    const result = await bulkAdjustProductStock([product.id], -7)

    expect(result.ok).toBe(true)
    expect((await stocksOf([skus[0].id]))[skus[0].id]).toBe(0)
  })

  it("有一个 SKU 库存不够 → 整批取消，**一个都没被扣**", async () => {
    const product = await makeProduct()
    const enough = await makeSku(product.id, { stock: 10, size: "40" })
    const short = await makeSku(product.id, { stock: 3, size: "41" })

    const before = await stocksOf([enough.id, short.id])

    const result = await bulkAdjustProductStock([product.id], -8)

    expect(result.ok).toBe(false)
    if (result.ok) return
    // 错误信息要指出是哪一个、还剩多少、差多少 —— 这样管理员才知道该填几
    expect(result.error).toContain("黑色 41 码")
    expect(result.error).toContain("只有 3 件")
    expect(result.error).toContain("不够出库 8 件")

    // 【关键】库存必须原样。enough 有 10 件、够扣 8 件，
    // 所以「先做预检再逐个扣」和「边扣边发现不够」两种写法，
    // 只有前者能通过这一条
    expect(await stocksOf([enough.id, short.id])).toEqual(before)
  })

  it("库存永远不会变成负数", async () => {
    const { product, skus } = await makeProductWithSkus(2, { stock: 2 })

    const result = await bulkAdjustProductStock([product.id], -3)

    expect(result.ok).toBe(false)
    const stocks = await stocksOf(skus.map((s) => s.id))
    expect(Object.values(stocks)).toEqual([2, 2])
    expect(Math.min(...Object.values(stocks))).toBeGreaterThanOrEqual(0)
  })

  it("出库不足时不区分「够的商品」和「不够的商品」，整批一起取消", async () => {
    // 这个用例故意让两款商品一个够一个不够。
    // 逐个商品提交（而不是整批一个事务）的实现，会把够的那款扣掉 ——
    // 管理员看到报错，但那款商品的库存真的少了
    const okProduct = await makeProductWithSkus(1, { stock: 100 })
    const badProduct = await makeProductWithSkus(1, { stock: 1 })

    const before = await stocksOf([
      okProduct.skus[0].id,
      badProduct.skus[0].id,
    ])

    const result = await bulkAdjustProductStock(
      [okProduct.product.id, badProduct.product.id],
      -50,
    )

    expect(result.ok).toBe(false)
    expect(await stocksOf([okProduct.skus[0].id, badProduct.skus[0].id])).toEqual(
      before,
    )
  })

  it("delta 为 0 被拒 —— 否则会弹「已入库 0 件」这种假成功", async () => {
    const { product } = await makeProductWithSkus(2, { stock: 10 })

    const result = await bulkAdjustProductStock([product.id], 0)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("非 0 整数")
  })

  it("小数和超上限的增量在 lib 层也被拦下", async () => {
    const { product, skus } = await makeProductWithSkus(1, { stock: 10 })

    const fractional = await bulkAdjustProductStock([product.id], 1.5)
    const tooBig = await bulkAdjustProductStock([product.id], 1_000_000)

    expect(fractional.ok).toBe(false)
    expect(tooBig.ok).toBe(false)
    // 两次非法调用之后库存仍然是 10
    expect((await stocksOf([skus[0].id]))[skus[0].id]).toBe(10)
  })

  it("勾选的商品还没有规格 → 报错而不是静默成功", async () => {
    const product = await makeProduct()

    const result = await bulkAdjustProductStock([product.id], 5)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("还没有规格")
  })

  it("规格总数超过单次上限 → 整批取消", async () => {
    const product = await makeProduct()

    // 一次性造出超过上限的 SKU。用 createMany 而不是循环 create，
    // 500+ 次往返在 SQLite 上会明显拖慢这个用例
    await prisma.sku.createMany({
      data: Array.from({ length: BULK_MAX_SKUS + 1 }, (_, i) => ({
        productId: product.id,
        size: String(100 + i),
        color: "黑色",
        price: 10_000,
        stock: 10,
        skuCode: `BULK-OVER-${i}`,
      })),
    })

    const result = await bulkAdjustProductStock([product.id], 1)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(String(BULK_MAX_SKUS))

    // 【上限存在的意义就是别把写锁攥太久】
    // 拦下之后库存总量必须一点没涨
    const total = await prisma.sku.aggregate({
      where: { productId: product.id },
      _sum: { stock: true },
    })
    expect(total._sum.stock).toBe((BULK_MAX_SKUS + 1) * 10)
  })

  it("刚好等于上限是允许的", async () => {
    const product = await makeProduct()
    await prisma.sku.createMany({
      data: Array.from({ length: BULK_MAX_SKUS }, (_, i) => ({
        productId: product.id,
        size: String(200 + i),
        color: "黑色",
        price: 10_000,
        stock: 10,
        skuCode: `BULK-OK-${i}`,
      })),
    })

    const result = await bulkAdjustProductStock([product.id], 1)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.affected).toBe(BULK_MAX_SKUS)
  })
})

// ---------------------------------------------------------------------------
// 商品列表的搜索
// ---------------------------------------------------------------------------

describe("getAdminProducts：按名称搜索", () => {
  it("中文按子串模糊匹配", async () => {
    await makeProduct({ name: "轻量跑步鞋 一代" })
    await makeProduct({ name: "复古板鞋" })
    await makeProduct({ name: "跑步袜" })

    const rows = await getAdminProducts({ q: "跑步" })
    const names = rows.map((row) => row.name)

    expect(names).toContain("轻量跑步鞋 一代")
    expect(names).toContain("跑步袜")
    expect(names).not.toContain("复古板鞋")
  })

  it("英文大小写不敏感（SQLite 的 LIKE 默认行为）", async () => {
    await makeProduct({ name: "Air Zoom 跑鞋" })

    // 这一条不是在测我们的代码，是在**记录**我们依赖的数据库行为。
    // 将来换到 PostgreSQL 时它会挂 —— 那时需要显式加
    // mode: "insensitive"，这个失败的用例正好提醒了这件事
    const rows = await getAdminProducts({ q: "air zoom" })
    expect(rows.map((row) => row.name)).toContain("Air Zoom 跑鞋")
  })

  it("不传 q 或传空 / 纯空白，都不筛选", async () => {
    await makeProduct({ name: "轻量跑步鞋" })
    await makeProduct({ name: "复古板鞋" })

    expect(await getAdminProducts()).toHaveLength(2)
    expect(await getAdminProducts({ q: "" })).toHaveLength(2)
    // 【为什么空白也要当成「不筛」】
    // 输入框里敲了个空格再点搜索，用户的心理预期是「搜了个空」= 全部。
    // 如果按字面去匹配「名字里含空格」，他会看到 0 条结果，
    // 然后开始怀疑自己的商品是不是丢了
    expect(await getAdminProducts({ q: "   " })).toHaveLength(2)
  })

  it("搜不到时返回空数组，不是报错", async () => {
    await makeProduct({ name: "轻量跑步鞋" })

    expect(await getAdminProducts({ q: "不存在的鞋" })).toEqual([])
  })

  it("搜索和上下架筛选叠加", async () => {
    await makeProduct({ name: "轻量跑步鞋", isActive: true })
    await makeProduct({ name: "轻量篮球鞋", isActive: false })

    const all = await getAdminProducts({ q: "轻量" })
    const activeOnly = await getAdminProducts({ q: "轻量", active: true })
    const inactiveOnly = await getAdminProducts({ q: "轻量", active: false })

    expect(all).toHaveLength(2)
    expect(activeOnly.map((r) => r.name)).toEqual(["轻量跑步鞋"])
    expect(inactiveOnly.map((r) => r.name)).toEqual(["轻量篮球鞋"])
  })

  it("搜索和低库存筛选叠加", async () => {
    const low = await makeProduct({ name: "轻量跑步鞋" })
    await makeSku(low.id, { stock: LOW_STOCK_THRESHOLD - 1 })

    const plenty = await makeProduct({ name: "轻量篮球鞋" })
    await makeSku(plenty.id, { stock: 100 })

    const rows = await getAdminProducts({ q: "轻量", lowStock: true })

    expect(rows.map((r) => r.name)).toEqual(["轻量跑步鞋"])
    // 顺带确认 lowStockSkuCount 是对的 —— 列表上要显示这个数字，
    // 否则后台首页卡片说「12 个规格告急」而列表只有 4 行，看着像 bug
    expect(rows[0].lowStockSkuCount).toBe(1)
  })
})
