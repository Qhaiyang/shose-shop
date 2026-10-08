import { describe, expect, it } from "vitest"

import {
  formatRating,
  parseRating,
  ratingLabel,
  RATING_VALUES_DESC,
  summarizeRatings,
} from "@/lib/reviews"

// ============================================================================
// 评价的纯逻辑 —— src/lib/reviews.ts
//
// 【为什么这些要单独测】
// 分布图的百分比、平均分的小数位、空数据的边界，这些算错了**不会报错**，
// 只会显示一个看起来挺像回事、但其实是错的数字。
// 比如 0 条评价显示 "0.0 分"，用户会读成「大家都打了 0 分」。
// 这类「静默地算错」正是必须用测试钉死的东西。
// ============================================================================

describe("parseRating：表单里的星级收窄", () => {
  it("整数字符串和数字都能收", () => {
    expect(parseRating("5")).toBe(5)
    expect(parseRating("1")).toBe(1)
    expect(parseRating(3)).toBe(3)
  })

  it("两端的空白不影响", () => {
    expect(parseRating("  4 ")).toBe(4)
  })

  it("越界的星级返回 null", () => {
    expect(parseRating("0")).toBeNull()
    expect(parseRating("6")).toBeNull()
    expect(parseRating(-1)).toBeNull()
    expect(parseRating(7)).toBeNull()
  })

  it("小数和非法输入返回 null", () => {
    expect(parseRating("3.5")).toBeNull()
    expect(parseRating(4.2)).toBeNull()
    expect(parseRating("abc")).toBeNull()
    expect(parseRating("")).toBeNull()
    // "" 用 Number() 会变成 0，那是个合法数字但是非法星级 ——
    // 所以这里坚持用正则先卡格式，而不是 Number()
    expect(parseRating("5x")).toBeNull()
  })

  it("null / undefined / 布尔值返回 null", () => {
    expect(parseRating(null)).toBeNull()
    expect(parseRating(undefined)).toBeNull()
    expect(parseRating(true)).toBeNull()
  })
})

describe("ratingLabel：星级文案", () => {
  it("五个星级都有对应的说法", () => {
    expect(ratingLabel(5)).toBe("非常满意")
    expect(ratingLabel(1)).toBe("不满意")
  })

  it("越界的星级给兜底文案，而不是 undefined", () => {
    // 库里理论上可能有一条 rating = 9 的脏数据，界面上不能显示 "undefined"
    expect(ratingLabel(9)).toBe("未评分")
  })
})

describe("formatRating：平均分展示", () => {
  it("没有评价时说的是「暂无评分」，不是「0.0」", () => {
    // 这两句话对用户的意思完全相反：一个是没人评过，一个是大家都给了 0 分
    expect(formatRating(0, 0)).toBe("暂无评分")
  })

  it("有评价时保留一位小数", () => {
    expect(formatRating(4, 3)).toBe("4.0")
    expect(formatRating(4.33, 3)).toBe("4.3")
    expect(formatRating(4.35, 20)).toBe("4.3")
  })
})

describe("summarizeRatings：评分汇总", () => {
  it("没有数据时是五行全 0，而不是空数组", () => {
    // 【为什么必须凑齐五行】分布图是按 bars 渲染柱子的。
    // 返回空数组的话，没有评价的商品连「5 星 ▏0」这几行都不显示，
    // 布局会突然塌掉一块
    const summary = summarizeRatings([])

    expect(summary.total).toBe(0)
    expect(summary.average).toBe(0)
    expect(summary.bars).toHaveLength(5)
    expect(summary.bars.map((bar) => bar.count)).toEqual([0, 0, 0, 0, 0])
    expect(summary.bars.map((bar) => bar.percent)).toEqual([0, 0, 0, 0, 0])
  })

  it("固定按 5 星到 1 星排列", () => {
    expect(summarizeRatings([]).bars.map((bar) => bar.rating)).toEqual([
      5, 4, 3, 2, 1,
    ])
    // 常量本身就是这个顺序 —— 组件照着它渲染，两边不能各说各的
    expect(RATING_VALUES_DESC).toEqual([5, 4, 3, 2, 1])
  })

  it("缺的星级补 0，已有的按原样填进去", () => {
    const summary = summarizeRatings([
      { rating: 5, count: 2 },
      { rating: 3, count: 1 },
    ])

    expect(summary.total).toBe(3)
    // (5×2 + 3×1) / 3 = 4.333… → 4.3
    expect(summary.average).toBe(4.3)
    expect(summary.bars.map((bar) => bar.count)).toEqual([2, 0, 1, 0, 0])
  })

  it("百分比按整数算，不做「凑够 100%」的修正", () => {
    // 三条各占 33.33%：四舍五入后加起来是 99%。这是对的 ——
    // 为了让总和等于 100 去给某根柱子加 1%，那根柱子就成了错的
    const summary = summarizeRatings([
      { rating: 5, count: 1 },
      { rating: 4, count: 1 },
      { rating: 3, count: 1 },
    ])

    expect(summary.bars.map((bar) => bar.percent)).toEqual([33, 33, 33, 0, 0])
  })

  it("平均分只保留一位小数", () => {
    const summary = summarizeRatings([{ rating: 4, count: 2 }, { rating: 5, count: 1 }])
    // (4+4+5)/3 = 4.333… → 4.3
    expect(summary.average).toBe(4.3)
  })

  it("整数的平均分也不会多出小数位", () => {
    const summary = summarizeRatings([{ rating: 4, count: 3 }])
    expect(summary.average).toBe(4)
  })

  it("越界的星级被忽略，不会多出一根柱子", () => {
    // SQLite 没有 CHECK 约束，rating = 9 是能写进去的。
    // 这种脏数据宁可少算一条，也不能让分布图上出现一根「9 星」
    const summary = summarizeRatings([
      { rating: 5, count: 1 },
      { rating: 9, count: 100 },
    ])

    expect(summary.total).toBe(1)
    expect(summary.average).toBe(5)
    expect(summary.bars.map((bar) => bar.rating)).toEqual([5, 4, 3, 2, 1])
  })

  it("同一个星级出现多行时会被合并", () => {
    // groupBy 理论上不会给出重复的 rating，但这个函数是纯函数，
    // 调用方可以传任何东西进来 —— 合并比覆盖安全
    const summary = summarizeRatings([
      { rating: 5, count: 1 },
      { rating: 5, count: 2 },
    ])

    expect(summary.total).toBe(3)
    expect(summary.bars[0]).toEqual({ rating: 5, count: 3, percent: 100 })
  })
})
