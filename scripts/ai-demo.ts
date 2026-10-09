/**
 * 本地演示：让订单客服助手真的查一次库、真的回你一句话。
 *
 *     npm run ai:demo -- "我的单到哪了"
 *     （不传问题的话默认问「我的单到哪了」）
 *
 * 三个前提：
 *   1. .env 里有 DEEPSEEK_API_KEY（绝不能加 NEXT_PUBLIC_ 前缀）
 *   2. 本机 PostgreSQL 里有 shoptest（跑过一次集成测试就有了）
 *   3. 这一次会真的调用 DeepSeek —— 花掉一点点额度
 *
 * 【为什么跑 shoptest，不跑 shopdev】
 * 脚本每次都会把库清空、重造演示数据。跑在 shopdev 上会把你手工造的
 * 数据一起清掉。所以它连 shoptest —— 和你跑集成测试用的是同一个库，
 * 那个库本来就是「随时可以被清掉」的。resetDb() 内部还会再确认一次
 * 当前连的到底是不是 shoptest（问数据库自己，不是问环境变量）。
 *
 * 【为什么整个 main 里全是动态 import】
 * 这个脚本要先改 DATABASE_URL 再加载 prisma —— prisma 客户端在**模块
 * 加载的那一刻**就把连接串定下来了。而 ESM 的静态 import 会被提升到
 * 文件最顶端执行，比 main() 里第一行还早。所以凡是要碰数据库的模块，
 * 都只能用 await import() 在这里现取。
 */
import { loadEnv, urlForDatabase } from "./db-url.mjs"

const ADDRESS = "北京市朝阳区幸福路 1 号"
const PHONE = "13800138000"

const LINE = "─".repeat(64)

/**
 * 出事后用来收尾。
 *
 * 【为什么不用 process.exit(1) 直接走人】
 * 硬退会打断 undici 正在关闭的 socket，在 Windows 上会多打一行
 * `Assertion failed: ... uv_handle_t` 的 libuv 崩溃 —— 一行和真正错误
 * 无关的噪音，夹在报错信息后面，最容易被误当成原因。改成等它自己收尾。
 */
let shutdown: (() => Promise<void>) | null = null

async function main() {
  loadEnv()

  const testUrl = urlForDatabase(process.env.DATABASE_URL!, "shoptest")
  process.env.DATABASE_URL = testUrl
  process.env.DIRECT_URL = testUrl

  // 在连库、造数据之前先查这一条：没有 key 的话，等造完数据再报错
  // 就白造了一轮，报错信息也离真正的原因很远
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error(`
缺少 DEEPSEEK_API_KEY。

  写进项目根目录的 .env（不要写进命令行、不要写进代码、不要加 NEXT_PUBLIC_ 前缀）：
      DEEPSEEK_API_KEY=sk-xxxxxxxx

  .env 已在 .gitignore 里，不会被提交。加了 NEXT_PUBLIC_ 的话这个 key
  会被打进浏览器 bundle，等于公开。
`)
    process.exitCode = 1
    return
  }

  const { prisma } = await import("@/lib/prisma")
  shutdown = () => prisma.$disconnect()
  const { ORDER_STATUS } = await import("@/lib/constants")
  const { formatPrice } = await import("@/lib/format")
  const { createOrderFromCart, getOrdersByUser } = await import("@/lib/orders")
  const { askOrderAgent } = await import("@/lib/ai/agent")
  const { addToCart, makeShop, resetDb, resetSeq } = await import(
    "../tests/integration/helpers/db"
  )

  const question = process.argv.slice(2).join(" ").trim() || "我的单到哪了"

  console.log(LINE)
  console.log("鞋栈 · 订单客服助手（本地演示）")
  console.log(LINE)

  // --------------------------------------------------------------------------
  // 造演示数据
  // --------------------------------------------------------------------------
  await resetDb()
  resetSeq()

  const { userId, sku } = await makeShop({ price: 89900, stock: 10 })

  // 第一单：造完直接标成「已发货」。
  // 这里绕过状态机（真实流程是 待支付 → 已支付 → 已发货，走 shipOrder），
  // 因为这是**造数据**，不是在演示业务流程 —— 演示的重点是让工具能查到
  // 一张不同状态的单子，好让回答有内容可说。
  await addToCart(userId, sku.id, 1)
  const first = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })
  if (!first.ok) throw new Error("造数据失败：第一单没下成")
  await prisma.order.update({
    where: { id: first.orderId },
    data: {
      status: ORDER_STATUS.SHIPPED,
      paidAt: new Date(),
      shippedAt: new Date(),
    },
  })

  // 第二单：正常走完下单，停在「待支付」
  await addToCart(userId, sku.id, 2)
  const second = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })
  if (!second.ok) throw new Error("造数据失败：第二单没下成")

  const orders = await getOrdersByUser(userId)
  console.log(`\n[准备] 库：shoptest（演示数据，每次重建）+ 一个用户 + ${orders.length} 笔订单`)
  for (const order of orders) {
    console.log(
      `   ${order.orderNo}   ${order.statusLabel}   ${formatPrice(order.totalAmount)}`,
    )
  }

  // --------------------------------------------------------------------------
  // 问它一句
  // --------------------------------------------------------------------------
  console.log(`\n你问：${question}\n`)

  const reply = await askOrderAgent(userId, question)

  if (reply.toolsUsed.length === 0) {
    console.log("  （它没查库就开口了 —— 这不该发生，看下面的回答是不是在编）")
  } else {
    for (const name of reply.toolsUsed) console.log(`  · 查库：${name}`)
  }

  console.log(`\n客服：${reply.text}\n`)
  console.log(LINE)

  await prisma.$disconnect()
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error("\n演示脚本挂了：", message)

  // 报错分两类，给的建议也完全不同 —— 混成一句「检查一下配置」等于没帮上忙
  if (/401|Authentication|api key/i.test(message)) {
    console.error(
      "\n这是 DeepSeek 不认识你 .env 里的 DEEPSEEK_API_KEY。\n" +
        "  检查：key 有没有抄错、有没有多余的空格或引号、账户还有没有额度。",
    )
  } else if (/P1001|P2021|ECONNREFUSED|does not exist|relation/i.test(message)) {
    console.error(
      "\n连不上库，或者 shoptest 里还没有表。先跑一次集成测试把它建出来：\n" +
        "    npx vitest run --config vitest.integration.config.mts tests/integration/ai-tools.test.ts",
    )
  }

  await shutdown?.().catch(() => {})
  process.exitCode = 1
})
