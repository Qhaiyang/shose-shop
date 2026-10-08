import { NextResponse } from "next/server"

import { prisma } from "@/lib/prisma"

// 健康检查：确认 Next.js 服务端能连上数据库并查得动（Prisma + PostgreSQL adapter）
// 访问 http://localhost:3000/api/health
//
// 本地（种子全种）正常返回：{"ok":true,"products":3,"skus":48,"users":2}
// 线上返回的用户数是 0 或你自己注册的个数 —— 演示账号只在本地库才种，
// 见 prisma/seed.ts 的 shouldSeedDemoAccounts
export async function GET() {
  try {
    const [products, skus, users] = await Promise.all([
      prisma.product.count(),
      prisma.sku.count(),
      prisma.user.count(),
    ])

    return NextResponse.json({ ok: true, products, skus, users })
  } catch (error) {
    console.error("[health] 数据库连接失败:", error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "未知错误" },
      { status: 500 },
    )
  }
}
