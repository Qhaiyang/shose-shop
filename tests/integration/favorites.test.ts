import { beforeEach, describe, expect, it } from "vitest"

import { getFavorites, isFavorited, setFavorite } from "@/lib/favorites-db"
import {
  makeProduct,
  makeSku,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 商品收藏 —— 集成测试
//
// 这里要钉死的是三件事：
//   1. 收藏是**幂等**的 —— 重复收藏不会多出一行，重复取消不会报错
//   2. 收藏是**按人隔离**的 —— A 的收藏不出现在 B 的列表里
//   3. 下架的商品不列出来，但记录留着，且单独计数
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

describe("setFavorite：收藏与取消", () => {
  it("收藏之后 isFavorited 为真，库里多一行", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    const result = await setFavorite(user.id, product.id, true)

    expect(result).toEqual({ ok: true, favorited: true })
    expect(await isFavorited(user.id, product.id)).toBe(true)
    expect(await prisma.favorite.count()).toBe(1)
  })

  it("重复收藏不会多出一行，也不会报错", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    await setFavorite(user.id, product.id, true)
    const again = await setFavorite(user.id, product.id, true)

    // 【为什么这条重要】心形按钮是可以被连点两下的，网络重试也会重发。
    // 「设置成已收藏」这个语义下，第二次应该什么都不做地成功 ——
    // 如果它会报错或者插第二行，用户就会看到一个莫名其妙的失败提示
    expect(again).toEqual({ ok: true, favorited: true })
    expect(await prisma.favorite.count()).toBe(1)
  })

  it("取消收藏之后查不到，行也没了", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    await setFavorite(user.id, product.id, true)

    const result = await setFavorite(user.id, product.id, false)

    expect(result).toEqual({ ok: true, favorited: false })
    expect(await isFavorited(user.id, product.id)).toBe(false)
    expect(await prisma.favorite.count()).toBe(0)
  })

  it("取消一个本来就没收藏的商品也算成功", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    // 幂等的另一半：结果状态是用户要的，就不该报错
    const result = await setFavorite(user.id, product.id, false)

    expect(result).toEqual({ ok: true, favorited: false })
  })

  it("不用事先查一次也不会插出两行", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    // 【为什么这条不是重复劳动】上面那两条是「先后调用」，
    // 这条是「同时打进去」—— 靠的是数据库上的 @@unique([userId, productId])
    // 加 P2002 兜底，而不是靠应用层判断。判断式写法在这里会插出两行
    const results = await Promise.all([
      setFavorite(user.id, product.id, true),
      setFavorite(user.id, product.id, true),
      setFavorite(user.id, product.id, true),
    ])

    expect(results.every((r) => r.ok)).toBe(true)
    expect(await prisma.favorite.count()).toBe(1)
  })

  it("已下架的商品不能被收藏", async () => {
    const user = await makeUser()
    const product = await makeProduct({ isActive: false })

    const result = await setFavorite(user.id, product.id, true)

    expect(result).toEqual({ ok: false, error: "商品不存在或已下架" })
    expect(await prisma.favorite.count()).toBe(0)
  })

  it("不存在的商品 id 被拒（外键挡得住的，这里也提前挡住）", async () => {
    const user = await makeUser()

    const result = await setFavorite(user.id, "not-a-real-product", true)

    expect(result.ok).toBe(false)
    expect(await prisma.favorite.count()).toBe(0)
  })

  it("已下架的商品仍然可以取消收藏", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    await setFavorite(user.id, product.id, true)

    // 下架它 —— 注意是改 isActive，不是删行
    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: false },
    })

    // 【为什么这条必须能过】商品下架之后，用户不该被**困**在收藏里：
    // 收藏时校验「在售」是对的，取消时还校验就成了有进无出
    const result = await setFavorite(user.id, product.id, false)

    expect(result).toEqual({ ok: true, favorited: false })
    expect(await prisma.favorite.count()).toBe(0)
  })
})

describe("getFavorites：我的收藏列表", () => {
  it("只返回自己的收藏", async () => {
    const me = await makeUser()
    const other = await makeUser()
    const mine = await makeProduct()
    const theirs = await makeProduct()

    await setFavorite(me.id, mine.id, true)
    await setFavorite(other.id, theirs.id, true)

    const { items } = await getFavorites(me.id)

    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(mine.id)
  })

  it("按收藏时间倒序，最近收藏的在最前面", async () => {
    const user = await makeUser()
    const first = await makeProduct()
    const second = await makeProduct()
    const third = await makeProduct()

    // createdAt 有 @default(now())，同一毫秒内可能撞在一起导致顺序不稳。
    // 显式指定时间，让断言只考察排序本身
    const base = Date.now()
    await prisma.favorite.create({
      data: { userId: user.id, productId: first.id, createdAt: new Date(base - 3000) },
    })
    await prisma.favorite.create({
      data: { userId: user.id, productId: second.id, createdAt: new Date(base - 2000) },
    })
    await prisma.favorite.create({
      data: { userId: user.id, productId: third.id, createdAt: new Date(base - 1000) },
    })

    const { items } = await getFavorites(user.id)

    expect(items.map((item) => item.id)).toEqual([third.id, second.id, first.id])
  })

  it("卡片要的字段都算好了（价格区间、主图、规格数）", async () => {
    const user = await makeUser()
    const product = await makeProduct({ images: ["/shoes/a-1.svg", "/shoes/a-2.svg"] })
    await makeSku(product.id, { price: 89900, stock: 5, color: "黑色", size: "42" })
    await makeSku(product.id, { price: 69900, stock: 0, color: "白色", size: "41" })
    await setFavorite(user.id, product.id, true)

    const { items } = await getFavorites(user.id)

    expect(items[0]).toMatchObject({
      id: product.id,
      image: "/shoes/a-1.svg",
      minPrice: 69900,
      maxPrice: 89900,
      skuCount: 2,
      // 还有一双有货，不算售罄
      soldOut: false,
    })
  })

  it("已下架的商品不列出来，但会被计数", async () => {
    const user = await makeUser()
    const alive = await makeProduct()
    const gone = await makeProduct()
    await setFavorite(user.id, alive.id, true)
    await setFavorite(user.id, gone.id, true)

    await prisma.product.update({
      where: { id: gone.id },
      data: { isActive: false },
    })

    const { items, hiddenCount } = await getFavorites(user.id)

    // 卡片是 <Link>，点进去是详情页；下架商品的详情页是 404。
    // 所以不显示它 —— 但也不能装作没有，hiddenCount 就是给界面说明用的
    expect(items.map((item) => item.id)).toEqual([alive.id])
    expect(hiddenCount).toBe(1)
    // 【关键】收藏记录本身没被删。商品重新上架，它会自己回到列表里
    expect(await prisma.favorite.count()).toBe(2)
  })

  it("商品重新上架之后，它又回到收藏列表里", async () => {
    const user = await makeUser()
    const product = await makeProduct({ isActive: false })
    // 直接造记录（下架状态下 setFavorite 会拒）
    await prisma.favorite.create({ data: { userId: user.id, productId: product.id } })

    expect((await getFavorites(user.id)).hiddenCount).toBe(1)

    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: true },
    })

    const { items, hiddenCount } = await getFavorites(user.id)
    expect(items.map((item) => item.id)).toEqual([product.id])
    expect(hiddenCount).toBe(0)
  })

  it("没有收藏时返回空列表", async () => {
    const user = await makeUser()

    const { items, hiddenCount } = await getFavorites(user.id)

    expect(items).toEqual([])
    expect(hiddenCount).toBe(0)
  })

  it("商品被物理删除时收藏记录跟着消失", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    await setFavorite(user.id, product.id, true)

    await prisma.product.delete({ where: { id: product.id } })

    // onDelete: Cascade —— 商品都没了，收藏它没有意义。
    // 这条和「下架保留记录」不矛盾：下架是软删除，商品还在
    expect(await prisma.favorite.count()).toBe(0)
    expect((await getFavorites(user.id)).items).toEqual([])
  })
})
