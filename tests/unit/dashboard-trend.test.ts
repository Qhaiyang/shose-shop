import { describe, expect, it } from "vitest"

import { buildSalesTrend, SALES_TREND_DAYS } from "@/lib/sales-trend"

// ============================================================================
// 近 7 天销售额趋势的补零对齐 —— 单元测试
//
// buildSalesTrend 是个纯函数：把 SQL 按天 groupBy 出来的（只含有销售额的
// 那些天）补成连续的 7 天。SQL 不会返回「卖了 0 元」的日子，所以这个
// 函数负责「缺哪补哪、按日期对齐」。它不碰数据库，所以能纯单测。
//
// 【为什么 import 的是 @/lib/sales-trend 而不是 @/lib/dashboard】
// 这些函数原来住在 dashboard.ts 里。那个文件顶部 import 了 prisma，
// 于是「测一个补零的循环」会顺带把数据库客户端也加载进来 ——
// 而 prisma.ts 在 DATABASE_URL 没配时会明确抛错，单元测试环境里没有
// 那个变量。纯逻辑拆出来之后，这个测试文件不碰数据库，
// 也就不会再被数据库的事牵连
// ============================================================================

// 2026-10-08 14:30 本地时间 —— 近 7 天就是 10-02 ~ 10-08
const NOW = new Date(2026, 9, 8, 14, 30)

function day(date: Date) {
  return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate() }
}

describe("buildSalesTrend：补成连续 7 天", () => {
  it("总是返回 7 个点，最旧在前，首尾日期正确", () => {
    const points = buildSalesTrend([], NOW)

    expect(points).toHaveLength(SALES_TREND_DAYS)
    // 10-02 到 10-08
    expect(day(points[0].date)).toEqual({ y: 2026, m: 9, d: 2 })
    expect(day(points[6].date)).toEqual({ y: 2026, m: 9, d: 8 })
  })

  it("没有任何数据时，每一天都是 0", () => {
    const points = buildSalesTrend([], NOW)
    expect(points.every((p) => p.revenue === 0)).toBe(true)
  })

  it("有数据的那些天映射到对应点，缺的天补 0", () => {
    const points = buildSalesTrend(
      [
        { day: "2026-10-03", revenue: 12300 },
        { day: "2026-10-08", revenue: 45600 },
      ],
      NOW,
    )

    expect(points.map((p) => p.revenue)).toEqual([
      0, 12300, 0, 0, 0, 0, 45600,
    ])
  })

  it("输入行的顺序不影响结果（按日期键对齐，不是按数组顺序）", () => {
    const reversed = buildSalesTrend(
      [
        { day: "2026-10-08", revenue: 1 },
        { day: "2026-10-02", revenue: 2 },
      ],
      NOW,
    )
    const sorted = buildSalesTrend(
      [
        { day: "2026-10-02", revenue: 2 },
        { day: "2026-10-08", revenue: 1 },
      ],
      NOW,
    )

    expect(reversed.map((p) => p.revenue)).toEqual(
      sorted.map((p) => p.revenue),
    )
  })

  it("今天（最后一天）的值正确对齐", () => {
    const points = buildSalesTrend([{ day: "2026-10-08", revenue: 999 }], NOW)

    expect(points[6]).toMatchObject({ revenue: 999 })
    expect(points[6].date.getDate()).toBe(8)
  })

  it("跨月：3 月 1 日的近 7 天跨到 2 月底", () => {
    // 2026 不是闰年，2 月只有 28 天，往前推 6 天正好是 2 月 23 日
    const points = buildSalesTrend([], new Date(2026, 2, 1, 9, 0))

    expect(day(points[0].date)).toEqual({ y: 2026, m: 1, d: 23 })
    expect(day(points[6].date)).toEqual({ y: 2026, m: 2, d: 1 })
  })
})
