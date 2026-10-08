import type Stripe from "stripe"

// 和 orders.ts 一样要的是**值**导入：下面判断唯一约束冲突时用 instanceof，
// 而 instanceof 的右边必须是一个运行时的类
import { Prisma } from "@/generated/prisma/client"
import { markOrderPaidFromStripe } from "@/lib/orders"
import { prisma } from "@/lib/prisma"
import { getStripe } from "@/lib/stripe"

// ============================================================================
// Stripe webhook 的业务层
//
// 【为什么这一层和 HTTP 层（app/api/webhooks/stripe/route.ts）要分开】
// 验签、取原始 body、决定返回什么状态码 —— 那些是 HTTP 的事。
// 「这个事件该干什么」是业务的事。分开之后，业务逻辑可以直接被集成测试
// 调用（不用起 HTTP、不用真的发请求），四条边界才测得起。
//
// 【这个文件属于项目里的「第一个无 session 入口」】
// 它不认 cookie，也不该认 —— 请求来自 Stripe 的服务器，不是浏览器。
// 它唯一的身份验证是**签名**，见下面 constructEvent 那一段。
// 所以千万不要在这里加 getCurrentUser()/requireAdmin()：那些函数会从
// cookie 里找不到人，直接把请求拦死。签名就是这个入口的鉴权。
// ============================================================================

/** 这张表里 provider 列的取值。create 和 findUnique 必须用同一个，所以提出来 */
const PROVIDER = "stripe"

/**
 * 我们真正要处理的事件类型。不在这个集合里的一律「记一笔、返回 200」。
 *
 * 【为什么列成白名单而不是黑名单】
 * 渠道方会不断加新的事件类型，黑名单意味着「默认处理」—— 一个我们不认识
 * 的事件会被当成需要处理的，然后要么报错、要么误改数据。
 * 白名单反过来：不认识的默认忽略，安全那一侧才是默认值。
 *
 * 这一轮只做支付成功。退款仍走项目里手写的那套（src/lib/refunds-db.ts），
 * 不接 Stripe 的退款 API。
 */
const HANDLED_EVENT_TYPES: readonly string[] = ["payment_intent.succeeded"]

/**
 * 一次回调的结局。
 *
 * 【为什么 cancelled / not_found / unlinked 也算「处理完了」】
 * 它们的 HTTP 答案都是 200，因为**我们确实收到了、也确实按规则处理了**——
 * 处理的内容就是「不改订单、记一行等人看」。
 * 返回非 2xx 只会让 Stripe 重投到三天以后，而重投一百次结局都一样。
 * 真正需要重试的是「我们自己这边出了问题」（数据库连不上），那是另一类。
 */
export type WebhookOutcome =
  /** 订单被推成了已支付 */
  | "applied"
  /** 订单早就在收款之后的状态了，无事可做 */
  | "already_paid"
  /** 订单已被超时取消，钱却收了 —— 需要人处理 */
  | "cancelled"
  /** metadata 指向的订单不存在 —— 需要人处理 */
  | "not_found"
  /** 事件里没带我们需要的 orderId（metadata 缺失）—— 需要人处理 */
  | "unlinked"
  /** 事件类型不在白名单里，故意忽略 */
  | "ignored"
  /** 这个 event.id 之前已经处理过（渠道重投，或并发投递） */
  | "duplicate"

/** 失败的类型。route 层靠它决定 HTTP 状态码 */
export type WebhookFailureReason =
  | "not_configured" // 服务端没配 webhook 密钥 —— 我们的问题，500
  | "bad_signature" // 验签没过 —— 400，且一个字节都不写库
  | "processing_failed" // 数据库/未知错误 —— 500，这个**应该**让渠道重试

export type WebhookResult =
  | { ok: true; outcome: WebhookOutcome }
  | { ok: false; reason: WebhookFailureReason; error: string }

/**
 * 处理一次 Stripe 回调。
 *
 * @param rawBody   请求的**原始字节**（字符串形式）。必须是原始的，
 *                  不能是 JSON.parse 之后再 stringify 回来的 —— 理由见下面注释
 * @param signature `stripe-signature` 请求头的值
 */
export async function handleStripeWebhook(
  rawBody: string,
  signature: string,
): Promise<WebhookResult> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  // 没配密钥就直接拒。不做「没配就不校验」的妥协 ——
  // 那种写法一旦被带到生产环境，就是一个谁都能调、还能改订单状态的接口
  if (!secret) {
    console.error("[stripe-webhook] 未配置 STRIPE_WEBHOOK_SECRET，拒绝处理")
    return {
      ok: false,
      reason: "not_configured",
      error: "服务端未配置 STRIPE_WEBHOOK_SECRET",
    }
  }

  let event: Stripe.Event

  try {
    // 【验签必须拿原始 body，这就是它要字符串而不是对象的原因】
    // 签名是对**原始字节**做的 HMAC。JSON.parse 再 JSON.stringify 回来的
    // 字符串不保证和原始字节一致（键的顺序、空白、\uXXXX 的转义方式都可能变），
    // 拿它去验签会莫名其妙地失败。
    //
    // 【顺序也不能颠倒】必须先验签、后 parse。反过来就等于
    // 「先把不可信的数据解析了，再问它是不是可信的」——
    // 解析本身就可能踩到恶意构造的输入。
    //
    // constructEvent 同时校验两件事：签名对不对、时间戳在不在容忍窗口内
    // （防重放，默认 5 分钟）
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret)
  } catch (error) {
    // 验签失败：**一个字节都不写库**。绝不能因为「这个入口没有 session 鉴权」
    // 就在验签上放松 —— 验签就是这个入口的鉴权，放松等于门开着
    console.error(
      "[stripe-webhook] 验签失败:",
      error instanceof Error ? error.message : error,
    )
    return { ok: false, reason: "bad_signature", error: "签名验证失败" }
  }

  const handled = HANDLED_EVENT_TYPES.includes(event.type)
  // 不处理的事件类型就不去读 metadata 了 —— 那是业务字段，
  // 跟我们有没有处理这个事件无关
  const orderId = handled ? readOrderId(event) : null

  return processEvent(event, orderId, handled)
}

/**
 * 从事件里取出我们的订单 id。
 *
 * 【为什么订单 id 在 metadata 里，而不是渠道直接给】
 * Stripe 只知道它自己那个 PaymentIntent（pi_xxx），不知道我们的订单。
 * 所以创建 PaymentIntent 时要把订单 id 写进 metadata（第二步的事），
 * 回调再从 metadata 里读回来。两边用同一个字段名，改一处就得改两处
 * —— 所以第二步实现时，这个字符串两边都别硬编码，import 同一个常量。
 */
function readOrderId(event: Stripe.Event): string | null {
  // 事件类型已经把我们限定在 PaymentIntent 相关的事件上了，
  // 但 SDK 的 event.data.object 是一个大联合类型，这里显式收窄
  const intent = event.data.object as Stripe.PaymentIntent
  const orderId = intent.metadata?.orderId

  return typeof orderId === "string" && orderId !== "" ? orderId : null
}

/**
 * 认领事件 + 落地 + 写下判决，全部在一笔事务里。
 *
 * 【为什么三件事必须同一个事务】
 * 见 markOrderPaidFromStripe 的注释：记了「事件已处理」却没改成订单，
 * 这个事件以后重投时会被幂等直接跳过，订单就永远停在待支付。
 * 那是静默丢单，比报错难查得多。
 *
 * 【为什么要「先认领、再干活」】
 * 认领（插 webhook_events 那一行）会撞唯一约束，所以顺序放在最前面，
 * 并发的第二个投递会在这一步就失败退出，不用白做后面的订单更新。
 * 这也是唯一约束在这里的真正用途：它不是「防止插两行」，而是**并发闸门**。
 */
async function processEvent(
  event: Stripe.Event,
  orderId: string | null,
  handled: boolean,
): Promise<WebhookResult> {
  // 用「收到的那一刻」当一个统一的时间戳：事件行的 receivedAt、
  // 订单的 paidAt、以及判决时间，都取这一次，保证它们自洽
  const receivedAt = new Date()

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // ---- 1. 认领 ----
      // 并发的第二个投递会在这里抛 P2002，整个事务回滚，由下面的 catch 处理
      const claim = await tx.webhookEvent.create({
        data: {
          provider: PROVIDER,
          eventId: event.id,
          type: event.type,
          orderId,
          receivedAt,
        },
        select: { id: true },
      })

      // ---- 2. 落地 ----
      let outcome: WebhookOutcome

      // appliedAt 的语义是「这行记录让订单状态发生变化了吗」，不是
      // 「处理完了吗」。所以它只有两种结局：要么有值（自洽，不用管），
      // 要么为空（钱和订单对不上，等人处理）
      let appliedAt: Date | null = null

      if (!handled) {
        // 不认识的事件类型：记一笔就够了。appliedAt 给值 ——
        // 它是被**故意**跳过的，不需要任何人来看
        outcome = "ignored"
        appliedAt = receivedAt
      } else if (!orderId) {
        // metadata 里没有 orderId：留痕，但不标 applied。
        // 我们根本不知道这笔钱对应谁，只能等人来认
        outcome = "unlinked"
      } else {
        outcome = await markOrderPaidFromStripe(tx, orderId, receivedAt)

        // applied / already_paid 都是「钱和订单对得上」；
        // cancelled / not_found 是「钱收了但没落到一个正常订单上」——
        // 后者故意让 appliedAt 空着，它就是告警口径
        if (outcome === "applied" || outcome === "already_paid") {
          appliedAt = receivedAt
        }
      }

      // ---- 3. 写判决 ----
      // 和上面两步同一笔事务。所以崩溃时这一整行会消失，不会留下
      // 一行「认领了但没判决」的中间态 —— 见 schema 里 appliedAt 的注释
      await tx.webhookEvent.update({
        where: { id: claim.id },
        data: { appliedAt },
      })

      return outcome
    })

    // 这三种是「钱收了但没能落到订单上」，是这一轮唯一的告警出口。
    // 练手项目没有告警系统，所以至少要在日志里留下一条显眼的记录
    if (outcome === "cancelled" || outcome === "not_found" || outcome === "unlinked") {
      console.error(
        `[stripe-webhook] 收到了钱但没能落到订单上：outcome=${outcome} ` +
          `type=${event.type} event=${event.id} ` +
          `orderId=${orderId ?? "(metadata 里没有)"}` +
          (orderId ? " —— 查 /api/health 的 orphanedWebhooks" : ""),
      )
    }

    return { ok: true, outcome }
  } catch (error) {
    // ---- 唯一约束冲突：这个事件已经处理过了 ----
    //
    // 【怎么区分「撞的是不是 webhook_events 那条唯一约束」】
    // 不要去扒 error.meta.target —— Prisma 7 的 P2002 里只有
    // { driverAdapterError, table }，没有 target，那个写法恒为 false
    // （上一步在 products.ts 里刚修过一个同款的死代码）。
    // 判据直接用一次查询：按 (provider, eventId) 查得到，就是这个事件
    // 已经处理过；查不到，说明撞的是别的约束，落到下面按真失败处理
    //
    // 【这条判据目前没有测试覆盖 —— 记下来，别当成「有测试护着」】
    // 这事务里眼下只有一个唯一约束能撞（webhook_events(provider, eventId)，
    // 因为 markOrderPaidFromStripe 走的是 updateMany，不碰唯一约束）。
    // 也就是说：现在把下面这个 findUnique 换成「任何 P2002 都直接 return
    // duplicate」，全部用例照样绿 —— 「查一次」和「无脑吞掉」在测试里
    // 区分不开。这是**已知的未覆盖**，不是漏了。
    //
    // 所以：将来若在这笔事务里加了第二个唯一约束，**必须**补一条用例。
    // 否则「任何 P2002 都当重投」会把那种本该 500、让渠道重试的故障，
    // 静默吞成一个 200 的「处理过了」—— 故障消失得无声无息
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: PROVIDER, eventId: event.id } },
        select: { id: true },
      })

      // 返回 200：渠道要的就是「别重投了」，而这一单确实已经处理过
      if (existing) return { ok: true, outcome: "duplicate" }
    }

    // 其他错误（数据库连不上、写库失败……）是我们这边的问题，
    // 返回 500 让渠道重试 —— 这是它该重试的唯一一类
    console.error("[stripe-webhook] 处理失败:", error)
    return {
      ok: false,
      reason: "processing_failed",
      error: error instanceof Error ? error.message : "未知错误",
    }
  }
}
