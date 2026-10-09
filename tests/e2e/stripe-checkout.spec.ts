import { expect, test } from "@playwright/test"

// ============================================================================
// Stripe 收银台 E2E：点「去支付」→ 弹出收银台，而不是直接翻状态
//
// 【为什么单独一条 spec，而且 CI 上跳过】
// 真实的收银台需要 js.stripe.com 的脚本、需要一个配好的 publishable key，
// 这两样 CI 上都没有。所以它只在本地跑（本地 .env 里有 pk_test_ 开头的 key）。
//
// 【这条 spec 断言的是「我们的 DOM」，不是 Stripe 的 iframe】
// <PaymentElement> 内部是 js.stripe.com 渲染的一个 iframe，它的结构随时会变，
// 断言它等于把测试绑到第三方页面上。我们只验自己写的东西：
//   1. 点「去支付」后，收银台对话框真的弹出来了（标题 + 表单里的「支付」按钮）
//   2. 订单状态还是「待支付」—— 建 PaymentIntent 不翻状态，翻状态等 webhook
//
// 真正把卡号填进去付完款的完整链路（4242 测试卡 + stripe listen 转发 webhook）
// 是**手动**验证的，不写成自动化 —— 见 src/lib/stripe-payment.ts 顶部那段分工。
// ============================================================================

test.skip(!!process.env.CI, "需要真实的 Stripe 环境，只在本地跑")

test("点「去支付」→ 弹出收银台，状态仍是待支付", async ({ page }) => {
  // 注册一个全新买家（每次跑用新邮箱，理由见 golden-path.spec.ts）
  const email = `stripe-buyer-${Date.now()}@e2e.dev`

  await page.goto("/register")
  await page.fill("#name", "收银台测试买家")
  await page.fill("#email", email)
  await page.fill("#password", "e2ePass123")
  await page.getByRole("button", { name: "注册" }).click()
  await page.waitForURL("**/products")

  // 进商品详情，选规格，加购（选择器和 golden-path 一致）
  await page.locator('a[href^="/products/"]').first().click()
  await page.waitForURL(/\/products\/.+/)

  const colorSection = page
    .locator("div.space-y-3")
    .filter({ has: page.locator('span:text-is("颜色")') })
  const sizeSection = page
    .locator("div.space-y-3")
    .filter({ has: page.locator('span:text-is("尺码")') })

  await colorSection.locator("button:not([disabled])").first().click()
  await sizeSection.locator("button:not([disabled])").first().click()
  await page.getByRole("button", { name: "加入购物车" }).click()
  await expect(page.getByText("已加入购物车", { exact: true })).toBeVisible()

  // 结算 → 下单
  await page.goto("/cart")
  await page.getByRole("link", { name: "去结算" }).click()
  await page.waitForURL("**/checkout")
  await page.fill("#address", "上海市浦东新区张江路 100 号 3 号楼 502")
  await page.fill("#phone", "13800138000")
  await page.getByRole("button", { name: "提交订单" }).click()
  await page.waitForURL(/\/orders\/[^/]+$/)

  // 待支付状态下有「去支付」按钮
  await expect(page.getByRole("button", { name: "去支付" })).toBeVisible()

  // 点下去 —— 建 PaymentIntent、弹收银台
  await page.getByRole("button", { name: "去支付" }).click()

  // 断言我们的 DOM：对话框标题 + 表单里的「支付」提交按钮。
  // 用 exact:true 圈定，否则会误命中背后那个「去支付」按钮
  await expect(page.getByText("完成支付", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "支付", exact: true }),
  ).toBeVisible()

  // 建 PaymentIntent 不翻状态：状态徽章应该还是「待支付」，
  // 要等用户真的付了钱、webhook 回来才会变「已支付」
  await expect(page.getByText("待支付", { exact: true })).toBeVisible()
})
