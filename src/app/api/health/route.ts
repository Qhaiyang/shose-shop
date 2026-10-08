import { NextResponse } from "next/server"

import { prisma } from "@/lib/prisma"

// 健康检查：确认 Next.js 服务端能连上数据库并查得动（Prisma + PostgreSQL adapter）
// 访问 http://localhost:3000/api/health
//
// 本地（种子全种）正常返回：{"ok":true,"products":3,"skus":48,"users":2,...}
// 线上返回的用户数是 0 或你自己注册的个数 —— 演示账号只在本地库才种，
// 见 prisma/seed.ts 的 shouldSeedDemoAccounts
//
// 【orphanedWebhooks 是什么，为什么放在健康检查里】
// 它是「收到了钱、但没能落到订单上」的支付事件数（见下方查询）。
// 这本来是该报警的东西，但练手项目没有告警系统 —— 一个只写日志、
// 没人看的告警等于没有。放在这里，是因为 /api/health 已经是这个项目
// 唯一的运维入口：任何人在浏览器里打开一眼就能看到它是不是 0。
//
// 【为什么条件是 appliedAt IS NULL AND orderId IS NOT NULL】
//   appliedAt 为空   = 这行事件没让订单状态发生变化（是个判决，不是中间态，
//                      见 prisma/schema.prisma 里 WebhookEvent.appliedAt）
//   orderId 不为空   = 它至少关联到了一张订单，说明是我们自己开出去的支付
// 两个条件合起来才是「有主的钱没对上账」。只有 orderId 为空的那一类
// （事件没带 orderId、或者是我们不认识的事件类型）不需要人处理，
// 所以要把它们排除掉
export async function GET() {
  try {
    const [products, skus, users, orphanedWebhooks] = await Promise.all([
      prisma.product.count(),
      prisma.sku.count(),
      prisma.user.count(),
      prisma.webhookEvent.count({
        where: { appliedAt: null, orderId: { not: null } },
      }),
    ])

    return NextResponse.json({
      ok: true,
      products,
      skus,
      users,
      orphanedWebhooks,
    })
  } catch (error) {
    console.error("[health] 数据库连接失败:", error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "未知错误" },
      { status: 500 },
    )
  }
}
