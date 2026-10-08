import { NextResponse } from "next/server"

import { handleStripeWebhook } from "@/lib/stripe-webhook"

// ============================================================================
// Stripe webhook 入口 —— 项目里第一个「无 session」的公网 POST 接口
//
// 【为什么是 Route Handler，而不是 Server Action】
// Server Action 的传输协议是 Next 私有的：字段名会被编码成 `_1_xxx`
// 那种形式，请求体也是特殊编码的，还要带 next-action 头，并且有
// Origin/CSRF 校验。这些 Stripe 一样都不会做 —— 它发的是普普通通的
// POST + stripe-signature 头。用 Server Action 写，这个接口永远收不到东西。
//
// 【为什么不用 requireUser / requireAdmin 做鉴权】
// 那些函数从 cookie 里读会话，而请求来自 Stripe 的服务器，没有 cookie，
// 必然返回「未登录」把请求拦死。更糟的是 requireAdmin 会 redirect/抛 ——
// 给 Stripe 返回一个 302 或 500，它会当成失败重投三天。
//
// **这个接口的身份验证就是签名**，见 src/lib/stripe-webhook.ts。
// 「没有 session 鉴权」不等于「没有鉴权」，别在这里放松。
//
// 【为什么没写 export const runtime = "nodejs"】
// 因为 nodejs 本来就是默认值，而 Edge Runtime 在 Next 16 已经废弃、
// 官方文档明确说「把 runtime 这个导出删掉」。写一行和默认值相同的配置
// 只会让人以为这里有什么讲究。真正需要的是**别去写 "edge"** ——
// 业务层用 Prisma + pg 驱动，跑不到 Edge 上去。
//
// 【将来加 middleware 时要注意】
// middleware 会拦在这条路径前面。这个项目现在没有 middleware.ts，
// 一旦哪天加了（比如做统一的登录跳转），必须把 /api/webhooks/stripe
// 放进白名单 —— 否则 middleware 会把没有 cookie 的 Stripe 请求
// 重定向走，回调就静默地不工作了（Stripe 那边只看到 307，然后一直重投）
//
// 【为什么只导出 POST】
// Stripe 只会 POST。没定义的方法 Next 会自动返回 405 —— 这正是我们想要的，
// 不需要自己写一个 GET 去手动拒绝
// ============================================================================

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature")

  if (!signature) {
    // 缺签名头就没什么可验的，直接拒。同样一个字节都不写库
    return NextResponse.json(
      { received: false, error: "缺少 stripe-signature 请求头" },
      { status: 400 },
    )
  }

  // 【必须取原始文本，不能 request.json()】
  // 验签是对**原始字节**算的 HMAC。先 json() 再 stringify 回来的字符串
  // 不保证和原始字节一致（键顺序、空白、\uXXXX 转义都可能变），
  // 拿它验签会失败。App Router 的 Route Handler 拿到的是标准 Request，
  // 没有 Pages Router 那个 body parser 挡在中间，text() 直接给原始内容
  const rawBody = await request.text()

  const result = await handleStripeWebhook(rawBody, signature)

  if (result.ok) {
    // 200 的两种含义，都成立：
    //   - outcome=applied：订单推成已支付了
    //   - outcome=cancelled：我们**故意**没改订单（钱收了但单已被取消），
    //     记了痕等人处理。返回 200 是为了让 Stripe 别再重投 ——
    //     重投一百次结局也一样，而且会把日志刷满
    return NextResponse.json({ received: true, outcome: result.outcome })
  }

  // 状态码的选择就是「要不要让 Stripe 重投」：
  //   bad_signature  → 400。问题在配置或有人在伪造，重投无用，
  //                    但不返回 200 —— 万一真有人在打这个接口，
  //                    得让它一眼看出被拒了
  //   not_configured → 500。我们的配置问题，修好之前重投也白搭，
  //                    但它是**服务端故障**，不该谎报成 400
  //   processing_failed → 500。这一类是唯一「重投有意义」的
  //                    （数据库临时连不上、写库超时）
  const status = result.reason === "bad_signature" ? 400 : 500

  return NextResponse.json(
    { received: false, error: result.error },
    { status },
  )
}
