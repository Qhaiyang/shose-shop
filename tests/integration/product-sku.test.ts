import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createSku } from "@/lib/products"
import { makeProduct, prisma, resetDb, resetSeq } from "./helpers/db"

// ============================================================================
// 新增规格（SKU）：两种唯一约束撞车，要给不同的提示
//
// 【为什么专门开一个文件给这两条用例】
// createSku 之前**一行测试都没有**，而它恰好藏着一段永远不会被执行的分支：
// 代码里想区分两种 P2002（货号撞了 / 规格重复），靠的是 error.meta?.target
// —— 那在 Prisma 7 上恒为 undefined，于是「货号重复了，请再试一次」
// 那条分支从来没走到过，真撞上货号时返回的是「这个规格已经存在了」，
// 一句把管理员引向错误方向的话。
//
// 死代码 + 零覆盖 = 它可以在那儿烂很久而没有任何信号。所以这两条用例
// 的重点不是「返回了 ok: false」（那太容易做到了），而是
// **撞的是哪一条约束，就要给哪一句提示** —— 判据错了，这里必须红。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("给商品加规格：撞了哪条唯一约束，就说哪句话", () => {
  it("尺码+颜色重复 → 提示「这个规格已经存在了」", async () => {
    const product = await makeProduct()

    const first = await createSku(product.id, {
      size: "42",
      color: "黑色",
      price: 89900,
      stock: 10,
    })
    expect(first.ok).toBe(true)

    // 同一款鞋、同一个尺码、同一个颜色 —— 撞 @@unique([productId, size, color])
    const again = await createSku(product.id, {
      size: "42",
      color: "黑色",
      price: 99900,
      stock: 5,
    })

    expect(again).toEqual({
      ok: false,
      error: "黑色 / 42码 这个规格已经存在了",
    })
    // 失败就是什么都没发生：库里还是只有第一个
    expect(await prisma.sku.count()).toBe(1)
  })

  it("货号撞车（规格本身不重复）→ 提示「货号重复了，请再试一次」", async () => {
    // 【怎么造一个真实的货号撞车】
    // 货号是 createSku 内部用 Math.random() 生成的，没法从外面指定。
    // 所以把 Math.random 钉死成一个常数 —— 生成出来的货号就确定了，
    // 我们再手工插一行用同样货号的 SKU，第二次 createSku 必然撞上。
    //
    // 关键是让**只有货号**撞：预先插入的那行换个颜色（白色），
    // 于是 (productId, size, color) 这个组合并不重复。
    // 这样才真正走的是「规格不重复但货号重复」那条路径 ——
    // 也就是原来那段死代码守着的地方
    const product = await makeProduct()

    const PINNED_RANDOM = 0.123456789
    // 照着 createSku 的算法把货号算出来（货号里不含颜色，所以只锁尺码）
    const suffix = PINNED_RANDOM.toString(36).slice(2, 6).toUpperCase()
    const prefix = product.id.replace(/^prod_/, "").toUpperCase().slice(0, 8)
    const collidingCode = `${prefix}-42-${suffix}`

    await prisma.sku.create({
      data: {
        productId: product.id,
        size: "42",
        color: "白色", // 和下面那次调用不同 —— 否则先撞上的是规格那条约束
        price: 100,
        stock: 1,
        skuCode: collidingCode,
      },
    })

    vi.spyOn(Math, "random").mockReturnValue(PINNED_RANDOM)

    const result = await createSku(product.id, {
      size: "42",
      color: "黑色",
      price: 89900,
      stock: 10,
    })

    // 【这一句就是修复的核心】
    // 改用「查一次当判据」之前，这里拿到的是「这个规格已经存在了」——
    // 而黑色 / 42 码这个规格根本不存在，管理员照着那句话去找会一无所获
    expect(result).toEqual({ ok: false, error: "货号重复了，请再试一次" })

    // 确实没插进去
    expect(await prisma.sku.count()).toBe(1)
  })
})
