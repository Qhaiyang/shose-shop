import Stripe from "stripe"

// ============================================================================
// Stripe 客户端
//
// 【为什么是「用的时候才建」，而不是模块顶层 new 一个】
// 和 src/lib/prisma.ts 里那条「不给 DATABASE_URL 兜底默认值」是同一个原则
// 的两面：缺配置时**必须炸**，但不能炸在错误的时刻。
//
//   - 顶层 new Stripe(process.env.STRIPE_SECRET_KEY!) ：缺变量时
//     `import` 这一行就抛，而 import 会发生在**构建期**。
//     后果是 `npm run build` 直接失败，且报错指向这个文件 ——
//     看起来像代码写错了，实际是环境变量没配。
//   - 用的时候才建：构建、类型检查、单元测试都不碰它；
//     真正调用 Stripe 的那一刻才要密钥，报错点就是「谁在调」。
//
// 【为什么不做「没配就用测试密钥」这种兜底】
// 那会导致线上静默地用错误身份去调 API —— 请求能发出去，但结果是错的，
// 或者干脆把测试环境的数据和线上的搅在一起。
// 宁可让它明确报一句「STRIPE_SECRET_KEY 没有配置」。
//
// 【注意：验签其实不需要密钥，但 SDK 的构造函数要求一个】
// constructEvent 和 generateTestHeaderString 都是纯本地计算（HMAC），
// 不发任何网络请求。但它们挂在 Stripe 实例上，而实例必须有个 apiKey。
// 所以集成测试里也得先设一个假的 STRIPE_SECRET_KEY 才能调到它们 ——
// 这是测试要多设一个环境变量的原因，不是设计缺陷。
//
// 【和 prisma.ts 一样的单例理由】
// dev 模式热重载会反复执行模块。Stripe 实例本身很轻（没有连接池），
// 但它带着一个 HTTP agent，缓存一份总是更省。
// ============================================================================

let cached: Stripe | null = null

/**
 * 取 Stripe 客户端。缺 STRIPE_SECRET_KEY 时抛错。
 *
 * 注意返回值是只读用途：第二步接前端时还要用到 publishable key，
 * 那个走 NEXT_PUBLIC_ 前缀，和这里无关。
 */
export function getStripe(): Stripe {
  if (cached) return cached

  const key = process.env.STRIPE_SECRET_KEY

  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY 没有配置。本地请检查 .env（可从 .env.example 复制），" +
        "部署环境请检查平台的环境变量设置。",
    )
  }

  // 不传 apiVersion：用 SDK 内置钉死的那个版本。
  // 手写版本号的话，升级 SDK 时会出现「类型是按新版生成的、
  // 请求却按旧版发出去」的错配，而且没有任何提示
  cached = new Stripe(key)

  return cached
}
