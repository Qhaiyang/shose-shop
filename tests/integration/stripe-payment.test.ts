import type Stripe from "stripe"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ORDER_STATUS } from "@/lib/constants"
import { createPaymentIntentForOrder } from "@/lib/stripe-payment"
import {
  expiredAt,
  makeOrder,
  makeShop,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 建 PaymentIntent（支付流程的「开个头」）
//
// 【为什么这一层用注入的 mock，而不是真的调 Stripe】
// createPaymentIntentForOrder 的 Stripe 实例是参数传进来的，所以测试可以
// 塞一个假实例进去，验证「建了正确的 PI」「复用了而不是新建」这些逻辑，
// 全程不发任何网络请求、不依赖真实账号。真正发请求的集成点（getStripe）
// 在 Server Action 那一层，它薄到只剩一句转发，不需要为它单独起 HTTP。
//
// 【这个文件钉住的是三件会「静默错」的事】
//   1. 金额/货币/metadata 建错了 —— Stripe 那边收的是错的钱，webhook 回来后
//      对不上账，而且没有任何报错
//   2. 重复点击建出第二个 PI —— 旧 PI 还活着，它日后成功支付的 webhook
//      找不到归属（索引撒谎）
//   3. 越权/已支付/已过期没拦住 —— 一个不该出现的 PI 被建出来
// ============================================================================

/**
 * 造一个 Stripe 假实例。
 *
 * create / retrieve 都返回一个带 client_secret 的对象，够 createPaymentIntentForOrder
 * 用就行。真实 SDK 返回的字段远不止这些，但函数只读 id / client_secret / status，
 * 其余一概不碰 —— 所以 mock 不用长成真的 PaymentIntent。
 *
 * 【status 为什么不给默认值】
 * 不给的话 `pi.status` 是 undefined，于是「既不是 succeeded 也不是 canceled」——
 * 正好是「普通复用」那一路。想让用例走终态分支，就显式传 status
 */
function makeStripeMock(options?: {
  createResult?: { id?: string; client_secret?: string | null }
  retrieveResult?: { id?: string; client_secret?: string | null; status?: string }
}) {
  const create = vi.fn().mockResolvedValue({
    id: "pi_mock_created",
    client_secret: "secret_created",
    ...options?.createResult,
  })
  const retrieve = vi.fn().mockResolvedValue({
    id: "pi_mock_retrieved",
    client_secret: "secret_retrieved",
    ...options?.retrieveResult,
  })
  const stripe = { paymentIntents: { create, retrieve } } as unknown as Stripe
  return { stripe, create, retrieve }
}

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------

describe("建 PaymentIntent：新建", () => {
  it("金额=订单实付、货币=cny、metadata 带 orderId，且立刻写回 id", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, totalAmount: 12345 })

    const { stripe, create } = makeStripeMock()
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    expect(result).toEqual({ ok: true, clientSecret: "secret_created" })

    // 金额直接传订单的实付（分）。CNY 的最小单位就是分，所以不换算 ——
    // 见 constants.ts 里 STRIPE_CURRENCY 的注释
    expect(create).toHaveBeenCalledWith({
      amount: 12345,
      currency: "cny",
      automatic_payment_methods: { enabled: true },
      metadata: { orderId: order.id },
    })

    // 【立刻写回，不等 webhook】不写的话，第二次点「去支付」又看到 null、
    // 又建一个 PI，就踩了「旧 PI 找不到归属」那个坑
    const saved = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { stripePaymentIntentId: true },
    })
    expect(saved.stripePaymentIntentId).toBe("pi_mock_created")
  })
})

// ---------------------------------------------------------------------------
// 复用
// ---------------------------------------------------------------------------

describe("建 PaymentIntent：复用", () => {
  it("订单已有 stripePaymentIntentId → retrieve，绝不 create", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })
    await prisma.order.update({
      where: { id: order.id },
      data: { stripePaymentIntentId: "pi_existing_1" },
    })

    const { stripe, create, retrieve } = makeStripeMock({
      retrieveResult: { id: "pi_existing_1", client_secret: "secret_reused" },
    })
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    expect(result).toEqual({ ok: true, clientSecret: "secret_reused" })
    expect(retrieve).toHaveBeenCalledWith("pi_existing_1")
    // 复用这条路的全部意义：**没有**新建第二个 PI
    expect(create).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 复用 · 但旧 PI 已经到终态
  //
  // 这两种状态都不能把 clientSecret 发给前端 —— 终态的 PI 初始化不了
  // Elements，Stripe 会抛 loaderror。这一段钉的就是「别把死掉的 PI 交出去」
  // -------------------------------------------------------------------------

  it("旧 PI 已 succeeded 但订单还是待支付 → 对账成已支付，不吐 clientSecret、不建新 PI", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })
    await prisma.order.update({
      where: { id: order.id },
      data: { stripePaymentIntentId: "pi_already_paid" },
    })

    const { stripe, create, retrieve } = makeStripeMock({
      retrieveResult: {
        id: "pi_already_paid",
        client_secret: "secret_of_a_dead_pi",
        status: "succeeded",
      },
    })
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    // 钱早就收了，这次调用做的是对账 —— 没有 clientSecret 可给
    expect(result).toEqual({ ok: true, orderPaid: true })

    // 订单真的被推成了已支付（走的是 webhook 那个 markOrderPaidFromStripe）
    const saved = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, paidAt: true, stripePaymentIntentId: true },
    })
    expect(saved.status).toBe(ORDER_STATUS.PAID)
    expect(saved.paidAt).not.toBeNull()
    expect(saved.stripePaymentIntentId).toBe("pi_already_paid")

    expect(retrieve).toHaveBeenCalledWith("pi_already_paid")
    // 【这条最要紧】绝不能新建 —— 那等于让用户为一个已经付过的订单再付一次
    expect(create).not.toHaveBeenCalled()
  })

  it("旧 PI 已 canceled → 新建一个并把 id 覆盖过去（复用一个作废的 PI 没有意义）", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })
    await prisma.order.update({
      where: { id: order.id },
      data: { stripePaymentIntentId: "pi_old_canceled" },
    })

    const { stripe, create, retrieve } = makeStripeMock({
      createResult: { id: "pi_fresh", client_secret: "secret_fresh" },
      retrieveResult: {
        id: "pi_old_canceled",
        client_secret: "secret_of_a_canceled_pi",
        status: "canceled",
      },
    })
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    expect(result).toEqual({ ok: true, clientSecret: "secret_fresh" })
    expect(retrieve).toHaveBeenCalledWith("pi_old_canceled")
    expect(create).toHaveBeenCalledOnce()

    // 新 PI 的 id 落库了 —— webhook 靠这一列找回订单，换不成功就等于丢单
    const saved = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { stripePaymentIntentId: true, status: true },
    })
    expect(saved.stripePaymentIntentId).toBe("pi_fresh")
    // 新建 PI 不等于订单被推进 —— 订单还得等用户付完钱 + webhook 回来
    expect(saved.status).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })
})

// ---------------------------------------------------------------------------
// 三个守卫：越权 / 已支付 / 已过期
// ---------------------------------------------------------------------------

describe("建 PaymentIntent：资格守卫", () => {
  it("查别人的订单 → 「订单不存在」，一个字节都不碰 Stripe", async () => {
    const owner = await makeShop()
    const order = await makeOrder({ userId: owner.userId })
    const stranger = await makeUser()

    const { stripe, create, retrieve } = makeStripeMock()
    const result = await createPaymentIntentForOrder(stripe, order.id, stranger.id)

    expect(result).toEqual({ ok: false, error: "订单不存在" })
    expect(create).not.toHaveBeenCalled()
    expect(retrieve).not.toHaveBeenCalled()
  })

  it("已支付的订单 → 文案和 payOrder 一致，不建 PI", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, status: ORDER_STATUS.PAID })

    const { stripe, create } = makeStripeMock()
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    expect(result).toEqual({ ok: false, error: "这笔订单已经支付过了" })
    expect(create).not.toHaveBeenCalled()
  })

  it("已取消的订单 → 「订单已取消，无法支付」", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, status: ORDER_STATUS.CANCELLED })

    const { stripe, create } = makeStripeMock()
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    expect(result).toEqual({ ok: false, error: "订单已取消，无法支付" })
    expect(create).not.toHaveBeenCalled()
  })

  // 「订单已取消」和「钱收了没有」是两件事。订单可能是在用户**付完之后**
  // 才被超时扫描取消的 —— 那时候再说「订单已取消，无法支付」就是骗人：
  // 钱真出去了，用户需要的是「去联系客服」
  it("订单已取消、但 PI 已经 succeeded → 「请联系客服」，不擅自把订单改回去", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, status: ORDER_STATUS.CANCELLED })
    await prisma.order.update({
      where: { id: order.id },
      data: { stripePaymentIntentId: "pi_paid_then_cancelled" },
    })

    const { stripe, create, retrieve } = makeStripeMock({
      retrieveResult: {
        id: "pi_paid_then_cancelled",
        client_secret: "secret",
        status: "succeeded",
      },
    })
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    expect(result).toEqual({
      ok: false,
      error: "支付已完成，但订单状态异常，请联系客服",
    })
    expect(retrieve).toHaveBeenCalledWith("pi_paid_then_cancelled")
    expect(create).not.toHaveBeenCalled()

    // 【这条是这条用例的重点】不做对账、不改状态。
    // 「要不要给一张已取消的订单发货」是客服的决定，不是这行代码的
    const saved = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, paidAt: true },
    })
    expect(saved.status).toBe(ORDER_STATUS.CANCELLED)
    expect(saved.paidAt).toBeNull()
  })

  it("已过支付时限 → 「订单已超过支付时限，请重新下单」", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, expiresAt: expiredAt() })

    const { stripe, create } = makeStripeMock()
    const result = await createPaymentIntentForOrder(stripe, order.id, userId)

    expect(result).toEqual({ ok: false, error: "订单已超过支付时限，请重新下单" })
    expect(create).not.toHaveBeenCalled()
  })
})
