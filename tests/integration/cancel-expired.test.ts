import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS } from "@/lib/constants"
import { cancelExpiredOrders, payOrder } from "@/lib/orders"
import {
  expiredAt,
  futureAt,
  makeOrder,
  makeShop,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
  statusOf,
  stockOf,
} from "./helpers/db"

// ============================================================================
// 超时未支付自动取消 —— 集成测试
//
// 【为什么这段代码值得单独一个测试文件】
// 因为它是全项目**唯一一处会「撤销已经发生过的事」**的逻辑：
// 改状态 + 还库存，而且是两个动作。两个动作之间只要有窗口，
// 就可能出现「用户付了钱、订单却被取消、货还被还回库存」——
// 收了钱不给货，是最严重的一类资损。
//
// 所以下面有一半的用例都在测**竞争**：扫描器和支付按钮抢同一张订单，
// 谁能赢、输了的那一方会不会留下脏数据。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

describe("基本行为：过期才取消，取消要还库存", () => {
  it("过期的待支付订单被取消，库存还回去", async () => {
    const { userId, sku } = await makeShop({ stock: 10 })
    // 下单时扣了 3 件，现在库存在 7 —— 直接造一张「已经扣过库存」的订单
    await prisma.sku.update({ where: { id: sku.id }, data: { stock: 7 } })
    const order = await makeOrder({
      userId,
      skuId: sku.id,
      quantity: 3,
      expiresAt: expiredAt(),
    })

    const result = await cancelExpiredOrders()

    expect(result.scanned).toBe(1)
    expect(result.cancelled).toBe(1)
    expect(result.restoredUnits).toBe(3)

    expect(await statusOf(order.id)).toBe(ORDER_STATUS.CANCELLED)
    expect(await stockOf(sku.id)).toBe(10) // 7 + 3

    // cancelledAt 也要写上，不然页面上看不出是什么时候取消的
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.cancelledAt).toBeInstanceOf(Date)
  })

  it("还没到期的订单不动", async () => {
    const { userId, sku } = await makeShop()
    const order = await makeOrder({
      userId,
      skuId: sku.id,
      expiresAt: futureAt(),
    })

    const result = await cancelExpiredOrders()

    expect(result).toEqual({ scanned: 0, cancelled: 0, restoredUnits: 0 })
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })

  it("已支付的订单不动 —— 哪怕它的 expiresAt 早就过了", async () => {
    // 【最容易写错的一条】
    // 直觉上「过期的订单就取消」，但已支付的订单不该被碰：
    // 用户付了钱，expiresAt 只是个「该什么时候付」的提示，不是判决书。
    // 条件里漏掉 status 的话，这里就会把付过钱的订单取消并还库存
    const { userId, sku } = await makeShop({ stock: 5 })
    const order = await makeOrder({
      userId,
      skuId: sku.id,
      quantity: 2,
      status: ORDER_STATUS.PAID,
      expiresAt: expiredAt(),
    })

    const result = await cancelExpiredOrders()

    expect(result.scanned).toBe(0)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)
    expect(await stockOf(sku.id)).toBe(5) // 库存一分没动
  })

  it("已发货的订单即使过期也不还库存", async () => {
    // 货已经在路上了。这时候把库存加回去，同一件货会被卖第二次
    const { userId, sku } = await makeShop({ stock: 5 })
    const order = await makeOrder({
      userId,
      skuId: sku.id,
      quantity: 2,
      status: ORDER_STATUS.SHIPPED,
      expiresAt: expiredAt(),
    })

    const result = await cancelExpiredOrders()

    expect(result.cancelled).toBe(0)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.SHIPPED)
    expect(await stockOf(sku.id)).toBe(5)
  })

  it("已经是 CANCELLED 的订单不会再被取消一次、也不会重复还库存", async () => {
    const { userId, sku } = await makeShop({ stock: 5 })
    await makeOrder({
      userId,
      skuId: sku.id,
      quantity: 2,
      status: ORDER_STATUS.CANCELLED,
      expiresAt: expiredAt(),
    })

    const result = await cancelExpiredOrders()

    expect(result.cancelled).toBe(0)
    expect(await stockOf(sku.id)).toBe(5)
  })

  it("订单项对应的 SKU 已被删除 → 取消成功，但没有库存可还", async () => {
    // skuId 被置空的历史订单不能让它把整个扫描搞崩
    const user = await makeUser()
    const order = await makeOrder({
      userId: user.id,
      skuId: null, // 没有订单项
      expiresAt: expiredAt(),
    })

    const result = await cancelExpiredOrders()

    expect(result.cancelled).toBe(1)
    expect(result.restoredUnits).toBe(0)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.CANCELLED)
  })
})

describe("幂等：重复扫描不会重复还库存", () => {
  it("同一个过期订单扫两次，第二次什么也不做", async () => {
    // 定时任务可能因为重试、或者被 cron 和页面兜底同时触发而跑多遍。
    // 如果第二次还能「再还一次库存」，库存就会凭空多出来
    const { userId, sku } = await makeShop({ stock: 5 })
    await makeOrder({ userId, skuId: sku.id, quantity: 3, expiresAt: expiredAt() })

    const first = await cancelExpiredOrders()
    const afterFirst = await stockOf(sku.id)

    const second = await cancelExpiredOrders()
    const afterSecond = await stockOf(sku.id)

    expect(first).toMatchObject({ cancelled: 1, restoredUnits: 3 })
    expect(second).toEqual({ scanned: 0, cancelled: 0, restoredUnits: 0 })
    expect(afterFirst).toBe(8) // 5 + 3
    expect(afterSecond).toBe(8) // 没有被加第二次
  })

  it("10 个并发扫描 → 每张订单只被取消一次", async () => {
    // 更狠一点的版本：10 个扫描器同时开跑。
    // 靠的是 UPDATE ... WHERE status='PENDING_PAYMENT' 这个抢占条件 ——
    // 只有把状态改走的那一个算赢，其余的 count = 0，直接跳过、不还库存
    const { userId, sku } = await makeShop({ stock: 0 })
    const orders = await Promise.all(
      Array.from({ length: 3 }, () =>
        makeOrder({ userId, skuId: sku.id, quantity: 2, expiresAt: expiredAt() }),
      ),
    )

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cancelExpiredOrders()),
    )

    const totalCancelled = results.reduce((sum, r) => sum + r.cancelled, 0)
    const totalRestored = results.reduce((sum, r) => sum + r.restoredUnits, 0)

    // 3 张订单，就只该被取消 3 次、还 6 件
    expect(totalCancelled).toBe(3)
    expect(totalRestored).toBe(6)
    expect(await stockOf(sku.id)).toBe(6)

    for (const order of orders) {
      expect(await statusOf(order.id)).toBe(ORDER_STATUS.CANCELLED)
    }
  })
})

describe("竞争：扫描器和支付同时来，只能有一个赢", () => {
  it("用户先付了钱 → 扫描器抢不到，订单保持已支付、库存不还", async () => {
    // 【这是整个文件最重要的一条】
    // 顺序：先支付，再扫描。
    // 如果扫描器的实现是「先查过期订单，再改状态」，它会在第一步就
    // 把这张订单查出来（因为查询时它确实还是 PENDING_PAYMENT 且已过期），
    // 然后把一张已付款的订单改成 CANCELLED 并把货还回去。
    const { userId, sku } = await makeShop({ stock: 5 })
    const order = await makeOrder({
      userId,
      skuId: sku.id,
      quantity: 2,
      // 过期时间设在未来，让支付能成功
      expiresAt: futureAt(),
    })
    await prisma.sku.update({ where: { id: sku.id }, data: { stock: 3 } })

    // 支付成功
    expect((await payOrder(order.id, userId)).ok).toBe(true)
    // 支付之后才过期
    await prisma.order.update({
      where: { id: order.id },
      data: { expiresAt: expiredAt() },
    })

    const result = await cancelExpiredOrders()

    expect(result.cancelled).toBe(0)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)
    expect(await stockOf(sku.id)).toBe(3) // 没有还回去
  })

  it("扫描器先取消 → 支付失败，订单保持已取消", async () => {
    // 反过来的顺序，用户那头要收到一句能看懂的提示，
    // 而不是「支付成功」却发现订单没了
    const { userId, sku } = await makeShop({ stock: 5 })
    await prisma.sku.update({ where: { id: sku.id }, data: { stock: 3 } })
    const order = await makeOrder({
      userId,
      skuId: sku.id,
      quantity: 2,
      expiresAt: expiredAt(),
    })

    const scan = await cancelExpiredOrders()
    expect(scan.cancelled).toBe(1)

    const pay = await payOrder(order.id, userId)

    expect(pay.ok).toBe(false)
    expect(pay.ok === false && pay.error).toContain("已取消")
    expect(await stockOf(sku.id)).toBe(5)
  })

  it("扫描和支付真的并发跑 20 轮 → 每轮都只有一个赢家，库存永远自洽", async () => {
    // 前两个用例是「先 A 后 B」的确定性顺序。
    // 这一条把两者真正丢进 Promise.all，让数据库自己去串行化 ——
    // 这才是「条件更新」这套写法要证明的东西
    for (let round = 0; round < 20; round++) {
      await resetDb()

      const { userId, sku } = await makeShop({ stock: 5 })
      await prisma.sku.update({ where: { id: sku.id }, data: { stock: 3 } })
      const order = await makeOrder({
        userId,
        skuId: sku.id,
        quantity: 2,
        expiresAt: expiredAt(),
      })

      const [pay, scan] = await Promise.all([
        payOrder(order.id, userId),
        cancelExpiredOrders(),
      ])

      const status = await statusOf(order.id)
      const stock = await stockOf(sku.id)

      // 两个操作不可能都成功
      expect(pay.ok && scan.cancelled > 0).toBe(false)
      // 状态必须是两者之一，不能是别的
      expect([ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED]).toContain(status)

      if (status === ORDER_STATUS.PAID) {
        // 付成功了：货归买家，库存不能再还回去
        expect(stock).toBe(3)
      } else {
        // 被取消了：库存必须还回来，且 pay 必须失败
        expect(stock).toBe(5)
        expect(pay.ok).toBe(false)
      }
    }
  })
})

describe("按用户扫描 / 限量", () => {
  it("传 userId 时只扫这个人的订单", async () => {
    // 页面兜底用的就是这个模式：只扫当前用户的，命中 userId 索引
    const alice = await makeUser()
    const bob = await makeUser()
    const product = await makeShop()

    const aliceOrder = await makeOrder({
      userId: alice.id,
      skuId: product.sku.id,
      expiresAt: expiredAt(),
    })
    const bobOrder = await makeOrder({
      userId: bob.id,
      skuId: product.sku.id,
      expiresAt: expiredAt(),
    })

    const result = await cancelExpiredOrders({ userId: alice.id })

    expect(result.scanned).toBe(1)
    expect(result.cancelled).toBe(1)
    expect(await statusOf(aliceOrder.id)).toBe(ORDER_STATUS.CANCELLED)
    // Bob 的订单一根汗毛都没动
    expect(await statusOf(bobOrder.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })

  it("limit 限制单次处理条数，剩下的留给下一轮", async () => {
    // 积压几万条时不能一把全扫完 —— 会把数据库写锁住很久
    const { userId, sku } = await makeShop()
    await Promise.all(
      Array.from({ length: 5 }, () =>
        makeOrder({ userId, skuId: sku.id, expiresAt: expiredAt() }),
      ),
    )

    const first = await cancelExpiredOrders({ limit: 2 })

    expect(first.scanned).toBe(2)
    expect(first.cancelled).toBe(2)
    // 还有 3 张躺着
    expect(await prisma.order.count({ where: { status: ORDER_STATUS.CANCELLED } })).toBe(2)

    const second = await cancelExpiredOrders({ limit: 10 })
    expect(second.cancelled).toBe(3)
  })

  it("先处理过期最久的（orderBy expiresAt asc）", async () => {
    const { userId, sku } = await makeShop()
    const older = await makeOrder({
      userId,
      skuId: sku.id,
      expiresAt: expiredAt(600),
    })
    await makeOrder({ userId, skuId: sku.id, expiresAt: expiredAt(60) })

    await cancelExpiredOrders({ limit: 1 })

    expect(await statusOf(older.id)).toBe(ORDER_STATUS.CANCELLED)
  })

  it("now 参数可以伪造当前时间", async () => {
    // 这是为了测试专门留的口子：传一个「未来时刻」进去，
    // 就等于让还没到期的订单立刻变成过期
    const { userId, sku } = await makeShop()
    const order = await makeOrder({
      userId,
      skuId: sku.id,
      expiresAt: futureAt(3600),
    })

    // 不伪造 → 不动
    expect((await cancelExpiredOrders()).cancelled).toBe(0)

    // 把「现在」推后两小时 → 该过期了
    const later = new Date(Date.now() + 2 * 3600 * 1000)
    expect((await cancelExpiredOrders({ now: later })).cancelled).toBe(1)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.CANCELLED)
  })
})
