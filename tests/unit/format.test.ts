import { afterEach, describe, expect, it, vi } from "vitest"

import {
  formatPrice,
  formatPriceRange,
  formatPriceShort,
  parseImages,
} from "@/lib/format"

// ============================================================================
// src/lib/format.ts —— 展示层格式化
//
// 这一层的共同特点是「只在渲染的最后一步发生」：
// 数据库里全程是「分」，到用户眼前才变成「元」。
// 所以这里错了不会影响账目，但会让用户看到 89900 或者 ¥8.99。
// ============================================================================

describe("formatPrice —— 分 → ¥x.xx", () => {
  it("常见价格", () => {
    expect(formatPrice(89900)).toBe("¥899.00")
    expect(formatPrice(129900)).toBe("¥1299.00")
  })

  it("永远保留两位小数", () => {
    // 价格列对齐才好看，所以 899 也要写成 899.00
    expect(formatPrice(1)).toBe("¥0.01")
    expect(formatPrice(5)).toBe("¥0.05")
    expect(formatPrice(10)).toBe("¥0.10")
    expect(formatPrice(100)).toBe("¥1.00")
  })

  it("零", () => {
    expect(formatPrice(0)).toBe("¥0.00")
  })

  it("反过来能对上 parseYuanToCents", () => {
    // 这两个函数是一对：存的时候字符串→分，展示的时候分→字符串。
    // 让它们互相验证，比各自写死几个期望值更能保证一致
    expect(formatPrice(29)).toBe("¥0.29")
    expect(formatPrice(1234)).toBe("¥12.34")
  })
})

describe("formatPriceShort —— 分 → 紧凑价格", () => {
  it("整数元不显示小数", () => {
    expect(formatPriceShort(89900)).toBe("¥899")
    expect(formatPriceShort(0)).toBe("¥0")
  })

  it("有零头才显示小数", () => {
    // 注意这里显示的是两位小数 —— 金额展示永远补齐到分，
    // 不会出现「¥899.5」这种少一位的写法
    expect(formatPriceShort(89950)).toBe("¥899.50")
    expect(formatPriceShort(89905)).toBe("¥899.05")
    expect(formatPriceShort(1)).toBe("¥0.01")
  })
})

describe("formatPriceRange —— 价格区间", () => {
  it("只有一个价位时不显示成 A ~ A", () => {
    expect(formatPriceRange(89900, 89900)).toBe("¥899")
    expect(formatPriceRange(1, 1)).toBe("¥0.01")
  })

  it("两个价位用 ~ 连接", () => {
    expect(formatPriceRange(89900, 129900)).toBe("¥899 ~ ¥1299")
    expect(formatPriceRange(89905, 129900)).toBe("¥899.05 ~ ¥1299")
  })
})

describe("parseImages —— 解析 Product.images", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("正常解析 JSON 数组", () => {
    expect(parseImages('["/a.svg","/b.svg"]')).toEqual(["/a.svg", "/b.svg"])
    expect(parseImages('["/only.svg"]')).toEqual(["/only.svg"])
    expect(parseImages("[]")).toEqual([])
  })

  it("空值返回空数组", () => {
    expect(parseImages(null)).toEqual([])
    expect(parseImages(undefined)).toEqual([])
    expect(parseImages("")).toEqual([])
  })

  it("坏 JSON 不抛异常，兜底成空数组", () => {
    // 数据库里的内容不可信（可能被手工改坏），
    // 一个商品图坏了不该让整个商品列表页崩掉
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(() => parseImages("{坏掉的 json")).not.toThrow()
    expect(parseImages("{坏掉的 json")).toEqual([])
    expect(parseImages("/a.svg")).toEqual([]) // 裸字符串不是合法 JSON
    expect(warn).toHaveBeenCalled()
  })

  it("合法 JSON 但不是数组，也返回空数组", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(parseImages('{"a":1}')).toEqual([])
    expect(parseImages('"just a string"')).toEqual([])
    expect(parseImages("123")).toEqual([])
    expect(parseImages("null")).toEqual([])
    // 这些是**合法的 JSON**，所以不该打警告 —— 警告只留给「解析失败」
    expect(warn).not.toHaveBeenCalled()
  })

  it("过滤掉数组里混进来的非字符串", () => {
    // 手工改库或者旧版本数据可能混进 null / 数字，
    // 直接交给 <img src> 会渲染出奇怪的属性
    expect(parseImages('["/a.svg",1,null,"/b.svg",true]')).toEqual([
      "/a.svg",
      "/b.svg",
    ])
    expect(parseImages("[1,2,3]")).toEqual([])
  })

  it("保留嵌套结构（不做递归展平）", () => {
    // 明确一下边界：这个函数只做一层过滤，不递归。
    // 嵌套数组会被当成「非字符串」丢掉，而不是展平
    expect(parseImages('[["/a.svg"]]')).toEqual([])
  })
})
