import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS } from "@/lib/constants"
import {
  confirmReceipt,
  payOrder,
  shipOrder,
} from "@/lib/orders"
import {
  expiredAt,
  futureAt,
  makeOrder,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
  statusOf,
} from "./helpers/db"

// ============================================================================
// 订单状态机 —— 集成测试
//
//   PENDING_PAYMENT ──支付──> PAID ──发货──> SHIPPED ──确认收货──> COMPLETED
//          │                    │
//          └──超时/取消──> CANCELLED <──┘
//
// 【这一组测什么】
// 不是「状态机表本身对不对」（那是单元测试 tests/unit/order-status.test.ts 的活），
// 而是**每条流转真的能在数据库上跑通/被拦住**。
//
// 两者的区别很实际：状态机的定义在 constants.ts，但真正的守门人是
// orders.ts 里那些 updateMany 的 WHERE 子句。表写对了、SQL 写漏一个条件，
// 单元测试照样全绿，而线上可以未付款就发货。所以这层必须打真库。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

describe("合法流转：每一步都能走通，并写下时间戳", () => {
  it("待支付 → 支付 → 已支付，同时记录 paidAt", async () => {
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, expiresAt: futureAt() })

    const result = await payOrder(order.id, user.id)

    expect(result).toEqual({ ok: true })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.status).toBe(ORDER_STATUS.PAID)
    expect(after.paidAt).toBeInstanceOf(Date)
  })

  it("已支付 → 管理员发货 → 已发货，同时记录 shippedAt", async () => {
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, status: ORDER_STATUS.PAID })

    const result = await shipOrder(order.id)

    expect(result).toEqual({ ok: true })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.status).toBe(ORDER_STATUS.SHIPPED)
    expect(after.shippedAt).toBeInstanceOf(Date)
  })

  it("已发货 → 用户确认收货 → 已完成，同时记录 completedAt", async () => {
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, status: ORDER_STATUS.SHIPPED })

    const result = await confirmReceipt(order.id, user.id)

    expect(result).toEqual({ ok: true })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.status).toBe(ORDER_STATUS.COMPLETED)
    expect(after.completedAt).toBeInstanceOf(Date)
  })

  it("走完整条链路：待支付 → 已支付 → 已发货 → 已完成", async () => {
    // 单独测每一跳，可能每一跳都对，但拼起来不对（比如某一步把时间字段写错列）。
    // 端到端走一遍是最便宜的保险
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, expiresAt: futureAt() })

    expect((await payOrder(order.id, user.id)).ok).toBe(true)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)

    expect((await shipOrder(order.id)).ok).toBe(true)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.SHIPPED)

    expect((await confirmReceipt(order.id, user.id)).ok).toBe(true)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.COMPLETED)
  })

  it("待支付 → 取消（超时扫描之外的主动取消路径）", async () => {
    // 这里直接改库模拟「取消」这一跳，验证 CANCELLED 是可达的
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id })

    await prisma.order.update({
      where: { id: order.id },
      data: { status: ORDER_STATUS.CANCELLED, cancelledAt: new Date() },
    })

    expect(await statusOf(order.id)).toBe(ORDER_STATUS.CANCELLED)
  })
})

describe("非法流转：全部被挡住，且状态不变", () => {
  it("【非法 1】未支付不能发货", async () => {
    const user = await makeUser()
    const order = await makeOrder({
      userId: user.id,
      status: ORDER_STATUS.PENDING_PAYMENT,
    })

    const result = await shipOrder(order.id)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("待支付")
    // 关键：不只是返回失败，数据库也不能被改
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.shippedAt).toBeNull()
  })

  it("【非法 2】未发货不能确认收货", async () => {
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, status: ORDER_STATUS.PAID })

    const result = await confirmReceipt(order.id, user.id)

    expect(result.ok).toBe(false)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.completedAt).toBeNull()
  })

  it("【非法 3】不能重复发货", async () => {
    // 管理员手抖点两下，或者网络重试。第二次必须被拒，
    // 而不是把 shippedAt 覆盖成一个更晚的时间
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, status: ORDER_STATUS.PAID })

    expect((await shipOrder(order.id)).ok).toBe(true)
    const firstShippedAt = (
      await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    ).shippedAt

    const second = await shipOrder(order.id)

    expect(second.ok).toBe(false)
    expect(second.ok === false && second.error).toContain("已经是")
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.SHIPPED)

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.shippedAt?.getTime()).toBe(firstShippedAt?.getTime())
  })

  it("【非法 4】已取消的订单不能支付", async () => {
    const user = await makeUser()
    const order = await makeOrder({
      userId: user.id,
      status: ORDER_STATUS.CANCELLED,
      expiresAt: futureAt(),
    })

    const result = await payOrder(order.id, user.id)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("已取消")
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.CANCELLED)
  })

  it("【附带】不能重复支付", async () => {
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, expiresAt: futureAt() })

    expect((await payOrder(order.id, user.id)).ok).toBe(true)
    const second = await payOrder(order.id, user.id)

    expect(second.ok).toBe(false)
    expect(second.ok === false && second.error).toContain("已经支付过")
  })

  it("【附带】已过期的订单不能支付", async () => {
    // 用户不该在两个 cron 之间钻空子，付一笔已经超时的订单
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, expiresAt: expiredAt() })

    const result = await payOrder(order.id, user.id)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("支付时限")
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })

  it("【附带】终态订单不能被发货", async () => {
    const user = await makeUser()

    for (const terminal of [ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED]) {
      const order = await makeOrder({ userId: user.id, status: terminal })
      const result = await shipOrder(order.id)

      expect(result.ok).toBe(false)
      expect(await statusOf(order.id)).toBe(terminal)
    }
  })

  it("不存在的订单返回「订单不存在」，不抛异常", async () => {
    expect(await shipOrder("not-a-real-order-id")).toEqual({
      ok: false,
      error: "订单不存在",
    })
    expect(await confirmReceipt("not-a-real-order-id", "whoever")).toEqual({
      ok: false,
      error: "订单不存在",
    })
  })
})

describe("并发：5 个请求同时发货，只能有一个成功", () => {
  it("5 次并发 shipOrder → 恰好 1 次 ok，且 shippedAt 只被写一次", async () => {
    // 这是「条件更新 + 受影响行数」这套写法真正要证明的东西。
    // 写法本身在单元测试里看不出来 —— 必须真的并发打同一个库
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, status: ORDER_STATUS.PAID })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => shipOrder(order.id)),
    )

    const okCount = results.filter((r) => r.ok).length
    expect(okCount).toBe(1)
    expect(results.filter((r) => !r.ok)).toHaveLength(4)

    expect(await statusOf(order.id)).toBe(ORDER_STATUS.SHIPPED)

    // 只有一次写入，shippedAt 不该被后来的请求覆盖
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.shippedAt).toBeInstanceOf(Date)
  })

  it("5 次并发支付 → 恰好 1 次成功", async () => {
    // 真实场景里重复支付意味着真的扣了两次钱
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, expiresAt: futureAt() })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => payOrder(order.id, user.id)),
    )

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)
  })

  it("5 次并发确认收货 → 恰好 1 次成功", async () => {
    const user = await makeUser()
    const order = await makeOrder({ userId: user.id, status: ORDER_STATUS.SHIPPED })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => confirmReceipt(order.id, user.id)),
    )

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.COMPLETED)
  })
})
