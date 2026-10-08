import { expect, test } from "@playwright/test"

// ============================================================================
// 商品多图 E2E：后台调整顺序 → 前台轮播按新顺序展示
//
// 【为什么这个要开真的浏览器】
// 图片编辑器的「上移 / 下移」是纯客户端交互，前台轮播的「点缩略图切主图」
// 也是纯客户端交互 —— 这两块集成测试（直接调函数）一行都碰不到。
// 只有真浏览器能验：
//   - 隐藏输入框（name="images"，一行一个路径）在点完「上移」后，
//     真的按新顺序提交给 Server Action
//   - 保存落到数据库后，前台轮播读到的顺序和后台排的完全一致
//   - 缩略图切换真的驱动主图换 src
// ============================================================================

const ADMIN = { email: "admin@shop.dev", password: "admin123" }

test("后台重排图片顺序 → 前台轮播按新顺序展示并切换", async ({
  page,
  browser,
}) => {
  // ==========================================================================
  // 1. 管理员登录，进入「疾风」跑鞋编辑页
  // ==========================================================================
  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()

  await adminPage.goto("/login?next=/admin/products/prod_running")
  await adminPage.fill("#email", ADMIN.email)
  await adminPage.fill("#password", ADMIN.password)
  await adminPage.getByRole("button", { name: "登录" }).click()
  await adminPage.waitForURL("**/admin/products/prod_running")

  // 种子里每款 3 张图。图片编辑器是这一页唯一用 <li><code> 的地方
  // （SKU 面板、危险操作区都没有），所以这个定位不会误命中
  const imageRows = adminPage.locator("li").filter({
    has: adminPage.locator("code"),
  })
  await expect(imageRows).toHaveCount(3)

  // 第 3 张图（-3.svg）被上移一位 → 顺序变成 -1, -3, -2
  await imageRows
    .filter({ hasText: "prod_running-3.svg" })
    .getByRole("button", { name: "上移" })
    .click()

  await adminPage.getByRole("button", { name: "保存修改" }).click()
  // 等保存结束：pending 时按钮文案是「保存中…」且禁用，
  // 名字重新变成「保存修改」并恢复可用 = 提交的 Server Action 已经返回
  await expect(
    adminPage.getByRole("button", { name: "保存修改" }),
  ).toBeEnabled()

  await adminContext.close()

  // ==========================================================================
  // 2. 前台详情页：轮播读到的顺序要和后台一致
  // ==========================================================================
  await page.goto("/products/prod_running")

  const thumbnails = page.getByRole("button", { name: /查看第 \d+ 张图/ })
  await expect(thumbnails).toHaveCount(3)

  // 初始停在第 1 张
  await expect(page.getByText("1 / 3", { exact: true })).toBeVisible()

  // 顺序持久化了：第 2 张缩略图现在是被上移的那张 -3.svg
  await expect(
    page.getByRole("button", { name: "查看第 2 张图" }).locator("img"),
  ).toHaveAttribute("src", /prod_running-3\.svg/)

  // 点第 3 张缩略图 → 计数器变 3 / 3，主图换到 -2.svg
  await page.getByRole("button", { name: "查看第 3 张图" }).click()
  await expect(page.getByText("3 / 3", { exact: true })).toBeVisible()
  await expect(page.locator('img[alt*="商品图 3"]')).toHaveAttribute(
    "src",
    /prod_running-2\.svg/,
  )
})
