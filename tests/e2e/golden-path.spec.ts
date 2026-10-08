import { expect, test, type Page } from "@playwright/test"

// ============================================================================
// 黄金路径 E2E：注册 → 搜索/筛选/排序 → 加购 → 下单 → 支付 → 发货 → 收货
//
// 【为什么只有这一条】
// 这条路径串起了项目里所有的「接缝」：
//   表单 → Server Action → zod 校验 → Prisma 事务 → cookie 会话
//   → 订单状态机 → 角色鉴权 → 页面跳转
// 前两层测试把每一段都单独测过了，但它们都绕开了 HTTP 和浏览器。
// 只有一个端到端用例能回答「这些东西拼在一起，用户真的能走通吗」。
//
// 再往上堆用例的边际收益很低 —— 而 E2E 是三层里最慢、最容易 flaky 的，
// 数量要克制。
//
// 【这一条为什么值得跑真的浏览器】
// 它验证了几件只有浏览器能验证的事：
//   - cookie 会话真的建立了（注册完刷新页面还是登录态）
//   - Server Action 的 redirect 真的把用户带到了正确页面
//   - 库存扣减在整个链路走完后，在页面上显示的数字是对的
// ============================================================================

/** 前后端共用的一套测试口令，改一处即可 */
const BUYER = {
  name: "端到端买家",
  password: "e2ePass123",
}
const ADMIN = { email: "admin@shop.dev", password: "admin123" }

/** 种子里那张「满 800 减 100」的券（见 prisma/seed.ts 的 COUPONS）*/
const COUPON = { code: "SAVE100", label: "满 800 减 100", discount: 10000 }

/**
 * 把「商品总额 / 优惠 / 实付」某一行右边的金额读出来，单位是分。
 *
 * 【为什么要「读」而不是把 79900 写死在断言里】
 * 种子里每款鞋的价格是按尺码上浮的（见 seed.ts 里 sizeSurcharge 那段），
 * 而黄金路径挑的是「第一个没被禁用」的 SKU —— 到底选中 899 还是 919，
 * 取决于哪个码断货。把金额写死，会让这条用例在有人动了种子库存之后
 * 莫名其妙地红，而那时真正要验的「减了 100 元」其实一点没坏。
 *
 * 读出来再算，断言就变成「实付 = 总额 - 100 元」—— 这才是这次要证明的事，
 * 换一款鞋也依然成立。
 */
async function readAmount(page: Page, label: string): Promise<number> {
  // 金额在标签右边那个 span 里。`..` 是「上一级」，也就是那一行
  const row = page.getByText(label, { exact: true }).locator("..")
  const text = await row.locator("span").last().innerText()

  // "¥899.00" → 89900；"-¥100.00" → -10000
  const negative = text.trim().startsWith("-")
  const value = Number(text.replace(/[^\d.]/g, ""))
  return Math.round(value * 100) * (negative ? -1 : 1)
}

test("注册 → 搜索/筛选/排序 → 加购 → 下单 → 支付 → 发货 → 确认收货", async ({
  page,
  browser,
}) => {
  // 每次跑用一个全新的邮箱：e2e.db 每次重建，但同一个测试文件重跑、
  // 或者中途失败后重试时，旧用户可能还在。加时间戳一劳永逸
  const email = `buyer-${Date.now()}@e2e.dev`

  // ==========================================================================
  // 1. 注册
  // ==========================================================================
  await page.goto("/register")
  await page.fill("#name", BUYER.name)
  await page.fill("#email", email)
  await page.fill("#password", BUYER.password)
  await page.getByRole("button", { name: "注册" }).click()

  // 注册成功会自动登录并跳到 /products（见 auth.ts 里的 safeNext 默认值）
  await page.waitForURL("**/products")

  // 顶部导航出现用户名 = 会话 cookie 真的写进去了。
  // 只断言 URL 是不够的：跳转可能是「注册成功但没登录」造成的
  await expect(
    page.getByRole("button", { name: new RegExp(BUYER.name) }),
  ).toBeVisible()

  // ==========================================================================
  // 2a. 搜索 → 分类筛选 → 价格排序
  // ==========================================================================
  // 【为什么这一段要放在加购之前走一遍】
  // 列表页的三个条件是否「互相保留」只有真开浏览器才知道：搜索词、分类、
  // 排序分别放在不同的控件里（form / 链接 / 链接），任何一处忘了带上
  // 另外两个，就会「搜完点个分类，搜索词没了」。集成测试直接调函数，
  // 测不到这一层 URL 的传递。
  // 种子数据 3 款鞋：跑步鞋(¥899)、篮球鞋(¥1299)、休闲鞋(¥399)。

  // 初始 3 款在售
  await expect(page.locator('a[href^="/products/"]')).toHaveCount(3)

  // 搜索「跑鞋」—— 只命中「疾风」轻量缓震跑鞋（描述里没有别的「跑鞋」）
  await page.getByLabel("搜索商品").fill("跑鞋")
  await page.getByRole("button", { name: "搜索" }).click()
  await page.waitForURL(/\?q=/)
  await expect(page.locator('a[href^="/products/"]')).toHaveCount(1)
  await expect(page.getByRole("link", { name: /疾风/ })).toBeVisible()

  // 生效的筛选以 chip 列出来，且能单独移除
  await expect(
    page.getByRole("link", { name: /移除筛选：搜索「跑鞋」/ }),
  ).toBeVisible()

  // 分类筛选：点「跑步鞋」，搜索词必须保留（hidden input / link 保住了 q）
  await page.getByRole("link", { name: "跑步鞋", exact: true }).click()
  await page.waitForURL(/category=/)
  await expect(page).toHaveURL(/q=/)
  await expect(page.locator('a[href^="/products/"]')).toHaveCount(1)

  // 排序：点「价格从低到高」，q 和 category 都要保留
  await page.getByRole("link", { name: "价格从低到高", exact: true }).click()
  await page.waitForURL(/sort=price_asc/)
  await expect(page).toHaveURL(/q=/)
  await expect(page).toHaveURL(/category=/)
  await expect(page.locator('a[href^="/products/"]')).toHaveCount(1)

  // ==========================================================================
  // 2. 进商品详情，选规格，加入购物车
  // ==========================================================================
  await page.locator('a[href^="/products/"]').first().click()
  await page.waitForURL(/\/products\/.+/)

  // 商品名留着后面比对购物车里的快照
  const productName = (await page.locator("h1").first().innerText()).trim()

  // 【选择器为什么不用 class 之外的写法】
  // 「颜色」和「尺码」两组按钮长得一模一样，只能靠它们各自的标题定位。
  // span:text-is() 是精确匹配 —— 尺码那组的「请先选择颜色」是个 <p>，
  // 且文本不等，不会被误命中
  const colorSection = page
    .locator("div.space-y-3")
    .filter({ has: page.locator('span:text-is("颜色")') })
  const sizeSection = page
    .locator("div.space-y-3")
    .filter({ has: page.locator('span:text-is("尺码")') })

  // 种子数据里有故意断码的 SKU（stock = 0，按钮置灰），
  // 所以必须挑「没被禁用」的第一个，不能无脑 .first()
  await colorSection.locator("button:not([disabled])").first().click()
  // 尺码按钮要等选完颜色才会渲染出来
  await sizeSection.locator("button:not([disabled])").first().click()

  // 选完两组规格，价格区应该出现「加入购物车」可点的状态
  const addButton = page.getByRole("button", { name: "加入购物车" })
  await expect(addButton).toBeEnabled()
  await addButton.click()

  // Sonner 的 toast —— 用户在这一步能看到的即时反馈
  await expect(page.getByText("已加入购物车", { exact: true })).toBeVisible()

  // ==========================================================================
  // 3. 购物车 → 领券 → 结算
  // ==========================================================================
  await page.goto("/cart")

  // 已登录用户看到的应该是「去结算」；如果是「登录后结算」，
  // 说明会话在上一步丢了。这条断言把问题定位在购物车，而不是等到下单才报错
  await expect(page.getByRole("link", { name: "去结算" })).toBeVisible()
  await expect(page.getByText(productName, { exact: false })).toBeVisible()

  // ---- 3a. 领一张券 ----
  // 【这一步为什么必须在 E2E 里走】
  // 领券是「INSERT ... SELECT ... WHERE」那条原生 SQL 唯一的用户入口，
  // 而这句话只有从浏览器点下去，才能证明整条链路（按钮 → Server Action
  // → 原生 SQL → 列表刷新）是通的。集成测试直接调 claimCoupon，
  // 绕开了前面两段
  await expect(page.getByRole("heading", { name: "可以领的优惠券" })).toBeVisible()

  const couponRow = page.locator("li").filter({ hasText: COUPON.code })
  await couponRow.getByRole("button", { name: "领取" }).click()

  await expect(page.getByText("领取成功", { exact: true })).toBeVisible()
  // 每人限领 1 张，领完按钮就封住了 —— 这一句同时证明了
  // perUserLimit 真的在服务端被读到了（不是前端算的）
  await expect(couponRow.getByRole("button", { name: "已领完" })).toBeVisible()

  // ---- 3b. 「我的券」里能看到它 ----
  await page.goto("/my-coupons")
  await expect(page.getByText(COUPON.label)).toBeVisible()
  await expect(page.getByText(COUPON.code)).toBeVisible()
  // 默认落在「未使用」那一栏
  await expect(page.getByRole("link", { name: /未使用/ })).toHaveAttribute(
    "aria-current",
    "page",
  )

  // ---- 3c. 回购物车去结算 ----
  await page.goto("/cart")
  await page.getByRole("link", { name: "去结算" }).click()
  await page.waitForURL("**/checkout")

  // ==========================================================================
  // 4. 选券 → 填收货信息 → 提交订单
  // ==========================================================================
  // 【为什么先记下「商品总额」】
  // 它是原价合计，选券之后不该变（变的是实付）。把它读出来，
  // 后面就能用「实付 = 总额 - 100 元」来断言，而不是把金额写死
  const itemsTotal = await readAmount(page, "商品总额")
  expect(itemsTotal).toBeGreaterThanOrEqual(80000) // 满 800 的门槛，券才可选

  // 选券前：实付 = 总额，而且不该有「优惠」这一行 ——
  // 没用券却显示「优惠 -¥0.00」看着像没生效
  expect(await readAmount(page, "实付")).toBe(itemsTotal)
  await expect(page.getByText("优惠", { exact: true })).toHaveCount(0)

  // 选中那张券（label 包着 radio，点文字就选中）
  await page.locator("label").filter({ hasText: COUPON.label }).click()

  // 金额当场就变 —— 不用等到服务端返回，这是这段交互的全部意义
  expect(await readAmount(page, "实付")).toBe(itemsTotal - COUPON.discount)
  await expect(
    page.getByText(`-¥${(COUPON.discount / 100).toFixed(2)}`, { exact: true }),
  ).toBeVisible()

  await page.fill("#address", "上海市浦东新区张江路 100 号 3 号楼 502")
  await page.fill("#phone", "13800138000")
  await page.getByRole("button", { name: "提交订单" }).click()

  // 下单成功后 redirect 到订单详情页
  await page.waitForURL(/\/orders\/[^/]+$/)

  const orderNo = (
    await page.locator("text=/^SO\\d+$/").first().innerText()
  ).trim()

  // ==========================================================================
  // 4b. 订单详情上的「原价 / 优惠 / 实付」
  // ==========================================================================
  // 【这一块为什么值得断言到「行」】
  // 只验实付金额是不够的：用户看到「799」只会更困惑（我买的明明是 899 的东西）。
  // 三行摆出来，数字自己就把话说完了 —— 所以验的正是「三行都在、
  // 而且说的是同一件事」
  await expect(page.getByText("商品总额", { exact: true })).toBeVisible()
  expect(await readAmount(page, "商品总额")).toBe(itemsTotal)

  // 券码也写在优惠那一行里：买家知道省的是哪张券，管理员对账时知道核销了哪张
  await expect(page.getByText(COUPON.code)).toBeVisible()
  await expect(
    page.getByText(`-¥${(COUPON.discount / 100).toFixed(2)}`, { exact: true }),
  ).toBeVisible()

  // 实付 = 原价 - 优惠。这个数是从页面上读出来的，不是写死的
  expect(await readAmount(page, "实付")).toBe(itemsTotal - COUPON.discount)

  // ==========================================================================
  // 5. 支付（模拟支付）
  // ==========================================================================
  await expect(page.getByRole("button", { name: "去支付" })).toBeVisible()
  await page.getByRole("button", { name: "去支付" }).click()
  await expect(page.getByText("支付成功", { exact: true })).toBeVisible()

  // 刷新一次，确认状态是真的落到数据库了，而不是只改了前端的乐观状态
  await page.reload()
  await expect(page.getByText("已支付", { exact: true })).toBeVisible()
  // 还没发货，不该出现确认收货按钮
  await expect(page.getByRole("button", { name: "确认收货" })).toHaveCount(0)

  // ==========================================================================
  // 6. 换管理员身份登录，发货
  // ==========================================================================
  // 【为什么要开一个新的 context】
  // 同一个 context 共用 cookie，用 adminPage 登录会把买家挤掉。
  // 新开一个 context = 新开一个「无痕窗口」，两个身份互不干扰
  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()

  // 带上 ?next= 直接落到订单列表，省一次跳转
  await adminPage.goto("/login?next=/admin/orders")
  await adminPage.fill("#email", ADMIN.email)
  await adminPage.fill("#password", ADMIN.password)
  await adminPage.getByRole("button", { name: "登录" }).click()
  await adminPage.waitForURL("**/admin/orders")

  // 按订单号定位到刚下的那一单（种子里没有订单，但这样更稳）
  await adminPage.getByRole("row", { name: new RegExp(orderNo) })
    .getByRole("link")
    .click()
  await adminPage.waitForURL(/\/admin\/orders\/[^/]+$/)

  // 管理员也应该看到这单用了哪张券、减了多少钱 ——
  // 对账时「这一单为什么只收了 799」得能查到出处。
  // 用的是和买家页完全同一个组件（OrderItemsCard），所以这里主要是
  // 证明「同一个组件在两个页面都拿到了券的数据」
  await expect(adminPage.getByText(COUPON.code)).toBeVisible()
  await expect(
    adminPage.getByText(`-¥${(COUPON.discount / 100).toFixed(2)}`, { exact: true }),
  ).toBeVisible()

  await adminPage.getByRole("button", { name: "确认发货" }).click()

  // 【为什么要 getByRole("main") 限定一下范围】
  // 发货成功会弹一个 toast，文案也正好是「已发货」，而 toast 挂在
  // <main> 之外的浮动区域里。于是 getByText("已发货") 会同时命中
  // 「状态徽章」和「toast」两个元素 —— Playwright 严格模式下直接判失败。
  //
  // 这条断言本来是想验「页面上的状态变了」，那就该只看 <main>。
  // 不限定范围的话，这个用例的成败取决于「toast 那 4 秒有没有过去」，
  // 也就是一个随机红的 flaky 测试 —— 比没有测试更糟
  await expect(
    adminPage.getByRole("main").getByText("已发货", { exact: true }),
  ).toBeVisible()

  // ==========================================================================
  // 6b. 后台首页看板
  // ==========================================================================
  // 【这一层能验什么，前两层验不了什么】
  // dashboard.test.ts 已经把每个数字算对了，但它验不到「页面渲染得出来」——
  // 卡片排版崩了、图标导入错了、Server Component 在渲染时才抛错，
  // 都只有真开一个浏览器才知道。
  await adminPage.goto("/admin")

  // 四张 KPI 卡片都在。这里断言的是「页面活着」，
  // 数字的正确性归第二层管，E2E 不做重复覆盖
  for (const label of ["今日订单数", "今日销售额", "待发货", "低库存规格"]) {
    await expect(adminPage.getByText(label, { exact: true })).toBeVisible()
  }

  // --------------------------------------------------------------------------
  // 卡片点进去，列表必须和卡片说的是同一件事
  // --------------------------------------------------------------------------
  // 【这是看板唯一真正会「伤人」的失败模式】
  // 数字算错，管理员发现得了；但「卡片写 1 笔、点进去 3 条」不会报错，
  // 只会让他从此不信这一页的任何数字。
  //
  // 此刻库里只有刚下的这一单，而且它确实是今天下的、今天付的款，
  // 所以两个下钻条件的答案都必须是「正好这一行」——
  // 这个断言是确定的，不需要迁就种子数据里有什么。
  await adminPage.locator('a[href="/admin/orders?range=today"]').click()
  await adminPage.waitForURL(/\/admin\/orders\?range=today$/)
  await expect(adminPage.locator("tbody tr")).toHaveCount(1)
  await expect(
    adminPage.getByRole("row", { name: new RegExp(orderNo) }),
  ).toBeVisible()

  await adminPage.goto("/admin")
  await adminPage.locator('a[href="/admin/orders?paidToday=1"]').click()
  await adminPage.waitForURL(/\/admin\/orders\?paidToday=1$/)
  await expect(adminPage.locator("tbody tr")).toHaveCount(1)
  await expect(
    adminPage.getByRole("row", { name: new RegExp(orderNo) }),
  ).toBeVisible()

  // 低库存那张卡片的链接也要能到地方。
  // 这里只断言「筛选条件生效了」（页头换成了低库存口径），
  // 不断言行数 —— 种子里有没有库存告急的 SKU 是另一回事
  await adminPage.goto("/admin")
  await adminPage.locator('a[href="/admin/products?stock=low"]').click()
  await adminPage.waitForURL(/\/admin\/products\?stock=low$/)
  await expect(adminPage.getByText(/低库存商品：/)).toBeVisible()

  // ==========================================================================
  // 6c. 商品搜索 + 批量操作
  // ==========================================================================
  // 【为什么这两件事必须在这一层测】
  // 搜索的过滤逻辑、批量操作的事务回滚，集成测试都直接调函数测过了。
  // 但这里有两块代码它们**一行都碰不到**：
  //   - 表头的「全选」复选框：indeterminate 是命令式设的 DOM 属性，
  //     没有对应的 HTML 属性，只能真的开浏览器看
  //   - 勾选状态 → 工具条启用 → 点按钮 → router.refresh() 后状态清空
  // 这条链路全是客户端状态，Server Action 直接调用是绕不过去的
  await adminPage.goto("/admin/products")

  // 种子数据里有「疾风」轻量缓震跑鞋 / 「灌篮」高帮实战篮球鞋 /
  // 「帆行」经典硫化帆布鞋。"跑鞋" 只命中第一款
  await adminPage.getByLabel("按商品名称搜索").fill("跑鞋")
  await adminPage.getByRole("button", { name: "搜索" }).click()

  // 条件进了 URL —— 这是搜索走 GET 表单的全部意义
  await adminPage.waitForURL(/\/admin\/products\?q=/)
  await expect(adminPage.locator("tbody tr")).toHaveCount(1)
  await expect(
    adminPage.getByRole("row", { name: /疾风/ }),
  ).toBeVisible()

  // 刷新之后搜索词还在：输入框的 defaultValue 来自 URL，
  // 而不是某个用完就丢的客户端 state
  await adminPage.reload()
  await expect(adminPage.getByLabel("按商品名称搜索")).toHaveValue("跑鞋")

  // 清空搜索要回到全量，而不是把整个筛选条件一起丢掉
  await adminPage.getByRole("link", { name: "清空搜索" }).click()
  await adminPage.waitForURL(/\/admin\/products$/)
  await expect(adminPage.locator("tbody tr")).toHaveCount(3)

  // ---- 批量下架 ----
  const targetRow = adminPage.getByRole("row", { name: /疾风/ })

  // 没勾任何东西时工具条该是禁用的 —— 否则点下去只会弹一个
  // 「请先勾选要操作的商品」的错误，等于让用户白点一次
  await expect(
    adminPage.getByRole("button", { name: "批量下架" }),
  ).toBeDisabled()

  await adminPage.getByLabel(/^选择 「疾风」/).check()
  await expect(
    adminPage.getByRole("button", { name: "批量下架" }),
  ).toBeEnabled()

  await adminPage.getByRole("button", { name: "批量下架" }).click()

  // 提示语要说清改了几款。只说「操作成功」的话，
  // 管理员没法确认是不是只改了他勾的那一款
  await expect(adminPage.getByText("已下架 1 款商品")).toBeVisible()

  // 反应到列表上。这里限定在目标行里找 ——
  // 「已下架」这三个字在页面别处（筛选标签）也出现过
  await expect(targetRow.getByText("已下架", { exact: true })).toBeVisible()

  // ---- 改回来，别给后续步骤留个下架的商品 ----
  await adminPage.getByLabel(/^选择 「疾风」/).check()
  await adminPage.getByRole("button", { name: "批量上架" }).click()
  await expect(adminPage.getByText("已上架 1 款商品")).toBeVisible()
  await expect(targetRow.getByText("在售", { exact: true })).toBeVisible()

  // 操作成功后勾选要清空。留着的话，下一次点击会**重复**作用于
  // 上一次勾的那些商品 —— 而管理员以为自己只勾了新的
  await expect(
    adminPage.getByRole("button", { name: "批量下架" }),
  ).toBeDisabled()

  await adminContext.close()

  // ==========================================================================
  // 7. 回到买家，确认收货
  // ==========================================================================
  await page.reload()
  await expect(page.getByText("已发货", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "确认收货" }).click()
  await expect(page.getByText("已确认收货", { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByText("已完成", { exact: true })).toBeVisible()

  // ==========================================================================
  // 8. 收尾：不该再有可操作的按钮
  // ==========================================================================
  await expect(page.getByRole("button", { name: "确认收货" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "去支付" })).toHaveCount(0)

  // ==========================================================================
  // 9. 申请退款 → 管理员批准 → 买家看到退款金额
  // ==========================================================================
  // 【为什么这一段接在「已完成」后面，而不是新开一条用例】
  // 退款要验的核心是「退的是实付（799）不是原价（899）」—— 而这个数
  // 只有在**这一单用了券**的前提下才有意义。新开一条用例的话，
  // 得把注册、下单、领券、用券、支付又走一遍，中间任何一步 flaky
  // 都会让退款这一段跟着红，排查时却指不到退款头上。
  //
  // 【这一段只有浏览器能验的地方】
  //   1. 「申请退款」按钮出现的时机（COMPLETED 才出现）
  //   2. 提交后订单要**当场**变成「退款处理中」，按钮消失
  //   3. 管理员批准之后，买家的页面上出现的是**钱数**，不是一个状态词
  // 前两层里，第 3 条是最容易做得「技术上对、用户看不懂」的地方。

  // 实付（= 退款金额）。这一单用了满 800 减 100 的券
  const expectedRefund = itemsTotal - COUPON.discount

  await expect(page.getByRole("button", { name: "申请退款" })).toBeVisible()
  await page.getByRole("button", { name: "申请退款" }).click()

  // 原因是原生 select，值要能在提交时进 FormData
  await page.selectOption("#refund-reason", "SIZE")
  await page.fill("#refund-description", "43 码偏大半码，想退掉")
  await page.getByRole("button", { name: "提交申请" }).click()

  await expect(page.getByText("退款申请已提交", { exact: true })).toBeVisible()

  // 刷新确认状态真的落到库里了，而不是只改了前端的乐观状态
  await page.reload()
  await expect(page.getByText("退款处理中", { exact: true }).first()).toBeVisible()
  // 申请提交之后不该还能再点一次
  await expect(page.getByRole("button", { name: "申请退款" })).toHaveCount(0)
  // 退款中的订单也不该还能确认收货
  await expect(page.getByRole("button", { name: "确认收货" })).toHaveCount(0)

  // ---- 9b. 管理员批准 ----
  const refundAdminContext = await browser.newContext()
  const refundAdminPage = await refundAdminContext.newPage()

  await refundAdminPage.goto("/login?next=/admin/refunds")
  await refundAdminPage.fill("#email", ADMIN.email)
  await refundAdminPage.fill("#password", ADMIN.password)
  await refundAdminPage.getByRole("button", { name: "登录" }).click()
  await refundAdminPage.waitForURL("**/admin/refunds")

  // 默认就落在「待处理」这一栏，列表里应该有刚提交的那一条
  const refundRow = refundAdminPage
    .getByRole("row", { name: new RegExp(orderNo) })
  await expect(refundRow).toBeVisible()
  // 列表上的金额必须就是实付 —— 管理员点批准之前最该核对的数字。
  // 用 expectedRefund 而不是写死 799.00：种子里每款鞋的价格按尺码上浮，
  // 选中哪一双是运行期定的（详见 readAmount 的注释）
  await expect(refundRow).toContainText(
    `¥${(expectedRefund / 100).toFixed(2)}`,
  )

  await refundRow.getByRole("link", { name: "去处理" }).click()
  await refundAdminPage.waitForURL(/\/admin\/refunds\/[^/]+$/)

  await expect(
    refundAdminPage.getByText("尺码不合适", { exact: true }),
  ).toBeVisible()
  await refundAdminPage.getByRole("button", { name: "批准退款" }).click()

  await expect(
    refundAdminPage.getByText("已批准退款", { exact: true }),
  ).toBeVisible()

  await refundAdminContext.close()

  // ---- 9c. 买家看到钱数 ----
  await page.reload()

  // 这条断言是整段的重点：买家看到的必须是**退多少钱**，
  // 而不只是「已退款」三个字
  await expect(
    page.getByText(`已退款 ¥${(expectedRefund / 100).toFixed(2)}`, {
      exact: true,
    }),
  ).toBeVisible()
  // 时间轴上也留了痕迹
  await expect(page.getByText("退款时间", { exact: true })).toBeVisible()

  // ---- 9d. 券回到了「未使用」 ----
  // 【为什么这条一定要在浏览器里验】退款回滚 usedCount 之后再领/再用，
  // 是最容易被写漏的一环（集成测试验的是库里的数字，这里验的是
  // 用户真的能在界面上再看到这张券）
  await page.goto("/my-coupons")
  await expect(page.getByText(COUPON.code)).toBeVisible()
  await expect(page.getByRole("link", { name: "去使用" })).toBeVisible()
})
