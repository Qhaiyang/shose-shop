import { describe, expect, it } from "vitest"

import {
  formatFootLength,
  parseFootLength,
  suggestSize,
  type SizeGuideView,
} from "@/lib/size-guide"

// ============================================================================
// 尺码建议的纯函数 —— 单元测试
//
// parseFootLength / suggestSize / formatFootLength 都不碰数据库，
// 可以纯单测。重点是 suggestSize 的半开区间边界 —— 这些边界在页面里
// 用户几乎不会恰好输入到，只有测试能钉死。
// ============================================================================

describe("parseFootLength：把输入解析成 cm 数字", () => {
  it("整数和小数都能解析", () => {
    expect(parseFootLength("24")).toBe(24)
    expect(parseFootLength("24.5")).toBe(24.5)
    expect(parseFootLength("24.53")).toBe(24.53)
  })

  it("首尾空白会被忽略", () => {
    expect(parseFootLength("  24.5  ")).toBe(24.5)
  })

  it("非数字、空串、多余小数点都返回 null", () => {
    expect(parseFootLength("")).toBeNull()
    expect(parseFootLength("abc")).toBeNull()
    expect(parseFootLength("24.5.5")).toBeNull()
    expect(parseFootLength("24.567")).toBeNull()
    expect(parseFootLength("24abc")).toBeNull()
  })

  it("超出合理范围（15–35）返回 null", () => {
    expect(parseFootLength("10")).toBeNull()
    expect(parseFootLength("36")).toBeNull()
    expect(parseFootLength("150")).toBeNull()
  })

  it("边界值本身合法", () => {
    expect(parseFootLength("15")).toBe(15)
    expect(parseFootLength("35")).toBe(35)
  })
})

// 39 [24.25, 24.75)  40 [24.75, 25.25)  41 [25.25, 25.75)
const GUIDES: SizeGuideView[] = [
  { id: "g39", category: "跑步鞋", footLengthMin: 24.25, footLengthMax: 24.75, suggestedSize: "39" },
  { id: "g40", category: "跑步鞋", footLengthMin: 24.75, footLengthMax: 25.25, suggestedSize: "40" },
  { id: "g41", category: "跑步鞋", footLengthMin: 25.25, footLengthMax: 25.75, suggestedSize: "41" },
]

describe("suggestSize：半开区间匹配", () => {
  it("落在区间中间的脚长命中对应尺码", () => {
    expect(suggestSize(GUIDES, 24.5)?.suggestedSize).toBe("39")
    expect(suggestSize(GUIDES, 25.0)?.suggestedSize).toBe("40")
  })

  it("等于下界（含），命中当前尺码", () => {
    expect(suggestSize(GUIDES, 24.25)?.suggestedSize).toBe("39")
    expect(suggestSize(GUIDES, 25.25)?.suggestedSize).toBe("41")
  })

  it("等于上界（不含），落进下一码", () => {
    expect(suggestSize(GUIDES, 24.75)?.suggestedSize).toBe("40")
    expect(suggestSize(GUIDES, 25.75)).toBeNull() // 超出最后一段
  })

  it("小于最小下界 / 大于最大上界都返回 null", () => {
    expect(suggestSize(GUIDES, 24.0)).toBeNull()
    expect(suggestSize(GUIDES, 26.0)).toBeNull()
  })

  it("空表返回 null", () => {
    expect(suggestSize([], 24.5)).toBeNull()
  })
})

describe("formatFootLength：去掉无意义的尾随 0", () => {
  it("整数不显示小数位", () => {
    expect(formatFootLength(24)).toBe("24")
  })

  it("0.5 步长显示一位小数", () => {
    expect(formatFootLength(24.5)).toBe("24.5")
  })

  it("0.25 步长显示两位小数", () => {
    expect(formatFootLength(24.25)).toBe("24.25")
    expect(formatFootLength(24.75)).toBe("24.75")
  })
})
