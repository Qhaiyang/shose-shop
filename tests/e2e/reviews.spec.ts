import { expect, test } from "@playwright/test"

// ============================================================================
// 商品评价 E2E：买家评价 → 详情页显示 → 管理员下架 → 详情页消失
//
// 【为什么这一层非测不可，前两层测不到什么】
// 单元测试钉死了星级和分布图的数学，集成测试钉死了「谁能评价」的规则。
// 但下面这些它们一行都碰不到：
//   - 「去评价」按钮真的出现在已完成订单的行里（要靠 productId +
//     reviewId 两个关联字段一路从数据库传到组件）
//   - 展开表单 → 提交 → router.refresh() 之后那一行变成「已评价」
//   - 详情页的评价区真的渲染出来了，分数、分布条、列表都对得上
//   - 管理员下架之后，同一个商品的详情页上那条真的不见了
//
// 【为什么这条路径能用种子数据走通】
// prisma/seed.ts 里种了一笔已完成订单（SO-DEMO-0001，属于 user@shop.dev，
// 两个订单项），所以这里不用把「下单 → 支付 → 发货 → 收货」再走一遍。
// 那条链路归 golden-path.spec.ts 管。
// ============================================================================

const BUYER = { email: "user@shop.dev", password: "user123" }
const ADMIN = { email: "admin@shop.dev", password: "admin123" }

/** 评价内容，后面在详情页上要按它找这条评价 */
const REVIEW_TEXT = "鞋码很标准，跑了两次脚感很弹，鞋面透气不闷"

test("买家评价 → 详情页显示 → 管理员下架 → 详情页消失", async ({
  page,
  browser,
}) => {
  // ==========================================================================
  // 1. 买家登录，打开那笔已完成的演示订单
  // ==========================================================================
  await page.goto("/login?next=/orders")
  await page.fill("#email", BUYER.email)
  await page.fill("#password", BUYER.password)
  await page.getByRole("button", { name: "登录" }).click()
  await page.waitForURL("**/orders")

  // 种子里只有这一笔订单，按单号点进去 —— 比 .first() 更能说明点的是哪一单
  await page.getByRole("link", { name: /SO-DEMO-0001/ }).click()
  await page.waitForURL(/\/orders\/[^/]+$/)

  // 记住订单详情页的地址：后面第 5 步会把买家页面带去商品详情页，
  // 最后一步要回来 —— 订单 id 是随机的，只能在这里存下来
  const orderUrl = page.url()

  await expect(page.getByText("已完成", { exact: true })).toBeVisible()

  // ==========================================================================
  // 2. 「去评价」是按件出现的，不是整单一个
  // ==========================================================================
  // 演示订单里有两款鞋：「疾风」跑鞋和「帆行」帆布鞋。
  // 每件都能单独评价（一件商品一条评价），所以按钮应该有两个
  const reviewButtons = page.getByRole("button", { name: "去评价" })
  await expect(reviewButtons).toHaveCount(2)

  // 定位到「疾风」那一行 —— 表单会展开在这一行里面
  const runningRow = page.getByRole("listitem").filter({ hasText: "疾风" })

  await runningRow.getByRole("button", { name: "去评价" }).click()

  // ==========================================================================
  // 3. 填评价：选星级 + 写内容
  // ==========================================================================
  // 星级是五个按钮，可访问名就是「N 星」（见 review-button.tsx 的 aria-label）
  await runningRow.getByRole("button", { name: "5 星" }).click()

  // 选完星级，旁边那句提示要跟着变 —— 用户得知道自己在提交几星
  await expect(runningRow.getByText("5 星 · 非常满意")).toBeVisible()

  await runningRow.getByLabel("评价").fill(REVIEW_TEXT)
  await runningRow.getByRole("button", { name: "提交评价" }).click()

  // ==========================================================================
  // 4. 提交后的反馈
  // ==========================================================================
  await expect(page.getByText("评价已提交", { exact: true })).toBeVisible()

  // 刷新会重新跑服务端组件，那一行的按钮应该换成「已评价」——
  // 这是 orderItem.review 关联真的通了的证据
  await expect(runningRow.getByText("已评价")).toBeVisible()
  // 另外一件还没评，按钮还在
  await expect(page.getByRole("button", { name: "去评价" })).toHaveCount(1)

  // ==========================================================================
  // 5. 商品详情页上能看到这条评价
  // ==========================================================================
  await page.goto("/products/prod_running")

  await expect(page.getByRole("heading", { name: "用户评价" })).toBeVisible()

  // 【为什么要限定在 #reviews 里找】
  // 顶部导航上也挂着登录用户的昵称，直接 getByText("张小明") 会同时命中
  // 导航和评价作者两处，Playwright 严格模式直接判失败。
  // 评价区有 id="reviews" 这个锚点（翻页链接也靠它），正好拿来圈定范围
  const reviewSection = page.locator("#reviews")

  // 只有这一条，所以条数和平均分都是确定的，不需要迁就别的数据
  await expect(reviewSection.getByText("共 1 条")).toBeVisible()
  await expect(reviewSection.getByText("5.0")).toBeVisible()
  await expect(reviewSection.getByText(REVIEW_TEXT)).toBeVisible()
  // 评价人昵称（种子账号 user@shop.dev 的昵称是「张小明」）
  await expect(reviewSection.getByText("张小明")).toBeVisible()

  // ==========================================================================
  // 6. 换管理员身份，去后台把这条评价下架
  // ==========================================================================
  // 新开一个 context：同一个 context 共用 cookie，用 adminPage 登录会把买家挤掉
  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()

  await adminPage.goto("/login?next=/admin/reviews")
  await adminPage.fill("#email", ADMIN.email)
  await adminPage.fill("#password", ADMIN.password)
  await adminPage.getByRole("button", { name: "登录" }).click()
  await adminPage.waitForURL("**/admin/reviews")

  const adminRow = adminPage.getByRole("row").filter({ hasText: "疾风" })
  await expect(adminRow).toBeVisible()
  // 后台的列表里必须能看到评价人的邮箱（要联系得上人），
  // 这和买家侧公开页面刚好相反
  await expect(adminRow.getByText(BUYER.email)).toBeVisible()

  await adminRow.getByRole("button", { name: "下架" }).click()

  // 断言 toast 的**描述**而不是标题：标题「已下架」和表格里的状态徽章
  // 一字不差，用标题会同时命中两处，严格模式下直接判失败。
  // （golden-path 里踩过同一个坑，那里是靠限定 <main> 绕开的）
  await expect(
    adminPage.getByText("前台不再显示这条评价，记录仍保留"),
  ).toBeVisible()

  // 【为什么断言「行还在、只是标了已下架」】
  // 这正是软删除和真删除的差别。如果这里直接查数据库，就只能证明
  // 「列表里没有」；断言这一行仍然在页面上、并且带着「已下架」的标记，
  // 才说明管理员复查得回来
  await expect(adminRow.getByText("已下架")).toBeVisible()
  await expect(adminRow.getByText(REVIEW_TEXT)).toBeVisible()

  // ==========================================================================
  // 7. 前台详情页上这条评价消失了
  // ==========================================================================
  await adminPage.goto("/products/prod_running")

  await expect(adminPage.getByText("共 0 条")).toBeVisible()
  await expect(adminPage.getByText(REVIEW_TEXT)).toHaveCount(0)

  await adminContext.close()

  // ==========================================================================
  // 8. 买家那边「已评价」的状态不受影响
  // ==========================================================================
  // 【为什么这一条重要】如果软删除是「删掉行」，orderItem 上的 review 关联
  // 就会变空，用户会看到「去评价」按钮又冒出来 —— 于是可以反复刷评价。
  // 这里在买家自己的页面上确认按钮没有回来。
  //
  // 注意是 goto(orderUrl) 而不是 reload()：第 5 步已经把买家页面带到
  // 商品详情页去了，那条 URL 上根本没有「去评价」按钮，reload 会一直等
  // 一个不存在的元素。（第一版就是这么挂的。）
  // goto 同时是更硬的证据 —— 它是一次全新的文档请求，服务端组件必须重跑，
  // 浏览器里存着的任何旧界面都留不下来
  await page.goto(orderUrl)
  await expect(runningRow.getByText("已评价")).toBeVisible()
  await expect(page.getByRole("button", { name: "去评价" })).toHaveCount(1)
})
