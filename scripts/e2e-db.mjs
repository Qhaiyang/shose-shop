// ============================================================================
// E2E 测试的建库脚本（每次跑 Playwright 前执行一次）
//
// 做的事情只有一件：把 shope2e 恢复成一个「表齐全 + 有种子数据」的状态。
// 具体步骤（删库 → 建库 → migrate deploy → seed）写在
// scripts/reset-database.mjs 里，这里只是把它拉起来并加上 --seed。
//
// 【为什么要 seed，集成测试却不 seed】
// 集成测试自己造数据（tests/integration/helpers/db.ts 的 makeUser/makeProduct…），
// 因为每个用例都要求一个干净、精确可控的起点。
//
// E2E 不一样：它走的是**真实的浏览器 + 真实的页面**，没法直接往数据库里
// 塞数据。它需要一个「打开就有商品可点」的网站 —— 这正是种子数据的作用。
// 顺带也让「管理员的发货步骤」能直接用 README 里写的那个演示账号登录。
//
// 【为什么要和 shopdev / shoptest 分开】
// 三个库各管各的：shopdev 是手工开发的，shoptest 被集成测试反复清空，
// shope2e 会在每次 E2E 前被整个删掉重建。混用的话，跑一次 E2E
// 就会把你手工造的数据全冲掉。
//
// 【为什么是 .mjs 而不是 .ts】
// 它由 playwright.config.ts 的 webServer.command 直接调起，
// 用 node 原生跑，不需要 tsx 那一层。
// ============================================================================

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))

// 【为什么是起子进程，而不是 import 那个脚本里的函数】
// 和 tests/integration/global-setup.ts 里是同一个理由：
// 这个文件由**纯 node** 执行，import 不了 .ts；而那个脚本是 .mjs，
// 其实这边能 import —— 但两边用同一种调法（fork 子进程）更好理解，
// 也顺手让「重置」这件事跑在一个干净的进程里，环境变量不会被上一段代码污染。
//
// 【为什么参数是 --db=shope2e --seed 而不是在这里设 DATABASE_URL】
// 连接串（服务器、用户、密码）由 .env 提供，脚本自己会读；
// 它只需要知道「换成哪个库」。这样密码始终只有 .env 一个来源，
// 不会在代码里出现第二份。
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("./reset-database.mjs", import.meta.url)),
    "--db=shope2e",
    "--seed",
  ],
  {
    cwd: ROOT,
    // 直接刷到终端。失败时输出里是 PostgreSQL 的原始报错
    // （连不上 / 密码不对 / 迁移失败），比任何包装过的信息都有用
    stdio: "inherit",
  },
)
