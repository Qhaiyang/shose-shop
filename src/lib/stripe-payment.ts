import type Stripe from "stripe"

import {
  canTransition,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  STRIPE_CURRENCY,
  type OrderStatus,
} from "@/lib/constants"
import { markOrderPaidFromStripe } from "@/lib/orders"
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
// 【本文件还会做一件 webhook 的分内事：对账】
// 用户点「去支付」时我们会 retrieve 那个已有的 PI。如果发现它**已经成功了**
// 而订单还是待支付，说明 webhook 没送到或者还在路上 —— 这时候本文件会
// 直接调 markOrderPaidFromStripe 把订单补成已支付（见下面 succeeded 那一支）。
// 这不是「又写了一遍翻状态的逻辑」：同一个函数、同一份条件更新，
// webhook 那边日后重投时照样是幂等的。
//
// 【为什么这个函数收一个注入的 Stripe 实例，而不是内部自己 getStripe()】
// 为了可测：集成测试传一个 mock 进来，就能验证「建了正确的 PI」、
// 「复用了而不是新建」这些逻辑，全程不发任何网络请求。
// 生产调用方（Server Action）传 getStripe()。
// ============================================================================

export type CreatePaymentIntentResult =
  | { ok: true; clientSecret: string }
  /**
   * 钱其实早就收到了 —— 这次调用做的是「对账」而不是「建 PI」：
   * 订单已被推成已支付。**没有 clientSecret 可给**，前端不该弹收银台。
   *
   * 【为什么要单开一个变体，而不是塞个假 clientSecret 或复用 ok:false】
   * 复用 `ok:false` 的话，前端会弹一句「支付失败」—— 而事实正相反，钱收到了。
   * 给个空 clientSecret 更糟：收银台会渲染失败，又变回这一轮要修的那个 bug。
   */
  | { ok: true; orderPaid: true }
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
 * webhook 找不到归属（索引撒谎）。所以只要这一列有值，就 retrieve 它继续用。
 *
 * 【唯一的例外：旧 PI 已经 canceled】
 * 作废的 PI 复用不了（它的 clientSecret 初始化不了 Elements），钱也一分没收，
 * 这时候才新建，并用「旧值写进 WHERE」的条件更新把 id 换过去 ——
 * 两个标签页同时点到这一步时，只有一个能换成功。
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
    // 【取消这一支为什么要额外问一次 Stripe】
    // 「订单已取消」和「这笔钱收了没有」是两件事。订单可能是在用户**已经
    // 付完钱之后**才被超时扫描取消的（就是 webhook 那条 cancelled 边界的
    // 镜像场景）。这种情况下回一句「订单已取消，无法支付」是误导 ——
    // 用户真金白银付出去了，他需要的是「去联系客服」，不是「你付不了」。
    //
    // 只在「这单确实建过 PI」时才多花一次 retrieve：没建过 PI 的取消订单
    // 压根不可能收过钱，走下面那句就够了
    if (order.stripePaymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId)

      if (pi.status === "succeeded") {
        // 钱收了、单没了 —— 和 webhook 那边同一个口径：**不自动恢复**，
        // 只把事实说清楚，让用户去找人。擅自把取消的订单改回已支付，
        // 等于替客服做了一个「要不要发货」的决定
        return { ok: false, error: "支付已完成，但订单状态异常，请联系客服" }
      }
    }

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

  // 建 PI 的三个参数只写一处。金额/货币/metadata 任一填错都是「静默错」
  // （Stripe 收错的钱、webhook 回来找不到订单），所以不给它第二次写歪的机会。
  // 见本文件上方「钉住的三件事」
  //
  // 金额先落成一个常量再进闭包：函数声明会被提升，TS 不肯把上面那个
  // `if (!order) return` 的收窄带进去（它假定这个函数可能在收窄之前被调用）。
  // 顺带也把「用哪个金额」这件事钉在这一次读到的值上
  const totalAmount = order.totalAmount
  function createIntent() {
    return stripe.paymentIntents.create({
      // amount 就是订单的实付（分），CNY 最小单位就是分，直接传
      amount: totalAmount,
      currency: STRIPE_CURRENCY,
      automatic_payment_methods: { enabled: true },
      // webhook 靠它找回订单，见 stripe-webhook.ts 的 readOrderId
      metadata: { orderId },
    })
  }

  if (order.stripePaymentIntentId) {
    // 复用：这个 PI 是之前那次「去支付」建的，金额不可能变
    // （订单创建后 totalAmount 就写死了），所以 retrieve 出来直接用
    const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId)

    if (pi.status === "succeeded") {
      // 【钱已经收了，订单却还是待支付 —— webhook 没送到，或者还在路上】
      //
      // 这里有两个「绝对不能做」：
      //   1. 不能新建 PI —— 用户会二次付款
      //   2. 不能把这个 PI 的 clientSecret 交给前端 —— **终态的 PI 初始化不了
      //      Elements**。Stripe 会抛 loaderror（"This PaymentIntent is in a
      //      terminal state and cannot be used to initialize Elements"），
      //      界面上表现为「对话框空白、点支付报 IntegrationError」。
      //      这就是这一轮要修的那个 bug 的根因
      //
      // 该做的是补一次 webhook 本来要做的事：调同一个 markOrderPaidFromStripe。
      // webhook 日后重投时 claimOrderPaid 是条件更新（WHERE status =
      // PENDING_PAYMENT），第二次会返回 already_paid，不会重复推、也不会重复扣
      const outcome = await markOrderPaidFromStripe(prisma, orderId)

      if (outcome === "applied" || outcome === "already_paid") {
        return { ok: true, orderPaid: true }
      }

      // 对不上账 —— 极小概率是「刚读完订单就被超时扫描取消了」。
      // 和上面 CANCELLED 那一支同一句话：钱收了但落不到正常订单上，请人处理
      return { ok: false, error: "支付已完成，但订单状态异常，请联系客服" }
    }

    if (pi.status === "canceled") {
      // 旧 PI 作废了、一分钱没收 —— 复用它没有任何意义（它的 clientSecret
      // 同样初始化不了 Elements）。新建一个，并把 id 换过去。
      //
      // 【为什么是条件更新，而不是直接 update】
      // 两个标签页同时点到这一步时，两边都会拿到同一个 canceled 的旧 PI、
      // 都想建新的。不加条件的话，后写的那个会覆盖先写的，先建出来那个 PI
      // 就再没人引用了 —— 它日后成功支付的 webhook 找不到归属，
      // 正是 Order.stripePaymentIntentId 那列注释里说的「索引撒谎」。
      // 把旧值写进 WHERE，只有一个能换成功；没抢到的那个回到「复用」的语义
      const fresh = await createIntent()

      const swapped = await prisma.order.updateMany({
        // 旧值是这次会话开头读到的那个，不是重读的 —— 重读就丢了这层条件
        where: { id: orderId, stripePaymentIntentId: order.stripePaymentIntentId },
        data: { stripePaymentIntentId: fresh.id },
      })

      if (swapped.count === 1) {
        clientSecret = fresh.client_secret
      } else {
        // 没抢到：另一个请求已经换成了它建的那个，复用它，**不重建**
        const winnerId = (
          await prisma.order.findUniqueOrThrow({
            where: { id: orderId },
            select: { stripePaymentIntentId: true },
          })
        ).stripePaymentIntentId

        // 抢不到只可能是别人写了个新值进来，所以这里不该是 null ——
        // 但真要是 null 也不能把 undefined 当成 clientSecret 发出去
        if (!winnerId) {
          return { ok: false, error: "支付初始化失败，请稍后重试" }
        }

        const winner = await stripe.paymentIntents.retrieve(winnerId)
        clientSecret = winner.client_secret
      }
    } else {
      clientSecret = pi.client_secret
    }
  } else {
    const pi = await createIntent()

    clientSecret = pi.client_secret

    // 建完立刻写回，**不等 webhook**。不写的话，第二次点「去支付」
    // 又看到 null、又建一个 PI，就踩了上面「复用」注释里的那个坑
    await prisma.order.update({
      where: { id: orderId },
      data: { stripePaymentIntentId: pi.id },
    })
  }

  // 【这个兜底为什么还留着，但理由要改】
  // 原来这里写的是「client_secret 理论上可能为 null（比如 PI 已到终态）」
  // —— 那句话是**反的**。实测本账号 + API 2026-09-30.endive 的六种状态
  // （requires_payment_method / requires_confirmation / requires_action /
  // requires_capture / succeeded / canceled），client_secret **全都不是 null**。
  // 也就是说「PI 到终态」并不等于「拿不到 clientSecret」，原来那句注释想拦的
  // 情况从来没被拦住 —— 上面 succeeded / canceled 两支就是它漏掉的。
  //
  // 之所以不删：Stripe SDK 把这一列声明成 `string | null`，官方文档也没有
  // 正面列出「什么状态下为 null」。证不出「不存在这种状态」，就留着当类型防线，
  // 只是别再拿「终态」当理由
  if (!clientSecret) {
    return { ok: false, error: "支付初始化失败，请稍后重试" }
  }

  return { ok: true, clientSecret }
}
