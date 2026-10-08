import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// ============================================================================
// 集成测试的建库步骤（整个测试会话跑一次）
//
// 做的事情其实只有一件：把 shoptest 恢复成一个「刚建好、表齐全、一行数据
// 都没有」的状态。具体步骤（删库 → 建库 → migrate deploy）写在
// scripts/reset-database.mjs 里，这里只是把它拉起来。
//
// 【为什么只是调一个脚本，不把逻辑写在这里】
// 同一个「重置」动作有三处要用（npm run db:reset、这里、E2E 的
// scripts/e2e-db.mjs）。写三遍的话，早晚会漂移成
// 「一处有白名单检查、另一处没有」—— 而那是删库操作，
// 漂移的代价是某条路径下把开发库删掉，且不会有任何测试变红。
//
// 【为什么是 fork 子进程而不是 import 那个脚本】
// 两个原因，都不是洁癖：
//   1. 这个文件是 TypeScript，import 一个 .mjs 会让 tsc 报
//      「找不到类型声明」—— 脚本没有 .d.ts，而 tsc --noEmit 是
//      每次改动的必过项，不能为了这里给它开口子
//   2. 起子进程之后，脚本跑在**一个全新的进程**里。
//      prisma migrate 会读 DATABASE_URL，而 vitest 的 globalSetup
//      跑在主进程、test.env 那套环境变量是给 worker 用的 ——
//      隔一层进程边界，「这个迁移到底连的哪个库」更容易看清楚
//
// 【为什么用 migrate deploy 而不是 db push】
// deploy 意味着测试环境建表走的是**和生产完全一样的那批迁移文件** ——
// 如果哪次改了 schema 忘记生成迁移，测试会立刻发现（表里缺字段），
// 而不是悄悄用 db push 补上、把问题留到部署时才爆。
// 这条是从 SQLite 时代就定下来的，换库之后依然成立，所以没动。
// ============================================================================

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

/** 测试库的库名。helpers/db.ts 里的安全检查也认这个名字 */
export const TEST_DB = "shoptest"

export default function setup() {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../scripts/reset-database.mjs", import.meta.url)),
      `--db=${TEST_DB}`,
    ],
    {
      cwd: ROOT,
      // 让它直接刷到终端上。这一步失败时输出里会有 PostgreSQL 的原始报错
      // （连不上 / 密码不对 / 库不存在），比任何包装过的信息都有用
      stdio: "inherit",
    },
  )
}
