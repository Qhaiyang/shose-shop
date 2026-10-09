import { createHmac } from "node:crypto"

// ============================================================================
// E2E 造「支付成功回调」的小工具
//
// 【为什么要手搓签名，而不 import stripe 的 generateTestHeaderString】
// 集成测试（tests/integration/stripe-webhook.test.ts）用的是 SDK 那个方法。
// 但 E2E 的 spec 跑在 Playwright 的 worker 进程里，会被转成 CommonJS 执行 ——
// 刚在 db-url.mjs 顶部记过一次：这个环境里 import ESM 形态的包会炸
// （import.meta 在 CJS 里是语法错误）。stripe 包正是 ESM 形态。
// 而签名本身只是 HMAC-SHA256，手算的字符串和 SDK 产出的**一模一样**，
// 没必要为此再把那个坑踩一遍。
// ============================================================================

/**
 * E2E 用的 webhook 签名密钥。
 *
 * 【为什么要求「签」和「验」用同一个值】
 * 签名是 HMAC，一边签、一边验，对不上就是 400。所以这个常量必须
 * 和 playwright.config.ts 注入给 dev server 的那个值一致 —— 两边都 import
 * 这一个常量，不许各写各的字符串（重复的字面量会在某次改动里悄悄对不上，
 * 而症状是「E2E 突然开始 400」，很难查）。
 *
 * 【为什么是个假密钥也够】
 * 验签是纯本地计算（HMAC），SDK 不校验密钥长什么样、也不发网络请求。
 * 所以这里用一个固定值等价于「测试环境的约定」，不涉及任何真实凭证。
 */
export const E2E_WEBHOOK_SECRET = "whsec_e2e_local_only"

/**
 * 算出「签」和「验」应当共用的那个密钥。
 *
 * 本地 .env 如果配了真密钥（跑 `stripe listen` 时 Stripe CLI 会打印一个），
 * 就沿用它；没配（CI 上根本没有 .env）就退回常量。
 *
 * 【为什么两端各算一次还是对得上】
 * 同一个表达式在两个进程里求值：config/worker 进程读的是 .env（有则用），
 * dev server 子进程拿的是 playwright.config.ts 显式传入的、由同一条式子算出的值。
 * 输入相同、规则相同，结果必然相同。
 */
export function e2eWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET ?? E2E_WEBHOOK_SECRET
}

/**
 * 造一个 Stripe `Stripe-Signature` 请求头的值。
 *
 * 格式：`t=<unix 秒>,v1=<hex HMAC-SHA256(secret, "<t>.<payload>")>`
 * —— 和 SDK 的 webhooks.generateTestHeaderString 完全一致。
 *
 * 【payload 必须是「最终发出去的那一串字符」】
 * route 层用 request.text() 拿原始字节验签。中途只要经过一次
 * JSON.parse → JSON.stringify，键顺序或空白就可能变，签名立刻对不上。
 * 所以调用方拿到 payload 之后必须原样发出去 —— 下面 paymentSucceededPayload
 * 返回的就是**字符串**，就是为了逼着调用方别再序列化一遍。
 */
export function stripeSignatureHeader(payload: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac("sha256", e2eWebhookSecret())
    .update(`${timestamp}.${payload}`)
    .digest("hex")
  return `t=${timestamp},v1=${signature}`
}

/**
 * 造一个 `payment_intent.succeeded` 事件的 payload（JSON 字符串）。
 *
 * 【为什么事件 id 每次都要不一样】
 * webhook_events 表按 (provider, eventId) 唯一。复用同一个 event.id，
 * 第二次投递会被当成「渠道重投」直接跳过 —— 订单永远翻不成 PAID，
 * 而测试表现是「webhook 返回 200，但状态没变」，很难查。
 */
export function paymentSucceededPayload(orderId: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return JSON.stringify({
    id: `evt_e2e_${stamp}`,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_e2e_${stamp}`,
        object: "payment_intent",
        metadata: { orderId },
      },
    },
  })
}
