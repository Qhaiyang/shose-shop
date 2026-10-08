import { describe, expect, it } from "vitest"

import { toProductListItem } from "@/lib/product-list"

// ============================================================================
// 「商品行 → 卡片数据」—— src/lib/product-list.ts
//
// 【为什么值得单独测】
// 这个函数是商品列表页和收藏页**共用**的一段算术：价格区间、售罄判断、
// 主图取哪张。算错了页面上不会报任何错，只会显示一个看起来很正常的
// 错误价格 —— 比如「¥0.00 起」，或者一个没有 SKU 的商品显示
// 「¥Infinity 起」。这类静默出错正是必须用测试钉死的东西。
// ============================================================================

/** 造一行最简的商品数据，各用例只覆盖自己关心的字段 */
function row(overrides: Partial<Parameters<typeof toProductListItem>[0]> = {}) {
  return {
    id: "p1",
    name: "测试鞋款",
    category: "跑步鞋",
    images: "[]",
    skus: [],
    ...overrides,
  }
}

describe("toProductListItem：商品行转卡片数据", () => {
  it("价格区间取所有 SKU 的最小值和最大值", () => {
    const item = toProductListItem(
      row({
        skus: [
          { price: 89900, stock: 3 },
          { price: 59900, stock: 1 },
          { price: 129900, stock: 0 },
        ],
      }),
    )

    expect(item.minPrice).toBe(59900)
    expect(item.maxPrice).toBe(129900)
    expect(item.skuCount).toBe(3)
  })

  it("一个 SKU 都没有时价格是 0，不是 Infinity", () => {
    // 【这条是这里最该测的】Math.min() 对空数组返回 Infinity，
    // 直接传下去界面上会出现「¥Infinity 起」
    const item = toProductListItem(row({ skus: [] }))

    expect(item.minPrice).toBe(0)
    expect(item.maxPrice).toBe(0)
    expect(item.skuCount).toBe(0)
  })

  it("一个 SKU 都没有时算售罄（every 对空数组返回 true）", () => {
    expect(toProductListItem(row({ skus: [] })).soldOut).toBe(true)
  })

  it("还有任何一个 SKU 有库存就不算售罄", () => {
    const item = toProductListItem(
      row({
        skus: [
          { price: 89900, stock: 0 },
          { price: 89900, stock: 1 },
        ],
      }),
    )

    expect(item.soldOut).toBe(false)
  })

  it("全部 SKU 库存为 0 才算售罄", () => {
    const item = toProductListItem(
      row({
        skus: [
          { price: 89900, stock: 0 },
          { price: 89900, stock: 0 },
        ],
      }),
    )

    expect(item.soldOut).toBe(true)
  })

  it("主图取 JSON 数组里的第一张", () => {
    const item = toProductListItem(
      row({ images: '["/shoes/a-1.svg","/shoes/a-2.svg"]' }),
    )

    expect(item.image).toBe("/shoes/a-1.svg")
  })

  it("没有图片时主图是 null，而不是空串", () => {
    // 空串会让 <img src=""> 去请求当前页面地址，白跑一次请求
    expect(toProductListItem(row({ images: "[]" })).image).toBeNull()
  })

  it("原样保留 id、名称和分类", () => {
    const item = toProductListItem(
      row({ id: "prod_running", name: "「疾风」跑鞋", category: "跑步鞋" }),
    )

    expect(item.id).toBe("prod_running")
    expect(item.name).toBe("「疾风」跑鞋")
    expect(item.category).toBe("跑步鞋")
  })
})
