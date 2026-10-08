import { describe, expect, it } from "vitest"

import { parseProductListQuery, PRODUCT_SORTS } from "@/lib/product-query"

// ============================================================================
// 商品列表 URL 参数解析 —— 单元测试
//
// 输入是不可信的 URL 字符串（?q= / ?category= / ?sort=），
// 输出必须是收窄后的干净值：白名单之外的 sort 落回默认、
// 过长的关键词被截断、空白当没传。
// ============================================================================

describe("parseProductListQuery：排序参数", () => {
  it("三个合法值原样通过", () => {
    for (const sort of PRODUCT_SORTS) {
      expect(parseProductListQuery({ sort }).sort).toBe(sort)
    }
  })

  it("不传或空值时默认 newest", () => {
    expect(parseProductListQuery({}).sort).toBe("newest")
    expect(parseProductListQuery({ sort: undefined }).sort).toBe("newest")
    expect(parseProductListQuery({ sort: null }).sort).toBe("newest")
    expect(parseProductListQuery({ sort: "" }).sort).toBe("newest")
  })

  it("白名单之外的值一律落回 newest", () => {
    // 手滑、大小写错、注入尝试 —— 全部当成「没传」
    for (const bad of ["price_ASC", "PRICE_DESC", "oldest", "random", "price_asc; DROP TABLE"]) {
      expect(parseProductListQuery({ sort: bad }).sort).toBe("newest")
    }
  })
})

describe("parseProductListQuery：搜索关键词", () => {
  it("正常关键词原样通过，并去掉首尾空白", () => {
    expect(parseProductListQuery({ q: "跑鞋" }).q).toBe("跑鞋")
    expect(parseProductListQuery({ q: "  缓震  " }).q).toBe("缓震")
  })

  it("不传或纯空白归为空字符串", () => {
    expect(parseProductListQuery({}).q).toBe("")
    expect(parseProductListQuery({ q: "" }).q).toBe("")
    expect(parseProductListQuery({ q: "   " }).q).toBe("")
    expect(parseProductListQuery({ q: null }).q).toBe("")
  })

  it("超长关键词被截断，而不是原样放行", () => {
    const result = parseProductListQuery({ q: "鞋".repeat(100) })
    expect(result.q).toHaveLength(40)
    expect(result.q).toBe("鞋".repeat(40))
  })
})

describe("parseProductListQuery：分类", () => {
  it("正常分类通过，并去掉首尾空白", () => {
    expect(parseProductListQuery({ category: "跑步鞋" }).category).toBe("跑步鞋")
    expect(parseProductListQuery({ category: " 篮球鞋 " }).category).toBe("篮球鞋")
  })

  it("不传或空白归为 undefined（不筛分类）", () => {
    expect(parseProductListQuery({}).category).toBeUndefined()
    expect(parseProductListQuery({ category: "" }).category).toBeUndefined()
    expect(parseProductListQuery({ category: "  " }).category).toBeUndefined()
    expect(parseProductListQuery({ category: null }).category).toBeUndefined()
  })

  it("超长分类名被截断", () => {
    const result = parseProductListQuery({ category: "鞋".repeat(100) })
    expect(result.category).toBe("鞋".repeat(30))
  })
})

describe("parseProductListQuery：三个条件可叠加", () => {
  it("全部给出时各自独立解析，互不干扰", () => {
    const result = parseProductListQuery({
      q: " 跑鞋 ",
      category: "跑步",
      sort: "price_asc",
    })

    expect(result).toEqual({ q: "跑鞋", category: "跑步", sort: "price_asc" })
  })

  it("只给一个条件时，另外两个是干净的默认值", () => {
    expect(parseProductListQuery({ q: "x" })).toEqual({
      q: "x",
      category: undefined,
      sort: "newest",
    })
    expect(parseProductListQuery({ category: "y" })).toEqual({
      q: "",
      category: "y",
      sort: "newest",
    })
  })
})

// 顺手确认白名单常量本身没被改坏
describe("PRODUCT_SORTS 白名单", () => {
  it("恰好是这三个值", () => {
    expect(PRODUCT_SORTS).toEqual(["newest", "price_asc", "price_desc"])
  })
})
