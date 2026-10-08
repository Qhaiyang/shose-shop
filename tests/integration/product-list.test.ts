import { beforeEach, describe, expect, it } from "vitest"

import { getAllCategories, getAllProducts, getSkuAvailability } from "@/lib/products"
import {
  makeProduct,
  makeSku,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 前台商品列表：搜索 / 分类 / 排序 —— 集成测试
//
// 【这里只测查询函数，不测页面】
// 页面把 q 传给查询函数那一步（参数算出来了但没往下传）只有真开浏览器
// 才看得到 —— 那种 bug 在 E2E 里抓（上一块就是 E2E 抓到的）。
// 这一层专注「查询本身算得对不对」：命中范围、排序顺序、下架商品过滤。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

describe("getAllProducts：搜索", () => {
  it("按商品名模糊命中", async () => {
    await makeProduct({ name: "轻量跑步鞋 一代" })
    await makeProduct({ name: "复古板鞋" })

    const rows = await getAllProducts({ q: "跑步" })
    expect(rows.map((r) => r.name)).toEqual(["轻量跑步鞋 一代"])
  })

  it("按描述命中，即使名字里没有这个词", async () => {
    // 买家搜「缓震」，商品名里没有、但描述里写了 —— 只搜名字会漏掉
    await makeProduct({ name: "疾风跑鞋", description: "全掌缓震科技，回弹出色" })
    await makeProduct({ name: "帆布鞋", description: "经典硫化工艺" })

    const rows = await getAllProducts({ q: "缓震" })
    expect(rows.map((r) => r.name)).toEqual(["疾风跑鞋"])
  })

  it("搜索同时命中名字和描述（OR 关系，不是 AND）", async () => {
    await makeProduct({ name: "缓震跑鞋", description: "普通描述" })
    await makeProduct({ name: "普通鞋", description: "带缓震" })
    await makeProduct({ name: "别的鞋", description: "别的描述" })

    const rows = await getAllProducts({ q: "缓震" })
    // 这里只关心「命中哪几个」，不关心顺序，两边用同一个 sort 归一化
    expect(rows.map((r) => r.name).sort()).toEqual(["缓震跑鞋", "普通鞋"].sort())
  })

  it("不传 q 或空串都不筛选", async () => {
    await makeProduct({ name: "甲" })
    await makeProduct({ name: "乙" })

    expect(await getAllProducts()).toHaveLength(2)
    expect(await getAllProducts({ q: "" })).toHaveLength(2)
    expect(await getAllProducts({ q: "   " })).toHaveLength(2)
  })

  it("搜不到返回空数组，不是报错", async () => {
    await makeProduct({ name: "轻量跑步鞋" })
    expect(await getAllProducts({ q: "不存在的鞋" })).toEqual([])
  })

  it("下架商品不出现在搜索结果里", async () => {
    await makeProduct({ name: "在售的跑步鞋", isActive: true })
    await makeProduct({ name: "下架的跑步鞋", isActive: false })

    const rows = await getAllProducts({ q: "跑步鞋" })
    expect(rows.map((r) => r.name)).toEqual(["在售的跑步鞋"])
  })
})

describe("getAllProducts：分类筛选", () => {
  it("只返回该分类的商品", async () => {
    await makeProduct({ name: "跑鞋甲", category: "跑步鞋" })
    await makeProduct({ name: "跑鞋乙", category: "跑步鞋" })
    await makeProduct({ name: "篮球鞋甲", category: "篮球鞋" })

    const rows = await getAllProducts({ category: "跑步鞋" })
    expect(rows.map((r) => r.name).sort()).toEqual(["跑鞋甲", "跑鞋乙"].sort())
  })

  it("下架商品的分类不参与统计，也不出现在结果里", async () => {
    await makeProduct({ name: "在售跑鞋", category: "跑步鞋", isActive: true })
    await makeProduct({ name: "下架跑鞋", category: "跑步鞋", isActive: false })

    const rows = await getAllProducts({ category: "跑步鞋" })
    expect(rows.map((r) => r.name)).toEqual(["在售跑鞋"])
  })

  it("不存在的分类返回空", async () => {
    await makeProduct({ name: "跑鞋", category: "跑步鞋" })
    expect(await getAllProducts({ category: "不存在" })).toEqual([])
  })
})

describe("getAllCategories：分类去重来源", () => {
  it("从数据库 distinct 出来，按字母序，不写死", async () => {
    // 故意乱序创建，验证结果按 category 排序而非创建顺序
    await makeProduct({ category: "篮球鞋" })
    await makeProduct({ category: "跑步鞋" })
    await makeProduct({ category: "篮球鞋" }) // 重复分类要合并
    await makeProduct({ category: "板鞋" })

    expect(await getAllCategories()).toEqual(["板鞋", "跑步鞋", "篮球鞋"].sort())
  })

  it("下架商品的分类不出现在分类列表里", async () => {
    await makeProduct({ category: "在售类", isActive: true })
    await makeProduct({ category: "下架类", isActive: false })

    const categories = await getAllCategories()
    expect(categories).toContain("在售类")
    expect(categories).not.toContain("下架类")
  })

  it("没有任何在售商品时返回空数组", async () => {
    expect(await getAllCategories()).toEqual([])
  })
})

describe("getAllProducts：价格排序", () => {
  // 价格排序的键是「该商品的最低价」。所以关键要验证两件事：
  // 1. 单 SKU 商品的排序就是比价格
  // 2. 多 SKU 商品比的是**最低**那个 SKU 的价格，不是别的

  it("price_asc：从低到高", async () => {
    const cheap = await makeProduct({ name: "便宜" })
    await makeSku(cheap.id, { price: 10_000 })
    const mid = await makeProduct({ name: "中档" })
    await makeSku(mid.id, { price: 50_000 })
    const pricey = await makeProduct({ name: "贵" })
    await makeSku(pricey.id, { price: 90_000 })

    const rows = await getAllProducts({ sort: "price_asc" })
    expect(rows.map((r) => r.name)).toEqual(["便宜", "中档", "贵"])
  })

  it("price_desc：从高到低", async () => {
    const cheap = await makeProduct({ name: "便宜" })
    await makeSku(cheap.id, { price: 10_000 })
    const pricey = await makeProduct({ name: "贵" })
    await makeSku(pricey.id, { price: 90_000 })

    const rows = await getAllProducts({ sort: "price_desc" })
    expect(rows.map((r) => r.name)).toEqual(["贵", "便宜"])
  })

  it("多 SKU 商品按最低价参与排序", async () => {
    // 商品甲有两个 SKU：100 元和 999 元，最低 100
    // 商品乙只有一个 SKU：500 元
    // 按最低价排，甲（100）应排在乙（500）前面
    const a = await makeProduct({ name: "多规格" })
    await makeSku(a.id, { price: 100, size: "40" })
    await makeSku(a.id, { price: 99_900, size: "44" })

    const b = await makeProduct({ name: "单规格" })
    await makeSku(b.id, { price: 50_000 })

    const rows = await getAllProducts({ sort: "price_asc" })
    expect(rows.map((r) => r.name)).toEqual(["多规格", "单规格"])
  })

  it("默认（newest）按创建时间倒序", async () => {
    const older = await makeProduct({ name: "先建的" })
    await makeSku(older.id, { price: 1 })
    const newer = await makeProduct({ name: "后建的" })
    await makeSku(newer.id, { price: 99_999 })

    const rows = await getAllProducts()
    expect(rows.map((r) => r.name)).toEqual(["后建的", "先建的"])
  })

  it("同价商品排序稳定，保持 newest 的先后顺序", async () => {
    const a = await makeProduct({ name: "同价甲" })
    await makeSku(a.id, { price: 30_000 })
    const b = await makeProduct({ name: "同价乙" })
    await makeSku(b.id, { price: 30_000 })

    const rows = await getAllProducts({ sort: "price_asc" })
    expect(rows.map((r) => r.name)).toEqual(["同价乙", "同价甲"])
  })
})

describe("getSkuAvailability：单个 SKU 的实时库存", () => {
  it("返回当前库存和价格", async () => {
    const product = await makeProduct()
    const sku = await makeSku(product.id, { price: 89900, stock: 7 })

    const result = await getSkuAvailability(sku.id)

    expect(result).toEqual({ stock: 7, price: 89900 })
  })

  it("SKU 不存在返回 null（前端据此提示规格已删除）", async () => {
    expect(await getSkuAvailability("不存在的id")).toBeNull()
  })
})

describe("getAllProducts：三条件叠加", () => {
  it("搜索 + 分类 + 排序同时生效", async () => {
    // 分类「跑步鞋」里两件带「轻」的商品：100 元和 300 元
    const cheap = await makeProduct({ name: "轻跑鞋", category: "跑步鞋" })
    await makeSku(cheap.id, { price: 10_000 })
    const pricey = await makeProduct({ name: "轻量竞速", category: "跑步鞋" })
    await makeSku(pricey.id, { price: 30_000 })
    // 干扰项：同分类但不含「轻」
    await makeProduct({ name: "慢跑鞋", category: "跑步鞋" })
    // 干扰项：含「轻」但不同分类
    await makeProduct({ name: "轻篮球鞋", category: "篮球鞋" })

    const rows = await getAllProducts({
      q: "轻",
      category: "跑步鞋",
      sort: "price_desc",
    })

    expect(rows.map((r) => r.name)).toEqual(["轻量竞速", "轻跑鞋"])
  })
})
