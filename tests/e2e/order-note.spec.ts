import { expect, test } from "@playwright/test"

// ============================================================================
// 订单备注 E2E：下单时写 → 详情页改/清空 → 管理员看到 → 发货后锁死
//
// 【为什么这一层非测不可】
// 单元和集成测试已经把「谁能改、改成什么」钉死了。但下面这几件事它们一行
// 都碰不到：
//   - 结算页那个 textarea 真的把值带进了 FormData（字段名对不上就静默丢失，
//     服务端收到的就是空字符串 —— 类型检查一点忙都帮不上）
//   - OrderNoteCard 的「编辑 / 保存 / 清空」三段式交互真的能走通
//   - editable 这个 prop 是**服务端按状态算好传下来的**：发货之后再打开
//     同一张订单，编辑入口是不是真的消失了
//   - 管理员那一页真的渲染出了买家写的那句话（打包的人靠它干活）
//
// 【为什么要走一整条下单流程，而不是像 reviews 那样用种子订单】
// 种子里那笔 SO-DEMO-0001 是已完成的，备注只读 —— 它能覆盖「锁死」那一半，
// 但覆盖不了「写进去、再改、再清空」这一半。与其分两个用例，不如一条走完：
// 用户下单时写备注，一路改到发货，正好把备注的整个生命周期串成一条线。
// ============================================================================

const ADMIN = { email: "admin@shop.dev", password: "admin123" }

/** 结算页填的那句，后面要在订单详情页按它找 */
const NOTE_AT_CHECKOUT = "请工作日送达，放门口快递柜就行"
/** 后来改成的那句 */
const NOTE_EDITED = "改成周末送吧，工作日家里没人"
/** 清空后又重新添上的一句 */
const NOTE_READDED = "还是工作日送，记得放柜子里"

test("下单写备注 → 详情页改 → 管理员看到 → 发货后锁定", async ({
  page,
  browser,
}) => {
  // ==========================================================================
  // 1. 注册一个全新买家（每次跑都用新邮箱，理由见 golden-path.spec.ts）
  // ==========================================================================
  const email = `note-buyer-${Date.now()}@e2e.dev`

  await page.goto("/register")
  await page.fill("#name", "备注测试买家")
  await page.fill("#email", email)
  await page.fill("#password", "e2ePass123")
  await page.getByRole("button", { name: "注册" }).click()
  await page.waitForURL("**/products")

  // ==========================================================================
  // 2. 加购 → 结算，在结算页写下备注
  // ==========================================================================
  await page.locator('a[href^="/products/"]').first().click()
  await page.waitForURL(/\/products\/.+/)

  // 颜色和尺码两组按钮长得一样，只能靠各自的小标题定位（同 golden-path）
  const colorSection = page
    .locator("div.space-y-3")
    .filter({ has: page.locator('span:text-is("颜色")') })
  const sizeSection = page
    .locator("div.space-y-3")
    .filter({ has: page.locator('span:text-is("尺码")') })

  // 种子里有故意断码（stock = 0）的 SKU，所以挑第一个没被禁用的
  await colorSection.locator("button:not([disabled])").first().click()
  await sizeSection.locator("button:not([disabled])").first().click()

  await page.getByRole("button", { name: "加入购物车" }).click()
  await expect(page.getByText("已加入购物车", { exact: true })).toBeVisible()

  await page.goto("/cart")
  await page.getByRole("link", { name: "去结算" }).click()
  await page.waitForURL("**/checkout")

  await page.fill("#address", "上海市浦东新区张江路 100 号 3 号楼 502")
  await page.fill("#phone", "13800138000")

  // 【这一步是整条用例的起点，也是最容易静默失败的地方】
  // textarea 的 name 必须是 "note"、createOrderAction 必须去读它 ——
  // 任何一头对不上，备注都会变成「没填」，而页面上不会有任何报错
  await page.fill("#note", NOTE_AT_CHECKOUT)

  await page.getByRole("button", { name: "提交订单" }).click()
  await page.waitForURL(/\/orders\/[^/]+$/)

  // 记下订单号，后面管理员要靠它找到这一单
  const orderNo = (
    await page.locator("text=/^SO\\d+$/").first().innerText()
  ).trim()

  // 记住用户自己那句备注留下的痕迹 —— 下面要反复看这一页
  const orderUrl = page.url()

  // ==========================================================================
  // 3. 下单后立刻能看到自己写的那句话
  // ==========================================================================
  // 【为什么要断言「能看到」，而不是直接去数据库查】
  // 查库只能证明写进去了。这里要同时证明：服务端把它取出来了、
  // OrderDetail 上有 note 这个字段、组件把它渲染出来了 —— 三段里断哪一段
  // 用户看到的都是「我明明写了备注，怎么没了」
  await expect(page.getByText("订单备注")).toBeVisible()
  await expect(page.getByText(NOTE_AT_CHECKOUT)).toBeVisible()

  // 待支付状态还允许改，所以「修改」按钮应该在场
  const editButton = page.getByRole("button", { name: "修改" })
  await expect(editButton).toBeVisible()
  // 反过来，锁死时才会出现的那句话现在不该有
  await expect(page.getByText(/备注不能再修改/)).toHaveCount(0)

  // ==========================================================================
  // 4. 改一句，然后刷新验证
  // ==========================================================================
  await editButton.click()

  // 编辑态里是个 textarea，id 固定为 order-note
  await page.fill("#order-note", NOTE_EDITED)
  await page.getByRole("button", { name: "保存" }).click()

  await expect(page.getByText("备注已保存", { exact: true })).toBeVisible()
  await expect(page.getByText(NOTE_EDITED)).toBeVisible()

  // 【为什么一定要刷新】
  // OrderNoteCard 改完之后**故意不调 router.refresh()** —— 它把新备注存在
  // 自己的 state 里了。于是「页面上显示对了」这件事证明不了数据库里也对，
  // 可能只是本地 state 变了而已。reload 之后还能看到，才是真的落了库
  await page.reload()
  await expect(page.getByText(NOTE_EDITED)).toBeVisible()
  await expect(page.getByText(NOTE_AT_CHECKOUT)).toHaveCount(0)

  // ==========================================================================
  // 5. 清空备注
  // ==========================================================================
  await page.getByRole("button", { name: "修改" }).click()
  await page.fill("#order-note", "")
  await page.getByRole("button", { name: "保存" }).click()

  // 清空和保存是不同的提示语 —— 用户得知道自己是「写了一句」还是「擦掉了」
  await expect(page.getByText("备注已清空", { exact: true })).toBeVisible()
  // 空备注有它自己的空状态文案，不是一片空白
  await expect(page.getByText(/还没有备注/)).toBeVisible()

  await page.reload()
  await expect(page.getByText(/还没有备注/)).toBeVisible()
  // 按钮从「修改」变回「添加」—— 因为现在没东西可改
  await expect(page.getByRole("button", { name: "添加" })).toBeVisible()

  // ==========================================================================
  // 6. 重新添加
  // ==========================================================================
  await page.getByRole("button", { name: "添加" }).click()
  await page.fill("#order-note", NOTE_READDED)
  await page.getByRole("button", { name: "保存" }).click()

  await expect(page.getByText(NOTE_READDED)).toBeVisible()
  // 添加完之后按钮该叫「修改」了
  await expect(page.getByRole("button", { name: "修改" })).toBeVisible()

  // ==========================================================================
  // 7. 管理员那一页要看得到这句话
  // ==========================================================================
  // 【为什么这块必须验】买家写备注是写给打包的人看的，而打包的人看的正是
  // 后台这一页。备注前台显示得再漂亮，后台看不到就等于没写
  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()

  await adminPage.goto("/login?next=/admin/orders")
  await adminPage.fill("#email", ADMIN.email)
  await adminPage.fill("#password", ADMIN.password)
  await adminPage.getByRole("button", { name: "登录" }).click()
  await adminPage.waitForURL("**/admin/orders")

  await adminPage
    .getByRole("row", { name: new RegExp(orderNo) })
    .getByRole("link")
    .click()
  await adminPage.waitForURL(/\/admin\/orders\/[^/]+$/)

  // 【为什么用 getByRole("heading") 而不是 getByText】
  // "买家" 那张卡片（买家姓名 + 邮箱）紧挨在上面，它的文本拼起来是
  // 「买家备注测试买家note-buyer-…」—— 里面**正好**含有「买家备注」四个字，
  // getByText 会连它一起命中，严格模式直接判失败。
  // （注册时随便起的名恰好凑出了这个巧合，换成 heading 就不看运气了）
  await expect(adminPage.getByRole("heading", { name: "买家备注" })).toBeVisible()
  await expect(adminPage.getByText(NOTE_READDED)).toBeVisible()

  // ==========================================================================
  // 8. 买家付款 —— 已支付但还没发货，备注仍然能改
  // ==========================================================================
  // 【为什么这一条值得单独走一遍】「发货前能改」在代码里是
  // PENDING_PAYMENT **和** PAID 两个状态。只测了待支付就以为发货前都能改，
  // 是很容易漏的一格 —— 而漏掉它的后果是：付完款发现写错地址备注却改不了
  await page.getByRole("button", { name: "去支付" }).click()
  await expect(page.getByText("支付成功", { exact: true })).toBeVisible()
  await page.reload()

  await expect(page.getByText("已支付", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "修改" })).toBeVisible()

  // ==========================================================================
  // 9. 管理员发货 → 备注立刻锁死
  // ==========================================================================
  // 【这一页必须重新加载】管理员那张页面是第 7 步打开的，那时候订单还是
  // 「待支付」；「确认发货」那一块只在 PAID 时才渲染出来，所以不刷新的话
  // 按钮根本不在 DOM 里，会一直等到超时。
  // （这不是被测代码的毛病 —— 页面是真的旧了，现实中管理员也得刷新）
  await adminPage.reload()
  await adminPage.getByRole("button", { name: "确认发货" }).click()
  await expect(
    adminPage.getByRole("main").getByText("已发货", { exact: true }),
  ).toBeVisible()

  await adminPage.reload()
  // 发货不会动备注，包裹里那张纸上写的还是最新那句
  await expect(adminPage.getByText(NOTE_READDED)).toBeVisible()

  await adminContext.close()

  // 买家这边刷新 —— 编辑入口必须消失
  await page.goto(orderUrl)
  await expect(page.getByText("已发货", { exact: true })).toBeVisible()

  // 备注原文还在（还能回看自己交代过什么）
  await expect(page.getByText(NOTE_READDED)).toBeVisible()
  // 但改不了了：按钮没了，而且**说明了原因**。
  // 只把按钮拿掉的话，用户会以为是页面出错了、找不到入口
  await expect(page.getByRole("button", { name: "修改" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "添加" })).toHaveCount(0)
  await expect(page.getByText(/备注不能再修改/)).toBeVisible()
})
