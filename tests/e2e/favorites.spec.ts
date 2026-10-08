import { expect, test } from "@playwright/test"

// ============================================================================
// 商品收藏 E2E：未登录被挡 → 登录 → 收藏 → 收藏夹里能看到 → 取消 → 消失
//
// 【为什么这一层非测不可，前两层测不到什么】
// 单元测试钉住了「商品行怎么变成卡片数据」，集成测试钉住了「幂等、
// 按人隔离、下架不显示」。但下面这些它们一行都碰不到：
//   - 未登录点心形真的会被带去登录页，而且登录完真的回到这款鞋
//   - 心形点下去**立刻**变实心（乐观更新），不是等一个往返
//   - 刷新页面之后还是「已收藏」—— 证明状态存在数据库里，不是本地状态
//   - 「我的收藏」页真的把卡片画出来了
//
// 【为什么整个流程只用一款鞋】
// 收藏夹里东西一多，断言就得迁就别的数据（「共 3 款」到底哪 3 款）。
// 种子数据里 user@shop.dev 没有任何收藏，所以从零开始，
// 每一步的数量都是确定的
// ============================================================================

const BUYER = { email: "user@shop.dev", password: "user123" }

/** 种子里那款跑鞋，详情页地址固定 */
const PRODUCT_URL = "/products/prod_running"
const PRODUCT_NAME = "「疾风」轻量缓震跑鞋"

test("未登录点收藏 → 去登录 → 收藏成功 → 我的收藏里能看到 → 取消后消失", async ({
  page,
}) => {
  // ==========================================================================
  // 1. 游客身份点收藏，被带去登录页
  // ==========================================================================
  await page.goto(PRODUCT_URL)

  // 【为什么要 exact: true】
  // Playwright 按可访问名匹配时默认是**子串**匹配，而「收藏」是
  // 「已收藏」的子串 —— 不加 exact，两个状态的按钮会同时命中，
  // 严格模式下直接判失败
  const favoriteButton = page.getByRole("button", {
    name: "收藏",
    exact: true,
  })
  await expect(favoriteButton).toBeVisible()

  await favoriteButton.click()

  // 先把话说清楚再跳走 —— 用户得知道为什么突然到了登录页
  await expect(page.getByText("登录之后就能收藏了")).toBeVisible()
  // next 要带上，登录完直接回到这款鞋，不用自己再找一遍
  await page.waitForURL(/\/login\?next=.*prod_running/)

  // ==========================================================================
  // 2. 登录，应该被打回刚才那款鞋
  // ==========================================================================
  await page.fill("#email", BUYER.email)
  await page.fill("#password", BUYER.password)
  await page.getByRole("button", { name: "登录" }).click()

  // 落到商品页而不是首页 —— 这就是 next 生效的证据
  await page.waitForURL(`**${PRODUCT_URL}`)

  // ==========================================================================
  // 3. 收藏：心形立刻变实心
  // ==========================================================================
  await expect(favoriteButton).toBeVisible()
  await favoriteButton.click()

  await expect(
    page.getByRole("button", { name: "已收藏", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("已加入收藏")).toBeVisible()

  // ==========================================================================
  // 4. 刷新页面，状态还在
  // ==========================================================================
  // 【为什么这一步不能省】如果收藏只存在组件的 useState 里，
  // 上面那一步照样会过 —— 只有一次全新的文档请求才能证明
  // 状态是从数据库读回来的
  await page.goto(PRODUCT_URL)

  await expect(
    page.getByRole("button", { name: "已收藏", exact: true }),
  ).toBeVisible()

  // ==========================================================================
  // 5. 导航菜单里的入口 -> 我的收藏
  // ==========================================================================
  // 点开右上角昵称下拉
  await page.getByRole("button", { name: "张小明" }).click()

  // 【为什么按 href 定位而不是 getByRole("link")】
  // base-ui 会给下拉项套上 role="menuitem"，这时候
  // getByRole("link") 是找不到它的。href 是唯一且不会变的东西
  await page.locator('a[href="/favorites"]').click()
  await page.waitForURL("**/favorites")

  await expect(page.getByRole("heading", { name: "我的收藏" })).toBeVisible()
  await expect(page.getByText("共 1 款鞋")).toBeVisible()
  await expect(page.getByText(PRODUCT_NAME)).toBeVisible()

  // ==========================================================================
  // 6. 点卡片回到详情页，取消收藏
  // ==========================================================================
  await page.getByText(PRODUCT_NAME).click()
  await page.waitForURL(`**${PRODUCT_URL}`)

  await page.getByRole("button", { name: "已收藏", exact: true }).click()

  await expect(
    page.getByRole("button", { name: "收藏", exact: true }),
  ).toBeVisible()
  await expect(page.getByText("已取消收藏")).toBeVisible()

  // ==========================================================================
  // 7. 收藏夹空了
  // ==========================================================================
  await page.goto("/favorites")

  await expect(page.getByText(/收藏夹是空的/)).toBeVisible()
  await expect(page.getByText("还没有收藏的鞋款")).toBeVisible()
  // 卡片没了 —— 不能只看那句话，得确认商品真的不在页面上
  await expect(page.getByText(PRODUCT_NAME)).toHaveCount(0)
})
