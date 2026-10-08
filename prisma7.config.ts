import "dotenv/config";

import { defineConfig } from "prisma/config";

// ============================================================================
// Prisma CLI 的配置（migrate / studio / db seed 都读这个文件）
//
// 【这个文件的 datasource.url 是给谁用的】
// **只给 Prisma CLI 用**。应用运行时连的是 src/lib/prisma.ts 里的
// driver adapter，读的是 process.env.DATABASE_URL。
// 两处读的变量不同，是故意的 —— 见下面关于 DIRECT_URL 的说明。
//
// 【为什么必须 import "dotenv/config"】
// 这个文件由 Prisma CLI 执行，CLI 不会替我们加载 .env。
// 注意 dotenv 的语义是「已存在的环境变量优先，不覆盖」——
// 所以测试脚本传进来的 DATABASE_URL 会赢过 .env 里的值，
// 这正是集成测试 / E2E 能指向自己那个库的原因。
//
// 【DIRECT_URL 是什么：它替代了老版本的 directUrl】
// Prisma 7 取消了 schema.prisma 里的 `directUrl`（@prisma/config 的
// Datasource 类型现在只有 url 和 shadowDatabaseUrl 两个字段）。
// 老版本配它是为了解决同一个问题：
//
//   上云之后（Neon）应用连的是**连接池**地址（pgbouncer），
//   而迁移需要**直连**地址 —— 池化连接不支持迁移要用的那些
//   会话级特性（prepared statement、advisory lock 之类）。
//
// Prisma 7 里这个分工不需要额外的配置项，因为连接串本来就分成了两处：
//
//   迁移（这个文件）      → 直连  → DIRECT_URL
//   运行时（adapter）     → 池化  → DATABASE_URL
//
// 本地开发没有池化这回事，两个地址是同一个，所以 .env 里只配
// DATABASE_URL，DIRECT_URL 留空即可（下面用 || 兜底）。
// 到阶段 3 部署时，Vercel 上给 DIRECT_URL 填 Neon 的直连串。
//
// 【为什么是 || 而不是 ??】
// .env.example 里 DIRECT_URL 那一行是注释掉的，但如果谁手工写了
// `DIRECT_URL=""`，dotenv 会把空字符串塞进 process.env ——
// 空字符串不是 nullish，?? 会选中它，URL 就变成空的、
// 报错还很难懂。|| 把空字符串也当「没配」，正是我们要的语义。
// ============================================================================

const directUrl = process.env["DIRECT_URL"]?.trim();
const pooledUrl = process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // `npm run db:seed` 会用 tsx 执行这个脚本
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // 迁移优先走直连串；本地没配 DIRECT_URL 就退回 DATABASE_URL
    url: directUrl || pooledUrl,
  },
});
