import { NextResponse, type NextRequest } from "next/server"

import { cancelExpiredOrders } from "@/lib/orders"

// ============================================================================
// 定时任务入口：取消超时未支付的订单
//
// 【为什么是一个 API 路由，而不是在进程里跑 setInterval】
// 在 Next.js 进程里 setInterval 有两个坑：
//   1. 部署到 serverless（Vercel 等）时，函数实例随时会被冻结/销毁，
//      定时器跟着一起没，任务就静默不跑了，而且没有任何报错
//   2. 本地开发时每次热重载都会重新执行模块，定时器一层层叠加，
//      跑一会儿就开始重复执行同一个任务
// 把「什么时候跑」交给操作系统（crontab / systemd timer / 云厂商定时任务），
// 我们只负责提供一个「跑一次」的接口。这样代码更简单，行为也更好预测。
//
// 【怎么在本地跑】
//   1. 手动触发一次（最简单的验证方式）：
//        curl -X POST http://localhost:3000/api/cron/expire-orders \
//          -H "Authorization: Bearer dev-cron-secret"
//   2. 想让它自动跑，在 .env 里开开关：
//        CRON_ENABLED="true"
//      然后另开一个终端执行 scripts/cron-dev.mjs。
//      （Windows 上没有 crontab，这个小脚本用 setInterval 模拟 ——
//        它是**独立进程**，所以不踩上面那两个坑）
//
// 【为什么必须验密钥】
// 这个接口没有登录态校验（调度器不是用户，没有 cookie）。
// 如果不验密钥，任何人都能反复调它。虽然它做的事是安全的（有 WHERE 兜底，
// 重复调用不会重复还库存），但让别人随便触发写操作总归不对，
// 而且能被用来探测服务器上有没有订单。
// ============================================================================

/** 允许 GET，因为很多云厂商的定时任务只会发 GET */
export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET

  // 没配密钥就直接拒绝。不做「没配就不校验」的妥协 ——
  // 那种写法一旦被带到生产环境，就是一个完全敞开的写接口
  if (!secret) {
    console.error("[cron] 未配置 CRON_SECRET，拒绝执行")
    return NextResponse.json(
      { ok: false, error: "服务端未配置 CRON_SECRET" },
      { status: 500 },
    )
  }

  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.nextUrl.searchParams.get("secret") ??
    ""

  if (provided !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  try {
    const startedAt = Date.now()
    const result = await cancelExpiredOrders()
    const elapsedMs = Date.now() - startedAt

    // 有取消动作时才打日志。定时任务每分钟跑一次，
    // 每次都打一行「什么也没干」会把日志淹掉，真正的问题就看不见了
    if (result.cancelled > 0) {
      console.log(
        `[cron] 取消超时订单 ${result.cancelled} 笔，归还库存 ${result.restoredUnits} 件 ` +
          `(扫描 ${result.scanned} 笔，耗时 ${elapsedMs}ms)`,
      )
    }

    return NextResponse.json({ ok: true, ...result, elapsedMs })
  } catch (error) {
    console.error("[cron] 执行失败:", error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "未知错误" },
      { status: 500 },
    )
  }
}
