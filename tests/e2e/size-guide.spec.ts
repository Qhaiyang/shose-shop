import { expect, test } from "@playwright/test"

// ============================================================================
// 尺码助手 E2E：输入脚长 → 建议尺码
//
// 匹配逻辑（suggestSize）单元测试钉死了，查询（getSizeGuides）集成测试
// 也测了。这一层只补一件事：**这个组件真的挂在详情页上、输入真的能驱动
// 结果变化** —— 纯客户端交互，前两层都碰不到。
// ============================================================================

test("详情页尺码助手：输入脚长返回建议尺码", async ({ page }) => {
  // 「疾风」跑鞋（跑步鞋），尺码 39–44 对应脚长 24.25–27.25
  await page.goto("/products/prod_running")

  // 展开尺码助手。按钮可访问名里还带分类提示，用子串匹配
  await page.getByRole("button", { name: /尺码助手/ }).click()

  const input = page.getByLabel("脚长（厘米）")

  // 26cm → 尺码 42，且带「偏码请参考评价」提示
  await input.fill("26")
  await expect(
    page.getByText(/建议尺码：\s*42\s*偏码请参考评价/),
  ).toBeVisible()

  // 非法输入 → 提示范围，不崩、不给出一个乱猜的尺码
  await input.fill("abc")
  await expect(page.getByText(/请输入 15–35 之间的数字/)).toBeVisible()

  // 合法但落在所有区间之外（15 < 24.25）→ 明确说没有匹配
  await input.fill("15")
  await expect(page.getByText(/还没有匹配的尺码/)).toBeVisible()
})
