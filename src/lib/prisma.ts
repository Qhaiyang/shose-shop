import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "@/generated/prisma/client"

// ============================================================================
// Prisma Client 单例
//
// 【为什么需要单例】
// 每个 PrismaClient 实例内部都维护一个数据库连接池。Next.js 的开发模式会
// 热重载（改一次代码就重新执行一遍模块），如果每次都 new 一个 Client，
// 几十次改动之后就会攒下几十个连接池，最终把数据库连接耗光、报
// "too many connections"。
//
// 解决办法：把实例挂到 globalThis 上。模块会被重新执行，但 globalThis
// 是跨热重载存活的，所以能复用同一个实例。
// 生产环境不存在热重载问题，直接 new 即可。
//
// 【这个办法的代价：改了 schema.prisma 必须重启 dev server】
// 实例的各个模型入口（prisma.review、prisma.favorite……）是在 new 的那一刻
// 按当时生成的 client 定下来的。加了新模型之后 `npx prisma generate` 会把
// 新文件写进 src/generated/prisma，但 globalThis 上那个**已经存在**的实例
// 是换不掉的 —— 热重载只会拿到旧实例，新模型的入口始终是 undefined。
//
// 症状很有迷惑性：类型检查、构建、测试全绿（它们都跑在全新进程里），
// 只有你那个开着的 dev server 访问新模型的页面会 500：
//     TypeError: Cannot read properties of undefined (reading 'count')
// 因为 prisma.review 是 undefined，报错点会指向调用它的那一行查询，
// 看起来像查询写错了。看到这个报错，先重启 dev server，再怀疑代码。
//
// 【关于 driver adapter】
// Prisma 7 起，SQL 数据库要通过 driver adapter 接入。PostgreSQL 对应
// @prisma/adapter-pg（底层就是 node-postgres 的 pg）。
//
// 【为什么运行时只用 DATABASE_URL，而不用 DIRECT_URL】
// 连接串在两个地方读，读的变量不同，是故意的：
//     src/lib/prisma.ts（这里）→ DATABASE_URL  应用运行时
//     prisma7.config.ts        → DIRECT_URL ?? DATABASE_URL  迁移
// 本地两者是同一个地址。上云（Neon）之后 DATABASE_URL 填**池化**地址，
// DIRECT_URL 填**直连**地址 —— 池化连接不支持迁移要用的会话级特性。
// 应用运行时走池化是对的：Next 在 serverless 上会开很多短连接。
// 这条分工替代了 Prisma 7 里已经取消的 schema.prisma `directUrl`。
//
// 【为什么不给 DATABASE_URL 兜底默认值】
// 之前写的是 process.env.DATABASE_URL ?? "file:./dev.db" ——
// 那个兜底当时是安全的，因为「连错了库」顶多是读不到数据。
// 现在不能这么写：真正的风险是**环境变量忘了配、于是静默连到某个
// 默认地址上**，而在生产里那就是连错库。
// 宁可让它在启动时明确报错「DATABASE_URL 没有配」。
// ============================================================================

const createPrismaClient = () => {
  const url = process.env.DATABASE_URL

  if (!url) {
    throw new Error(
      "DATABASE_URL 没有配置。本地请检查 .env（可从 .env.example 复制），" +
        "部署环境请检查平台的环境变量设置。",
    )
  }

  const adapter = new PrismaPg({ connectionString: url })

  return new PrismaClient({
    adapter,
    // 开发时打印慢查询和错误，方便定位问题
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  })
}

// 声明全局变量类型，避免 TS 报错
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
