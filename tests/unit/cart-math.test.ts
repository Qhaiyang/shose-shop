import { describe, expect, it } from "vitest"

import {
  cartCount,
  cartSubtotal,
  findStockProblems,
  type CartItemView,
} from "@/lib/cart-types"

// ============================================================================
// 购物车小计 / 计数 —— src/lib/cart-types.ts
//
// 这两个函数是「前端显示」和「后端下单」共用的：
// 购物车页面用它显示小计，结算时也用它算总额。所以算错了不只是显示问题。
//
// 【注意金额单位是「分」】
// 这里全程整数运算，正是因为价格字段是分。
// 如果 price 是「元」的浮点数，10 行 × 89.9 就未必等于 899 了。
// ============================================================================

/** 造一个购物车条目的测试数据，只需要 price / quantity 有意义 */
function item(price: number, quantity: number): CartItemView {
  return {
    skuId: `sku-${price}-${quantity}`,
    quantity,
    skuCode: "TEST-001",
    productId: "prod-1",
    productName: "测试鞋",
    size: "42",
    color: "黑",
    price,
    image: null,
    stock: 100,
  }
}

describe("cartSubtotal —— 购物车小计（单位：分）", () => {
  it("空购物车是 0", () => {
    expect(cartSubtotal([])).toBe(0)
  })

  it("单件商品：单价 × 数量", () => {
    expect(cartSubtotal([item(89900, 1)])).toBe(89900)
    expect(cartSubtotal([item(89900, 3)])).toBe(269700)
  })

  it("多件商品求和", () => {
    expect(cartSubtotal([item(89900, 2), item(129900, 1)])).toBe(179800 + 129900)
  })

  it("全程整数运算，不会出现浮点误差", () => {
    // 0.29 元 × 3。如果 price 是「元」的浮点数，
    // 0.29 * 3 === 0.8699999999999999，再乘回去就少一分钱。
    // 用「分」存就永远不会有这个问题
    expect(0.29 * 3).not.toBe(0.87) // 证明这个坑真实存在
    expect(cartSubtotal([item(29, 3)])).toBe(87)
  })

  it("数量为 0 的条目不影响总额", () => {
    expect(cartSubtotal([item(89900, 0), item(100, 2)])).toBe(200)
  })

  it("金额可以为 0（免商品）", () => {
    expect(cartSubtotal([item(0, 5)])).toBe(0)
  })
})

describe("cartCount —— 购物车总件数", () => {
  it("空购物车是 0 件", () => {
    expect(cartCount([])).toBe(0)
  })

  it("按数量相加，不是按条目数", () => {
    // 加了两双不同的鞋、每双 3 件，角标上应该显示 6 而不是 2
    expect(cartCount([item(100, 3), item(200, 3)])).toBe(6)
  })

  it("单个条目", () => {
    expect(cartCount([item(100, 7)])).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// findStockProblems —— 库存校验
// ---------------------------------------------------------------------------
describe("findStockProblems —— 找出库存不足的条目", () => {
  /** 造一条「stock / quantity 可指定」的条目，其它字段无所谓 */
  function line(skuId: string, stock: number, quantity: number) {
    return { skuId, stock, quantity }
  }

  it("库存充足时返回空数组", () => {
    expect(
      findStockProblems([line("a", 10, 5), line("b", 3, 3)]),
    ).toEqual([])
  })

  it("库存为 0（已售罄）算不足", () => {
    const problems = findStockProblems([line("a", 0, 1)])
    expect(problems).toEqual([{ skuId: "a", stock: 0, quantity: 1 }])
  })

  it("数量超过库存算不足", () => {
    const problems = findStockProblems([line("a", 3, 5)])
    expect(problems).toEqual([{ skuId: "a", stock: 3, quantity: 5 }])
  })

  it("数量刚好等于库存不算不足（边界：gte 语义）", () => {
    expect(findStockProblems([line("a", 5, 5)])).toEqual([])
  })

  it("多个条目时只挑出有问题的，且保持各自的值", () => {
    const problems = findStockProblems([
      line("ok", 10, 2),
      line("soldout", 0, 1),
      line("short", 4, 9),
      line("fine", 8, 8),
    ])

    expect(problems).toEqual([
      { skuId: "soldout", stock: 0, quantity: 1 },
      { skuId: "short", stock: 4, quantity: 9 },
    ])
  })

  it("空数组返回空数组", () => {
    expect(findStockProblems([])).toEqual([])
  })
})
