// ============================================================================
// 数据库连接串的小工具（纯函数，不连库、不产生副作用）
//
// 单独一个文件的理由：这段逻辑有**四个**调用方，而且分散在两种模块系统里：
//     scripts/create-databases.mjs      （.mjs，纯 node）
//     scripts/reset-database.mjs        （.mjs，纯 node）
//     vitest.integration.config.mts     （TS，被 vitest 执行）
//     playwright.config.ts              （TS，被 Playwright 执行）
//
// 【为什么这些 TS 配置能 import 一个 .mjs】
// tsconfig 里 allowJs: true、moduleResolution: "bundler" —— 两个条件都满足，
// TypeScript 能解析 .mjs。而且 checkJs 没开，所以不会去给这个文件挑类型毛病
// （它自己也不是类型安全的重点）。
//
// 【但这个文件里不能出现 import.meta —— E2E 踩出来的】
// Playwright 加载 playwright.config.ts 时，会把它 import 的东西**一并转成
// CommonJS**。转译本身没问题（import 会被改写成 require），
// 但 `import.meta` 在 CJS 里是语法错误：
//     SyntaxError: Cannot use 'import.meta' outside a module
// 报错发生在**读配置阶段**，一条测试都跑不起来。
// 所以定位 .env 不用 import.meta.url，改用 process.cwd()（见 loadEnv）。
//
// 【为什么值得收成一份】
// 「白名单」和「只允许本机」这两条是防线，不是便利功能。
// 抄成四份之后，改一处忘三处，而漏掉的那份照样能跑、照样绿 ——
// 直到某天有人拿它去删了开发库。
// ============================================================================

import { existsSync } from "node:fs"
import { resolve } from "node:path"

/**
 * 允许被脚本创建/删除的本地数据库。
 *
 * 对应原来那三个 SQLite 文件：
 *     shopdev   ← dev.db    手工造的数据，长期留着
 *     shoptest  ← test.db   集成测试反复清空
 *     shope2e   ← e2e.db    每次 E2E 前整个重建
 *
 * 【为什么写死成一份清单】
 * 这是白名单，不是便利功能。reset-database.mjs 会拿它去**删库** ——
 * 「只允许动这三个」是一道真实的安全边界，而不是一句注释。
 * 库名看着眼熟就直接加进来之前，先想清楚它会不会被别的项目共用。
 */
export const DATABASES = ["shopdev", "shoptest", "shope2e"]

/**
 * 算「本机」的主机名。
 *
 * 【为什么单独导出这一份】
 * 有两处防线要用同一个「本机」概念：
 *   1. parseLocalDatabaseUrl —— 建库/删库只允许动本机（下面）
 *   2. prisma/seed.ts —— 演示账号（弱密码）只在本机库上创建
 * 抄成两份的话，改一处忘一处，漏掉的那处照样能跑 —— 而它漏掉的
 * 可能正是「允许在远程库上创建弱密码账号」。
 */
export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"]

/**
 * 这个连接串是不是指向本机。
 *
 * 和 parseLocalDatabaseUrl 的区别：**它不抛异常**，只回答是或否。
 * 种子里要用它做分支判断（是 → 种演示账号，不是 → 跳过），
 * 抛异常的那种形状在那里没法用。
 */
export function isLocalDatabaseUrl(url) {
  if (!url) return false
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname)
  } catch {
    // 连 URL 都解析不了（比如还是 SQLite 时代的 file:./dev.db）——
    // 这里答题不判卷：不是本机 Postgres，就返回 false
    return false
  }
}

/**
 * 加载 .env，并确保 DATABASE_URL 有值。
 *
 * 【为什么没有 .env 也允许继续】
 * 集成测试和 E2E 是**显式把 DATABASE_URL 通过环境变量传进来**的
 * （见 vitest.integration.config.mts / playwright.config.ts），
 * 它们不需要 .env。CI 上更是根本没有 .env。
 * 所以「文件不存在」本身不是错误 —— 错误的是「转了一圈还是没拿到
 * DATABASE_URL」。只有那一种情况才报错，而且报的是人能照做的那句话。
 *
 * 【已有的环境变量优先】
 * node 的 loadEnvFile 和 --env-file 一样：文件里定义的值**不会覆盖**
 * 已经存在的环境变量。所以临时 `DATABASE_URL=... npm run db:create`
 * 能盖过 .env —— 这正是集成测试和 E2E 指向自己那个库的手法。
 *
 * 【为什么 .env 的路径用 process.cwd() 而不是 import.meta.url】
 * 见文件顶部那段：import.meta 会让 Playwright 加载配置时直接崩。
 * 代价是这里多了一个前提 —— **四个调用方都得从仓库根目录启动**。
 * 这个前提目前到处都成立：npm script 的 cwd 是 package.json 所在目录，
 * reset-database.mjs 被 fork 时显式传了 cwd: ROOT，
 * Playwright / vitest 也都是从根目录读配置。
 * 哪天要支持「在子目录里跑」，就得换回真正基于文件位置的定位方式
 * —— 那时 Playwright 那边得单独想办法。
 */
export function loadEnv() {
  const dotEnv = resolve(process.cwd(), ".env")

  if (existsSync(dotEnv)) {
    process.loadEnvFile(dotEnv)
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      `没有拿到 DATABASE_URL（${existsSync(dotEnv) ? `${dotEnv} 里没有配` : `${dotEnv} 不存在`}）\n` +
        `  请先复制一份配置：cp .env.example .env\n` +
        `  然后把 DATABASE_URL 里的 <密码> 换成你装 PostgreSQL 时设的超级用户密码。`,
    )
  }
}

/**
 * 把 DATABASE_URL 拆成连接参数，同时挡住「不是本机」和「不是 Postgres」。
 *
 * 【为什么强制只允许本机】
 * 调用方里有会执行 CREATE DATABASE / DROP DATABASE 的脚本。
 * 阶段 3 之后 .env 里会同时出现本地连接串和 Neon 的连接串，
 * 哪天有人把 DATABASE_URL 指向了 Neon，脚本就会去动生产库。
 * 与其靠人记得「别那么干」，不如直接拦住。
 */
export function parseLocalDatabaseUrl(url) {
  if (!url) {
    throw new Error("没有 DATABASE_URL")
  }

  const parsed = new URL(url)

  // 先认协议。这一步在「刚把 provider 换成 postgresql、但 .env 还没改」
  // 的时候特别有用：那时 DATABASE_URL 还是 file:./dev.db，
  // hostname 是空字符串，会被下面那条「非本机地址」的检查拦下 ——
  // 报错说「拒绝在非本机地址上执行建库」，而真正的问题是
  // 「你的连接串还是个 SQLite 文件路径」
  if (!["postgresql:", "postgres:"].includes(parsed.protocol)) {
    throw new Error(
      `DATABASE_URL 不是 PostgreSQL 连接串：${url}\n` +
        `  现在应该是 postgresql://用户:密码@localhost:5432/shopdev\n` +
        `  （SQLite 时代的 file:./dev.db 已经不用了）`,
    )
  }

  const host = parsed.hostname

  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `拒绝在非本机地址上执行建库/删库：${host}\n` +
        `  这些脚本只用于本地开发。云上的库（Neon）用 prisma migrate deploy 建表。`,
    )
  }

  return {
    host,
    port: parsed.port || "5432",
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    // 连接串里那个库名（比如 shopdev）
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  }
}

/**
 * 把连接串指向服务器上的另一个库。
 *
 * 集成测试要的就是这个：服务器、用户、密码都跟 .env 里一样，
 * 只是换个库名（shopdev → shoptest）。
 *
 * 【为什么用 URL 对象改 pathname，而不是字符串 replace】
 * 密码里可能带特殊字符（@ : / 等等），字符串替换很容易改错位置 ——
 * 比如密码里有个 @，按最后一个 @ 切分就切错了。URL 对象知道每一段是什么，
 * 改完再序列化，等于顺手帮我们做了密码的百分号编码。
 */
export function urlForDatabase(originalUrl, database) {
  const url = new URL(originalUrl)
  url.pathname = `/${database}`
  return url.toString()
}
