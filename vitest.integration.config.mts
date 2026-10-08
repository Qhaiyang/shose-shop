import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

import { loadEnv, urlForDatabase } from "./scripts/db-url.mjs"

// ============================================================================
// 第二层：集成测试配置
//
// 和单元测试配置的区别只有三点，但每一点都是必须的：
//
//   1. DATABASE_URL 指向 shoptest —— 绝不能连到 shopdev
//   2. globalSetup 先把 shoptest 重建出来（见 tests/integration/global-setup.ts）
//   3. fileParallelism: false —— 串行跑
//
// 【为什么必须串行】
// 所有测试文件共用同一个库，而每个用例开始前都会把**全部业务表**清空。
// 如果两个文件并行跑，A 文件刚清完表、B 文件正在插数据，就会互相踩。
// 这类失败的典型症状是「单独跑能过，一起跑就红」——
// 花在排查这种问题上的时间，远超过串行多花的那几秒。
//
// 注意这条理由和 SQLite 无关：换到 PostgreSQL 之后它依然成立，
// 因为问题出在「共用同一个库 + 每个用例清全表」这个设计上，
// 不是出在数据库的并发能力上。PostgreSQL 完全能扛住并行写 ——
// 扛不住的是「隔壁那个测试刚把你造的数据删了」。
//
// 【为什么要把 DATABASE_URL 和 DIRECT_URL 都指到 shoptest】
// prisma7.config.ts 里读的是 `DIRECT_URL || DATABASE_URL`（迁移优先走直连串，
// 本地两者是同一个地址）。如果这里只设 DATABASE_URL：
// 阶段 3 之后开发者的 .env 里会有 Neon 的 DIRECT_URL，而 dotenv 的语义是
// 「已存在的环境变量优先」—— 可它**只在环境变量已经存在时**才不覆盖。
// 一旦哪一个进程没拿到我们设的 DATABASE_URL，迁移就会退回读 .env，
// 于是「跑测试」变成「对着 Neon 执行 migrate deploy」。
// 两个都设，是为了让这条路径上不留一个「看情况」的分支。
// ============================================================================

const TEST_DB = "shoptest"

// .env 提供服务器地址、用户和密码；这里只把库名换成测试库。
// loadEnv 在「没有 .env 但环境变量里已有 DATABASE_URL」时也能工作（CI 的情形）
loadEnv()

const testUrl = urlForDatabase(process.env.DATABASE_URL!, TEST_DB)

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: false,

    // 覆盖 .env 里的 DATABASE_URL。
    //
    // 【为什么这不是「多此一举」】
    // Vite 会自动加载 .env，而 .env 指向的是 shopdev。
    // 少了这两行，测试就会连带把开发库一起清空 ——
    // 所以 tests/integration/helpers/db.ts 里还有一道 assertTestDatabase()，
    // 每次破坏性操作前都问数据库自己「你现在连的到底是哪个库」，
    // 不是 shoptest 就直接抛错。两道防线是刻意的：
    // 这一道负责「设对」，那一道负责「万一没设对，别把库删了」
    env: {
      DATABASE_URL: testUrl,
      DIRECT_URL: testUrl,
      NODE_ENV: "test",
    },

    // 重建测试库（删库 → 建库 → migrate deploy）
    globalSetup: ["tests/integration/global-setup.ts"],

    // 单文件内也不要并行执行用例 —— 它们共享一个数据库
    fileParallelism: false,
    sequence: { concurrent: false },

    // 集成测试要起进程、跑迁移，比单元测试慢得多
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
})
