// ============================================================================
// 建三个本地数据库：shopdev / shoptest / shope2e
//
// 用法：npm run db:create
//
// 对应原来那三个 SQLite 文件：
//     shopdev   ← dev.db    手工造的数据，长期留着
//     shoptest  ← test.db   集成测试反复清空
//     shope2e   ← e2e.db    每次 E2E 前整个重建
//
// 【为什么不直接 shell 调用 psql】
// Windows 上 PostgreSQL 的 bin 目录默认**不在 PATH 里**（winget 装完只加了
// 安装目录，没加 bin）。用 psql 就得先解决「它到底在哪」——要么写死
// C:\Program Files\PostgreSQL\17\bin，要么让每个人自己配 PATH。
// 而这个脚本本来就要连库，`pg` 又是 Prisma adapter 的现成依赖，
// 直接用它反而少一层依赖、还跨平台。
//
// 【为什么可以重复执行】
// 每个库先查 pg_database 有没有，有就跳过。这是一条硬性要求：
// 这个脚本会被反复跑（换机器、换了 PostgreSQL 版本、别人克隆仓库），
// 报「database already exists」并中断，会让人以为哪里坏了。
// ============================================================================

import pg from "pg"

import { DATABASES, loadEnv, parseLocalDatabaseUrl } from "./db-url.mjs"

/** 连到维护库 postgres（它一定存在，是 initdb 自己建的） */
async function connectMaintenance(conn) {
  const client = new pg.Client({
    host: conn.host,
    port: Number(conn.port),
    user: conn.user,
    password: conn.password,
    database: "postgres",
  })

  try {
    await client.connect()
  } catch (error) {
    // 认证失败是最常见的一种，单独给一条能直接照做的提示。
    //
    // 【为什么判错误码，而不是在 error.message 里找 "authentication failed"】
    // 因为 PostgreSQL 的报错文案是**跟着服务端 locale 走的**。
    // 这台机器上它输出的是中文：「用户 "postgres" Password 认证失败」——
    // 拿英文关键词去匹配永远匹配不上，那段友好提示等于没写。
    // 而 SQLSTATE 码是协议层面的，和语言无关：
    //   28P01 = invalid_password            密码不对
    //   28000 = invalid_authorization_spec 认证方式不对（比如 pg_hba 不允许）
    // 这个坑是靠实际跑一遍才发现的 —— 只看代码会以为它能用
    if (error.code === "28P01" || error.code === "28000") {
      throw new Error(
        `连不上 PostgreSQL：密码认证失败（用户 ${conn.user}）\n` +
          `  检查 .env 里 DATABASE_URL 的密码部分是否正确。\n` +
          `  忘了密码的话，可以在 pgAdmin 里重置。\n` +
          `  原始报错：${error.message}`,
      )
    }
    throw error
  }

  return client
}

async function main() {
  loadEnv()

  const conn = parseLocalDatabaseUrl(process.env.DATABASE_URL)
  const client = await connectMaintenance(conn)

  console.log(
    `\n连接到 PostgreSQL：${conn.host}:${conn.port}（用户 ${conn.user}）\n`,
  )

  try {
    for (const name of DATABASES) {
      // 查存在性。pg_database 是系统目录，任何用户都能读
      const { rowCount } = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [name],
      )

      if (rowCount > 0) {
        console.log(`  跳过 ${name}（已存在）`)
        continue
      }

      // 【为什么库名用双引号拼进 SQL，而不是参数化】
      // CREATE DATABASE 的库名是**标识符**，不是值 ——
      // 参数化占位符（$1）在 PostgreSQL 里只能传值，传标识符是语法错误。
      // 所以只能拼字符串。这在这里是安全的：名字来自 db-url.mjs 里那份
      // 写死的 DATABASES 清单，没有任何外部输入能进到这个变量里。
      // 包一层双引号是为了让名字里的连字符/大小写也正确
      await client.query(`CREATE DATABASE "${name}"`)
      console.log(`  创建 ${name}`)
    }
  } finally {
    await client.end()
  }

  console.log(`\n✅ 三个库就绪：${DATABASES.join(" / ")}\n`)
}

main().catch((error) => {
  console.error(`\n❌ 建库失败：${error.message}\n`)
  process.exit(1)
})
