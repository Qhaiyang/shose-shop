import { defineConfig, devices } from "@playwright/test"

import { loadEnv, urlForDatabase } from "./scripts/db-url.mjs"
import { E2E_WEBHOOK_SECRET } from "./tests/e2e/helpers/stripe"

// ============================================================================
// Playwright 配置（第三层：端到端）
//
// 【这一层和前两层有什么区别】
//   第一层 单元测试   —— 纯函数，毫秒级，不起任何服务
//   第二层 集成测试   —— 起了 Prisma，但直接调 lib 里的函数，没有 HTTP
//   第三层 E2E        —— 真的起一个 Next 服务器、真的开一个 Chromium、
//                        真的点按钮。慢，但只有它能验证「整条链路接得上」
//
// 所以这一层只测一条黄金路径，不做全量覆盖 —— E2E 的价值在「证明系统
// 是活的」，不在于穷举分支（那是前两层的活）。
// ============================================================================

// 【为什么配置文件里要自己加载 .env】
// Playwright 不像 Next 和 Vitest 那样自动读 .env。而 E2E 用的连接串
// 需要里面那个密码，所以这里显式读一次。
// 读完之后 process.env.DATABASE_URL 就有值了（本地是 shopdev），
// 下面再把它改写成 E2E 库 —— 服务器地址、用户、密码都沿用 .env 里的。
const E2E_DB = "shope2e"

loadEnv()

const e2eUrl = urlForDatabase(process.env.DATABASE_URL!, E2E_DB)

// 【为什么除了 webServer.env，还要在这里改 process.env】
// webServer.env 只作用于被拉起的 next dev 子进程；而 config 这个进程
// （以及从它 fork 出去的 worker）有自己的环境变量 —— loadEnv() 把它设成了
// .env 里的 shopdev。这两行把 config 进程也指向 E2E 库。
//
// 【它现在不是「spec 写库的依靠」了】
// golden-path / order-note 以前直接 import prisma 翻订单状态，那时这一行
// 是必需的。它们现在改走 HTTP webhook（见 tests/e2e/helpers/stripe.ts），
// 已经不碰数据库。留着它纯属防御：万一将来某个 helper 在 config 进程里
// 漏了库访问，至少落到 e2e 库、而不是开发库 shopdev。
// （如果哪天要删，先确认 config 进程里真的没有 Prisma 引用。）
process.env.DATABASE_URL = e2eUrl
process.env.DIRECT_URL = e2eUrl

// 【必须用 localhost，不能图省事写 127.0.0.1】
// Next 16 的 dev server 会把「不是自己那个 origin」的 /_next/* 请求当成
// 跨站请求拦掉。服务器认的 origin 是 http://localhost:3100，
// 而 127.0.0.1 在它眼里是另一个 host —— 于是 HMR、客户端 chunk
// 全部被拒绝，页面永远加载不完，page.goto 就一直挂着不返回。
//
// 现象特别有迷惑性：服务器日志一切正常（"✓ Ready"、"Compiling /register"），
// 只有一行不起眼的 WARN 提到 cross-origin。所以这里写清楚，别再踩
const PORT = 3100
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: "tests/e2e",

  // 注意：入口是 `npm run test:e2e`，它走 scripts/test-e2e.mjs。
  // 那一层只做一件事 —— 把 System32 补进 PATH，好让 Playwright 结束时
  // 能真的杀掉自己的 dev server（原因写在那个文件里，值得一读）。
  // 别把它「简化」成直接的 playwright test

  // 【为什么不并发】
  // 所有用例共用同一个 E2E 库。黄金路径自己就会往库里写用户、购物车、
  // 订单，并发跑必然互相踩。E2E 本来就只有一条路径，串行是正确选择
  // （换到 PostgreSQL 之后这条理由不变，见 vitest.integration.config.mts）
  fullyParallel: false,
  workers: 1,

  // CI 上误留 test.only 会静默跳过其他用例，直接让构建失败
  forbidOnly: Boolean(process.env.CI),
  retries: 0,

  reporter: [["list"]],

  // 【为什么超时给得这么宽】
  // 用的是 next dev 而不是 next build + next start：dev 模式下每个路由
  // 是**第一次被访问时才编译**的。第一次打开 /products 可能要等十几秒
  // 做编译。E2E 的默认 30 秒超时经常不够，所以这里统一放宽
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    // 失败时留下现场：截图看画面、trace 可以逐帧回放点击过程
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // 【为什么数据库准备写进命令里，而不是 globalSetup】
    // Playwright 的 webServer 是在测试开始前拉起的，而探测「服务器就绪」
    // 的方式是去请求 url（这里是 /api/health —— 它要查库，查不到就 500）。
    // 如果建库放在 globalSetup 里，就可能出现「服务器先起来了、库还没建」
    // 的时序问题，health 一直 500，Playwright 干等到超时。
    //
    // 串在命令里就没有这个窗口：库建完，才轮到 next dev 启动
    command: `node scripts/e2e-db.mjs && node node_modules/next/dist/bin/next dev -p ${PORT}`,

    url: `${BASE_URL}/api/health`,
    // 复用一个已经在跑的服务器会让「这次到底连的哪个库」变得不确定，
    // 测试必须自己起一个干净的
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",

    env: {
      // next 的 @next/env 走 dotenv 语义：**已存在的环境变量优先**，
      // 所以这两行会盖掉 .env 里的 shopdev，让服务器连到 E2E 库
      //
      // 【为什么 DIRECT_URL 也要设】
      // 同 vitest.integration.config.mts 里那段说明：prisma7.config.ts 读的是
      // `DIRECT_URL || DATABASE_URL`，只设一半的话，哪条路径没覆盖到，
      // 它就会退回读 .env —— 于是「跑 E2E」变成「对着开发库跑迁移」
      DATABASE_URL: e2eUrl,
      DIRECT_URL: e2eUrl,

      // 【为什么必须另起一个构建目录】
      // Next 16 的 dev server 在 distDir 下放了一把独占锁，同一个项目
      // 目录只能跑一个。开发时你多半正开着 `npm run dev`，测试再起一个
      // 就会被拒。给 E2E 换个 distDir，锁和编译缓存都各走各的，
      // 你那个 dev server 也不会被打断（见 next.config.ts 的注释）
      NEXT_DIST_DIR: ".next-e2e",

      // 【为什么 E2E 也要 Stripe 的两个密钥】
      // golden-path / order-note 的「支付」现在走**真实 webhook**
      // （POST /api/webhooks/stripe），那条路由要 STRIPE_WEBHOOK_SECRET 验签、
      // 要 STRIPE_SECRET_KEY 才能构造出 getStripe()。
      //
      // 【为什么用 ?? 而不是直接写死 dummy】
      // 本地 .env 里有真的 sk_test_，stripe-checkout.spec.ts 要靠它建真 PI ——
      // 所以真值优先，只有 CI（没有 .env）才吃 dummy。
      // 两个 dummy 都只是「让代码能跑」，验签和构造都是纯本地计算，不校验值真假。
      //
      // 【为什么不改主进程的 process.env】
      // 那是进程级的，会漏给同一进程里别的测试。webServer.env 只作用于
      // 被拉起的这个 next dev 子进程，干净。
      //
      // 【webhook 密钥必须和 spec 里「签」用的那个一致】
      // 两边都走同一条式子：.env 有就用 .env 的，没有就退回 E2E_WEBHOOK_SECRET。
      // 本地 .env 目前没配它，所以两端都会落到同一个常量上。
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "sk_test_e2e_dummy",
      STRIPE_WEBHOOK_SECRET:
        process.env.STRIPE_WEBHOOK_SECRET ?? E2E_WEBHOOK_SECRET,
    },
  },
})
