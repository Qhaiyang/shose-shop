import Stripe from "stripe"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { GET as healthRoute } from "@/app/api/health/route"
import { POST as stripeWebhookRoute } from "@/app/api/webhooks/stripe/route"
import { ORDER_STATUS } from "@/lib/constants"
import { payOrder } from "@/lib/orders"
import { handleStripeWebhook } from "@/lib/stripe-webhook"
import {
  expiredAt,
  makeOrder,
  makeShop,
  prisma,
  resetDb,
  resetSeq,
  statusOf,
} from "./helpers/db"

// ============================================================================
// 支付网关回调（Stripe webhook）
//
// 【这个文件要钉住的是四件事，不是「能不能跑通」】
// 一条 happy path 谁都会写，而回调这种东西真正会出事的地方全在边界上：
//
//   1. 渠道**重投**同一个事件（它是至少一次投递，不是恰好一次）
//   2. 同一张订单的**第二个**事件到达（不能被误判成重投）
//   3. 订单已经被超时取消之后，钱才到（钱收了、单没了）
//   4. 事件里**没有**我们的订单号（metadata 缺失或指向不存在的单）
//
// 这四条里任何一条错了，症状都是「静默的」—— 没有异常、没有报错，
// 只有钱和订单对不上。所以每一条都要有一个把它逼出来的用例。
//
// 【为什么签名要真的算，而不是把验签 mock 掉】
// 验签是这个入口**唯一的鉴权**（它不认 cookie）。把它 mock 掉，等于
// 把唯一的门拆了再测门锁。Stripe 官方给了
// generateTestHeaderString 用来造签名合法的假事件，
// 于是「用真签名」和「不依赖真实账号」可以同时成立。
// ============================================================================

const WEBHOOK_SECRET = "whsec_integration_test_secret"

/**
 * 专门用来**造签名**的实例，和 src/lib/stripe.ts 里那个是两个。
 *
 * 【为什么故意不复用 getStripe()】
 * 签名和验签用的是同一个 HMAC 算法，一边用 A 实例签、另一边用 B 实例验，
 * 能顺带证明这两个实例是互通的（都按同一套算法来）。
 * 用一个实例签、同一个实例验，反而把「实现是否一致」这个问题绕过去了。
 *
 * 密钥随便给一个：generateTestHeaderString 和 constructEvent 都是
 * 纯本地计算，不发任何网络请求，SDK 也不会去校验这个 key 长什么样。
 */
const signingStripe = new Stripe("sk_test_dummy_for_signing_only")

/** 测试自己设环境变量，不去改 vitest 的测试配置 */
const ORIGINAL_ENV = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
}

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_for_verifying_only"
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
})

afterAll(() => {
  // 环境变量是进程级的，还原掉 —— 不还原会漏给同一进程里后面跑的测试文件。
  // 用的是「设回原值，原来是没设就删掉」，不是无脑 delete
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

// ---------------------------------------------------------------------------
// 造事件
// ---------------------------------------------------------------------------

/**
 * 造一个 payment_intent.succeeded 事件。
 *
 * 【为什么手搓事件对象，而不是用一个真事件的 JSON 快照】
 * constructEvent 只做两件事：验签、把 body 解析成对象。它**不校验**
 * 事件的结构。所以只要验签能过，事件里缺字段是会一路走到业务代码里的 ——
 * 而「事件里缺字段」正是我们想测的东西（metadata 缺失那条）。
 * 手搓能精确控制每一个字段，快照则会被无关字段淹没。
 */
function succeededEvent(options: {
  eventId?: string
  /** 不传 / 传 null 表示「事件里没有 orderId」*/
  orderId?: string | null
  paymentIntentId?: string
}) {
  const metadata: Record<string, string> = {}
  if (options.orderId) metadata.orderId = options.orderId

  return {
    id: options.eventId ?? "evt_test_default",
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: options.paymentIntentId ?? "pi_test_default",
        object: "payment_intent",
        metadata,
      },
    },
  }
}

/** 把事件变成「签名合法的请求」：payload + signature 头 */
function sign(event: unknown): { payload: string; signature: string } {
  const payload = JSON.stringify(event)
  const signature = signingStripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  })
  return { payload, signature }
}

/** 直接调 HTTP 层，验证真实的入口（含「原始 body」这一步）和状态码 */
async function postToRoute(payload: string, signature: string | null) {
  const headers: Record<string, string> = {}
  if (signature !== null) headers["stripe-signature"] = signature

  const request = new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers,
    body: payload,
  })

  const response = await stripeWebhookRoute(request)
  return { status: response.status, body: await response.json() }
}

/**
 * 读真实的健康检查接口，拿「钱收了但没落到订单上」的计数。
 *
 * 【为什么要调接口而不是自己写一遍 count】
 * 自己写一遍的话，测的是「我以为的口径」，而不是**实际暴露出去**的口径。
 * 这个计数是这一轮唯一的告警出口，它必须被真的走一遍
 */
async function orphanedWebhooks(): Promise<number> {
  const response = await healthRoute()
  const body = (await response.json()) as { orphanedWebhooks: number }
  return body.orphanedWebhooks
}

// ---------------------------------------------------------------------------
// 正常路径（后面那些边界都是相对它说的）
// ---------------------------------------------------------------------------

describe("支付成功回调", () => {
  it("订单是待支付 → 推成已支付，并记一行已消化的事件", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    const { payload, signature } = sign(succeededEvent({ orderId: order.id }))
    const result = await handleStripeWebhook(payload, signature)

    expect(result).toEqual({ ok: true, outcome: "applied" })
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)

    const row = await prisma.webhookEvent.findFirstOrThrow({
      where: { orderId: order.id },
    })
    expect(row.type).toBe("payment_intent.succeeded")
    // appliedAt 有值 = 这行记录让订单状态真的变了
    expect(row.appliedAt).not.toBeNull()
    // 正常路径不是告警，计数必须是 0
    expect(await orphanedWebhooks()).toBe(0)
  })

  it("订单已过支付时限、但 cron 还没扫走 → 用户付不了，回调却必须收下", async () => {
    // 【这条用例钉的是两个函数的唯一差别】
    // payOrder 的 WHERE 里有 expiresAt > now，回调没有 —— 理由见
    // src/lib/orders.ts 里 markOrderPaidFromStripe 的注释。
    // 两边行为不同是**故意的**，所以要用一条用例把它固定下来：
    // 哪天有人把这两条路径合并成一个「带开关的函数」，这条会立刻红
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, expiresAt: expiredAt() })

    // 用户点「去支付」：被时限挡住，订单原样不动
    const payResult = await payOrder(order.id, userId)
    expect(payResult.ok).toBe(false)
    expect(payResult.ok === false && payResult.error).toContain("支付时限")
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)

    // 回调到了：钱已经在渠道那边收了，必须收下。
    // 此刻库存还锁着（cron 没扫到），收下不亏
    const { payload, signature } = sign(succeededEvent({ orderId: order.id }))
    const result = await handleStripeWebhook(payload, signature)

    expect(result).toEqual({ ok: true, outcome: "applied" })
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)
  })
})

// ---------------------------------------------------------------------------
// 边界 1：重投
// ---------------------------------------------------------------------------

describe("边界：渠道重投同一个事件", () => {
  it("同一个事件投递两次 → 只处理一次，第二次判为重投，paidAt 不被覆盖", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    const request = sign(
      succeededEvent({ eventId: "evt_repeat_1", orderId: order.id }),
    )

    const first = await handleStripeWebhook(request.payload, request.signature)
    expect(first).toEqual({ ok: true, outcome: "applied" })

    const paidAtAfterFirst = (
      await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { paidAt: true },
      })
    ).paidAt

    const second = await handleStripeWebhook(request.payload, request.signature)

    // 【第二条为什么不是 "applied" 也不是报错】
    // 它是同一个 event.id 的第二次投递，我们确实处理过了 ——
    // 返回 200 让渠道别再重投，同时如实说出来这是重投
    expect(second).toEqual({ ok: true, outcome: "duplicate" })

    // 只落了一行事件记录
    expect(await prisma.webhookEvent.count()).toBe(1)
    // 支付时间没有被第二次「刷新」—— 这是「真的只处理了一次」的硬证据，
    // 光看状态是 PAID 说明不了（第二次就算改一遍也还是 PAID）
    const paidAtAfterSecond = (
      await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { paidAt: true },
      })
    ).paidAt
    expect(paidAtAfterSecond?.getTime()).toBe(paidAtAfterFirst?.getTime())
  })

  it("同一个事件并发投递 5 次 → 只有一个进库，其余都是重投", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    const request = sign(
      succeededEvent({ eventId: "evt_concurrent_1", orderId: order.id }),
    )

    // 【为什么非要并发跑一遍】
    // 上面那条是「先 A 后 B」的确定顺序，走的是早查/唯一约束里的某一条。
    // 真正要证明的是：两个请求同时在途时，唯一约束这道闸门管用 ——
    // 也就是扣一次钱、记一行日志，而不是记两行
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        handleStripeWebhook(request.payload, request.signature),
      ),
    )

    expect(await prisma.webhookEvent.count()).toBe(1)

    const applied = results.filter((r) => r.ok && r.outcome === "applied")
    const duplicate = results.filter((r) => r.ok && r.outcome === "duplicate")
    const failed = results.filter((r) => !r.ok)

    expect(applied).toHaveLength(1)
    expect(duplicate).toHaveLength(4)
    expect(failed).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 边界 2：同一张订单的第二个事件（不是重投）
// ---------------------------------------------------------------------------

describe("边界：同一张订单的多个事件", () => {
  it("第二个事件不会被误判成重投 —— 幂等的键是 event.id，不是订单状态", async () => {
    // 【这条是「事件级幂等」和「状态机」的分界线】
    // 如果拿订单状态当幂等判据（「已经是 PAID 了？那一定是重投」），
    // 那么同一张单的第二个事件会被当成重投丢掉。
    // 渠道对同一个 PaymentIntent 会发多个事件，顺序还不保证 ——
    // 所以判据必须是 event.id，见 schema 里 WebhookEvent.eventId 的注释
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    const first = sign(
      succeededEvent({ eventId: "evt_multi_a", orderId: order.id }),
    )
    const second = sign(
      succeededEvent({ eventId: "evt_multi_b", orderId: order.id }),
    )

    expect(await handleStripeWebhook(first.payload, first.signature)).toEqual({
      ok: true,
      outcome: "applied",
    })

    // 第二个事件到达时订单已经是 PAID —— 但它**不是**重投
    expect(await handleStripeWebhook(second.payload, second.signature)).toEqual({
      ok: true,
      outcome: "already_paid",
    })

    // 两个事件各记一行，谁也没被吞掉
    expect(await prisma.webhookEvent.count()).toBe(2)
    // 两张行都算「消化完了」，不产生告警
    expect(await orphanedWebhooks()).toBe(0)
  })

  it("不认识的事件类型 → 记一行、不动订单，返回 200", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    // 退款这一轮仍走项目里手写的那套，所以 charge.refunded 落在白名单外。
    // 它不该被处理，但也不该被丢掉 —— 记一笔，将来排查时有据可查
    const event = {
      ...succeededEvent({ orderId: order.id }),
      id: "evt_ignored_1",
      type: "charge.refunded",
    }
    const { payload, signature } = sign(event)

    const result = await handleStripeWebhook(payload, signature)

    expect(result).toEqual({ ok: true, outcome: "ignored" })
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)

    const row = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: "evt_ignored_1" },
    })
    // 不处理的事件类型就不去读它的 metadata，所以 orderId 是空的
    expect(row.orderId).toBeNull()
    // 但它是被**故意**跳过的，算消化完了 —— 不该占用告警口径
    expect(row.appliedAt).not.toBeNull()
    expect(await orphanedWebhooks()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 边界 3：钱收了，单却已经没了
// ---------------------------------------------------------------------------

describe("边界：订单已被超时取消之后，支付成功才到", () => {
  it("不改订单状态、留一行痕，并被健康检查计数抓住", async () => {
    // 【这是整个文件最需要有人看到的一种结局】
    // 订单被 cron 取消时，库存已经还回池子（可能已经被别人买走）、
    // 券也退给用户了，而钱在渠道那边是真的扣了。
    // 这一轮的处理是「拒收 + 留痕」：
    //   拒收 —— 不动订单状态。从 CANCELLED 恢复成 PAID 要重扣一次库存，
    //           而库存可能已经卖掉了，那就是超卖；扣不到又只能退回留痕，
    //           等于多写一段走不通的代码（见 orders.ts 的注释）
    //   留痕 —— appliedAt 空着 + orderId 关联上，让健康检查能数出来
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, status: ORDER_STATUS.CANCELLED })

    const { payload, signature } = sign(
      succeededEvent({ eventId: "evt_orphan_1", orderId: order.id }),
    )
    const result = await handleStripeWebhook(payload, signature)

    expect(result).toEqual({ ok: true, outcome: "cancelled" })
    // 订单状态一个字都没动
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.CANCELLED)

    const row = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: "evt_orphan_1" },
    })
    expect(row.orderId).toBe(order.id)
    // 这就是告警：appliedAt 空 + orderId 有值 = 有主的钱没对上账
    expect(row.appliedAt).toBeNull()

    // 真实的健康检查接口要能把它数出来
    expect(await orphanedWebhooks()).toBe(1)
  })

  it("重复投递这条「异常」事件时，计数不会被加两次", async () => {
    // 告警口径本身也要幂等，否则一个被重投三次的异常会显示成三个问题
    const { userId } = await makeShop()
    const order = await makeOrder({ userId, status: ORDER_STATUS.CANCELLED })

    const request = sign(
      succeededEvent({ eventId: "evt_orphan_repeat", orderId: order.id }),
    )

    await handleStripeWebhook(request.payload, request.signature)
    const second = await handleStripeWebhook(request.payload, request.signature)

    expect(second).toEqual({ ok: true, outcome: "duplicate" })
    expect(await prisma.webhookEvent.count()).toBe(1)
    expect(await orphanedWebhooks()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 边界 4：事件里没有我们的订单号
// ---------------------------------------------------------------------------

describe("边界：事件里找不到订单", () => {
  it("metadata 里没有 orderId → 记一行、返回 200，订单不受影响", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    // 不传 orderId = 事件里 metadata 是空的
    const { payload, signature } = sign(
      succeededEvent({ eventId: "evt_unlinked_1", orderId: null }),
    )
    const result = await handleStripeWebhook(payload, signature)

    // 200：收到了、也确实按规则处理了（处理的内容就是「记一笔等人看」）。
    // 返回非 2xx 只会让渠道重投到三天以后，而结局一模一样
    expect(result).toEqual({ ok: true, outcome: "unlinked" })
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)

    const row = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: "evt_unlinked_1" },
    })
    // 没有 orderId —— 我们根本不知道这笔钱是谁的
    expect(row.orderId).toBeNull()
    expect(row.appliedAt).toBeNull()
    // 【不计入告警口径】健康检查数的是「有主的钱没对上账」，
    // orderId 为空说明连主都找不到，它进不了那个查询（这是有意的）
    expect(await orphanedWebhooks()).toBe(0)
  })

  it("metadata 指向一个不存在的订单 → 留痕，且计入告警", async () => {
    const { payload, signature } = sign(
      succeededEvent({ eventId: "evt_ghost_1", orderId: "no-such-order-id" }),
    )
    const result = await handleStripeWebhook(payload, signature)

    expect(result).toEqual({ ok: true, outcome: "not_found" })

    const row = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: "evt_ghost_1" },
    })
    // 这里和上面那条不同：orderId 有值（是事件里给的那个），
    // 说明确实有一笔钱指着一个「本该存在」的订单 —— 这是要人看的
    expect(row.orderId).toBe("no-such-order-id")
    expect(row.appliedAt).toBeNull()
    expect(await orphanedWebhooks()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 鉴权：签名验证
// ---------------------------------------------------------------------------

describe("鉴权：验签失败必须直接拒", () => {
  it("签名用的是别的密钥 → 400，且一个字节都不写库", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    const { payload } = sign(succeededEvent({ orderId: order.id }))
    const wrongSignature = signingStripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_a_completely_different_secret",
    })

    const { status } = await postToRoute(payload, wrongSignature)

    expect(status).toBe(400)
    // 【这一句是这个用例真正的重点】
    // 没有 session 鉴权的入口，唯一的门就是签名。验签没过还能写库，
    // 就等于任何人都能伪造一个「已支付」出来
    expect(await prisma.webhookEvent.count()).toBe(0)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })

  it("body 被改过 → 400（签名是对原始字节算的）", async () => {
    // 【为什么这条要单独测】
    // 签名只覆盖原始字节。如果实现里先 json() 再重新序列化，
    // 或者验签用的不是原始 body，这类「签名本身合法但内容被换过」
    // 的请求就会漏过去
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    const { signature } = sign(succeededEvent({ orderId: order.id }))
    // 用合法的签名，配一个**改过的** body
    const tampered = JSON.stringify(
      succeededEvent({ orderId: order.id, paymentIntentId: "pi_tampered" }),
    )

    const { status } = await postToRoute(tampered, signature)

    expect(status).toBe(400)
    expect(await prisma.webhookEvent.count()).toBe(0)
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })

  it("缺 stripe-signature 头 → 400", async () => {
    const { payload } = sign(succeededEvent({ orderId: "whatever" }))

    const { status } = await postToRoute(payload, null)

    expect(status).toBe(400)
    expect(await prisma.webhookEvent.count()).toBe(0)
  })

  it("没配 STRIPE_WEBHOOK_SECRET → 500（配置问题，不是 400）", async () => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    delete process.env.STRIPE_WEBHOOK_SECRET

    try {
      const { payload, signature } = sign(succeededEvent({ orderId: "x" }))
      const { status } = await postToRoute(payload, signature)

      // 没配密钥是我们这边的故障，不该谎报成「你的请求不合法」。
      // 也不做「没配就不校验」的妥协 —— 那就成了一个敞开的写接口
      expect(status).toBe(500)
      expect(await prisma.webhookEvent.count()).toBe(0)
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = secret
    }
  })

  it("签名合法时，HTTP 层返回 200 并带上结局", async () => {
    const { userId } = await makeShop()
    const order = await makeOrder({ userId })

    const { payload, signature } = sign(
      succeededEvent({ eventId: "evt_via_route", orderId: order.id }),
    )
    const { status, body } = await postToRoute(payload, signature)

    expect(status).toBe(200)
    expect(body).toEqual({ received: true, outcome: "applied" })
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PAID)
  })
})
