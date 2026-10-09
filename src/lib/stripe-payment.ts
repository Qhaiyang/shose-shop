import type Stripe from "stripe"

import {
  canTransition,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  STRIPE_CURRENCY,
  type OrderStatus,
} from "@/lib/constants"
import { prisma } from "@/lib/prisma"

// ============================================================================
// 建 PaymentIntent：支付流程的「第二步前半段」
//
// 【它和 stripe-webhook.ts 是同一件事的两半】
//   - 本文件   ：用户点「去支付」→ 建（或复用）PaymentIntent，返回 clientSecret
//                给前端，前端拿它渲染 Stripe Elements 让用户填卡
//   - webhook  ：用户真的付了钱 → payment_intent.succeeded 进来 → 翻订单状态
//
// 中间那一步「用户填卡、点支付」发生在 Stripe 的页面里，我们完全不碰。
// 我们只负责「开个头」（建 PI）和「收个尾」（webhook 翻状态），
// 中间的钱是怎么收的、卡是怎么验证的，都是 Stripe 的事。
//
// 【为什么这个函数收一个注入的 Stripe 实例，而不是内部自己 getStripe()】
// 为了可测：集成测试传一个 mock 进来，就能验证「建了正确的 PI」、
// 「复用了而不是新建」这些逻辑，全程不发任何网络请求。
// 生产调用方（Server Action）传 getStripe()。
// ============================================================================

export type CreatePaymentIntentResult =
  | { ok: true; clientSecret: string }
  | { ok: false; error: string }

/**
 * 为一张订单建（或复用）PaymentIntent，返回 clientSecret。
 *
 * 【为什么这里有三个「读判断」，而 payOrder 里是「条件更新」】
 * payOrder 的目标是**翻状态**，所以判断必须写进 WHERE、靠影响行数反推。
 * 这里的目标只是「确认有没有资格付」，**不翻状态** —— 翻状态要等 webhook。
 * 所以是读出来、逐个判断、给用户一句能看懂的话。两者用途不同，
 * 但判断的条件（本人 / 待支付 / 没过时限）和文案必须一致，见下面各处注释。
 *
 * 【PaymentIntent 复用为什么是硬规则，不是优化】
 * 见 schema 里 Order.stripePaymentIntentId 的注释：如果第二次点「去支付」
 * 又建一个 PI，会把这一列覆盖成新的，而旧 PI 还活着 —— 它日后成功支付的
 * webhook 找不到归属（索引撒谎）。所以只要这一列有值，就 retrieve 它继续用，
 * 绝不新建。
 */
export async function createPaymentIntentForOrder(
  stripe: Stripe,
  orderId: string,
  userId: string,
): Promise<CreatePaymentIntentResult> {
  // 三个守卫之一：本人。userId 进 where，查别人的单直接落到「不存在」
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      totalAmount: true,
      status: true,
      expiresAt: true,
      stripePaymentIntentId: true,
    },
  })

  // 和 payOrder 同一句话：不泄露「这个订单号是否存在」
  if (!order) return { ok: false, error: "订单不存在" }

  const status = order.status as OrderStatus

  // 守卫之二：必须是待支付。文案和 payOrder 的「事后解释」对齐，
  // 让用户在两处看到的是同一种话
  if (status === ORDER_STATUS.PAID) {
    return { ok: false, error: "这笔订单已经支付过了" }
  }
  if (status === ORDER_STATUS.CANCELLED) {
    return { ok: false, error: "订单已取消，无法支付" }
  }
  if (!canTransition(status, ORDER_STATUS.PAID)) {
    return { ok: false, error: `订单当前是「${ORDER_STATUS_LABEL[status]}」，无法支付` }
  }

  // 守卫之三：没过支付时限。这里只拦「还没付就点」的用户，
  // 和 webhook 那边「钱已经收了就不拦」是两回事 —— 见 markOrderPaidFromStripe
  if (order.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "订单已超过支付时限，请重新下单" }
  }

  // ---- 复用 or 新建 ----
  let clientSecret: string | null

  if (order.stripePaymentIntentId) {
    // 复用：这个 PI 是之前那次「去支付」建的，金额不可能变
    // （订单创建后 totalAmount 就写死了），所以 retrieve 出来直接用
    const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId)
    clientSecret = pi.client_secret
  } else {
    const pi = await stripe.paymentIntents.create({
      // amount 就是订单的实付（分），CNY 最小单位就是分，直接传
      amount: order.totalAmount,
      currency: STRIPE_CURRENCY,
      automatic_payment_methods: { enabled: true },
      // webhook 靠它找回订单，见 stripe-webhook.ts 的 readOrderId
      metadata: { orderId },
    })

    clientSecret = pi.client_secret

    // 建完立刻写回，**不等 webhook**。不写的话，第二次点「去支付」
    // 又看到 null、又建一个 PI，就踩了上面「复用」注释里的那个坑
    await prisma.order.update({
      where: { id: orderId },
      data: { stripePaymentIntentId: pi.id },
    })
  }

  // client_secret 理论上可能为 null（比如 PI 已到终态），
  // 但刚建/刚 retrieve 的 PI 不该是这种状态 —— 兜一句，别让前端拿到 null
  if (!clientSecret) {
    return { ok: false, error: "支付初始化失败，请稍后重试" }
  }

  return { ok: true, clientSecret }
}
