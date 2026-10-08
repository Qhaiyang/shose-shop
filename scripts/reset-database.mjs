// ============================================================================
// 重置一个本地数据库：删库 → 建库 → 按迁移文件建表
//
// 用法：
//     npm run db:reset                  重置 .env 里 DATABASE_URL 指向的那个库
//     npm run db:reset -- --db=shoptest 重置指定的库
//     npm run db:reset -- --db=shope2e --seed
//
// 【这个文件有三处调用者，但实现只有这一份】
//     npm run db:reset                → 你自己在终端里跑
//     tests/integration/global-setup  → 集成测试开跑前重置 shoptest
//     scripts/e2e-db.mjs              → E2E 开跑前重置 shope2e 并灌种子
//
// 后两处是用 `node scripts/reset-database.mjs --db=xxx` **起一个子进程**
// 来调的，不是 import 进来调函数。这是有意选的方式，不是偷懒：
//   - global-setup 是 TypeScript，import 一个 .mjs 会让 tsc 抱怨
//     「找不到类型声明」（脚本没有 .d.ts）
//   - e2e-db.mjs 由 Playwright 的 webServer 用**纯 node** 拉起，
//     它 import 不了 .ts
// 而「从 node 里 fork 一个脚本、把环境变量传进去」这个项目本来就有先例
// （global-setup 和 e2e-db 都是这么调 Prisma CLI 的）。
//
// 【为什么必须是一份实现】
// 「删库」这种操作一旦有两份实现，早晚会漂移成
// 「一处有白名单检查、另一处没有」—— 而那种 bug 的表现是
// 「某条路径下把开发库删了」，且没有任何测试会红。
//
// 【为什么要自己写一个，而不是用 prisma migrate reset】
//   1. `prisma migrate reset` 只重置 DATABASE_URL 指向的那个库。
//      想重置测试库就得临时改 .env 或写环境变量前缀的命令 ——
//      后者在 Windows 的 npm script 里（cmd.exe）根本不成立
//   2. 它默认会跑 seed。重置测试库时并不想要种子数据：
//      集成测试自己造数据（tests/integration/helpers/db.ts），
//      凭空多出 3 款鞋 48 个 SKU 只会让断言变难写
//
// 【为什么 DROP 要带 WITH (FORCE)】
// PostgreSQL 不允许删除还有活动连接的库。跑完集成测试后，如果
// vitest 的 worker 还没完全退出，或者你手边开着 prisma studio，
// 连接还在，DROP DATABASE 就会失败并报「being accessed by other users」。
// WITH (FORCE)（PG 13+）会主动终止那些连接，脚本才能真的可重复执行。
// ============================================================================

import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"

import {
  DATABASES,
  loadEnv,
  parseLocalDatabaseUrl,
  urlForDatabase,
} from "./db-url.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))

/**
 * 找到 Prisma CLI 的入口 JS。
 *
 * 和 tests/integration/global-setup.ts、scripts/e2e-db.mjs 里是同一套理由：
 * Windows 上 node_modules/.bin/prisma 是 .cmd 批处理，execFileSync 不带
 * shell 执行不了；而加 shell: true 等于把命令拼成字符串交给 shell 解析。
 * 直接定位到 bin 字段指向的那个 JS，用当前 node 执行。
 */
function prismaCliPath() {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve("prisma/package.json")
  const pkg = require("prisma/package.json")
  return path.join(path.dirname(pkgPath), pkg.bin.prisma)
}

/**
 * 重置指定数据库。
 *
 * @param {{ database?: string, seed?: boolean }} options
 *   database 不传就用 DATABASE_URL 里那个；seed 为 true 时顺带灌种子数据
 */
async function resetDatabase(options = {}) {
  loadEnv()

  const conn = parseLocalDatabaseUrl(process.env.DATABASE_URL)
  const target = options.database ?? conn.database
  const seed = options.seed ?? false

  // 【白名单检查，这是这个脚本最重要的一段】
  // 这个脚本会删库。DATABASE_URL 是环境变量，它可能因为任何原因
  // 指向别的地方 —— 阶段 3 之后 .env 里还会有 Neon 的连接串。
  // 所以「允许删哪些库」必须是一份写死的清单，而不是
  // 「DATABASE_URL 说删谁就删谁」。
  // parseLocalDatabaseUrl 已经拦了非本机地址，这里再拦一次库名 ——
  // 本机也可能有别的项目的库
  if (!DATABASES.includes(target)) {
    throw new Error(
      `拒绝删除数据库 "${target}"：它不在允许的清单里\n` +
        `  允许的只有：${DATABASES.join(" / ")}\n` +
        `  要加一个库，请改 scripts/db-url.mjs 里的 DATABASES 清单。`,
    )
  }

  const maintenance = new pg.Client({
    host: conn.host,
    port: Number(conn.port),
    user: conn.user,
    password: conn.password,
    database: "postgres",
  })

  await maintenance.connect()

  try {
    console.log(`\n重置 ${target}（${conn.host}:${conn.port}）`)

    await maintenance.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`)
    console.log(`  删除 ${target}`)

    await maintenance.query(`CREATE DATABASE "${target}"`)
    console.log(`  创建 ${target}`)
  } finally {
    await maintenance.end()
  }

  // 【为什么是 migrate deploy 而不是 migrate dev】
  // migrate dev 是用来**写迁移**的：它会比对 schema 和迁移文件，
  // 发现漂移时问你要不要新建一个迁移 —— 非交互执行会卡在提示上。
  // 而且它还会顺带跑 generate 和 seed，副作用比这个脚本该有的多。
  // deploy 只做一件事：把已提交的迁移应用到空库上。
  // 这也和集成测试一直以来的做法一致 —— 那里刻意用 deploy，
  // 好让「忘记生成迁移」立刻暴露出来（表里缺字段），
  // 而不是悄悄用 db push 补上、把问题留到部署时才爆
  const env = {
    ...process.env,
    DATABASE_URL: urlForDatabase(process.env.DATABASE_URL, target),
  }

  execFileSync(process.execPath, [prismaCliPath(), "migrate", "deploy"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  })

  if (seed) {
    // 【为什么必须手动补 PATH】
    // `prisma db seed` 实际上是去执行 prisma7.config.ts 里写的
    // `tsx prisma/seed.ts`，而 tsx 在 node_modules/.bin 下 ——
    // 那个目录能被找到，是 npm 在跑 scripts 时临时加进 PATH 的。
    // 我们这里是直接 fork prisma，绕开了 npm，所以那一层不见了。
    // 不补的话 migrate 能跑（它自己是 JS），一到 seed 就
    // 「Command failed: tsx prisma/seed.ts」
    execFileSync(process.execPath, [prismaCliPath(), "db", "seed"], {
      cwd: ROOT,
      env: {
        ...env,
        PATH:
          path.join(ROOT, "node_modules", ".bin") +
          path.delimiter +
          (process.env.PATH ?? ""),
      },
      stdio: "inherit",
    })
  }

  console.log(`\n✅ ${target} 已重置${seed ? "（含种子数据）" : ""}\n`)
}

/**
 * 解析参数：--db=xxx / --seed
 *
 * 【为什么手写解析，不装 commander 之类】
 * 一共就两个参数。为一个练手项目多装一个依赖、多学一套 API 不划算 ——
 * 尤其是这两个参数看一眼就知道怎么来的。
 */
function parseArgs(argv) {
  let db = null
  let seed = false

  for (const arg of argv) {
    if (arg.startsWith("--db=")) db = arg.slice("--db=".length)
    else if (arg === "--seed") seed = true
    else {
      throw new Error(`不认识的参数：${arg}\n  可用：--db=<库名> --seed`)
    }
  }

  return { db, seed }
}

/**
 * 【为什么解析参数这一步也要包在 async 函数里】
 * parseArgs 是同步抛错的。如果直接在顶层写
 *     const { db } = parseArgs(...)      ← 这一行抛了
 *     resetDatabase({...}).catch(...)    ← 根本执行不到
 * 那 .catch 就接不住它，用户看到的是一段 node 的堆栈，
 * 而不是「不认识的参数：--oops」。
 * 放进 async 函数之后，同步抛出会被自动转成 rejected promise，
 * 下面那一个 .catch 就同时兜住了两种失败 ——
 * 参数写错和数据库连不上，都走同一条干净的报错路径。
 */
async function main() {
  const { db, seed } = parseArgs(process.argv.slice(2))

  // 【为什么 db 这里要转成 undefined 而不是传 null】
  // resetDatabase 里判断默认值用的是 ??，null 会被正确识别成「没传」。
  // 写成 undefined 只是和 parseArgs 的返回值形状对上，
  // 避免以后有人改成 `options.database ?? ...` 之外的写法时踩空
  await resetDatabase({ database: db ?? undefined, seed })
}

main().catch((error) => {
  console.error(`\n❌ 重置失败：${error.message}\n`)
  process.exit(1)
})
