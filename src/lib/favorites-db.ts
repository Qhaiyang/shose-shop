import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { PRODUCT_LIST_SELECT, toProductListItem } from "@/lib/product-list"
import type { ProductListItem } from "@/lib/products"

// ============================================================================
// 商品收藏（服务端 / 数据库侧）
//
// 【和 src/lib/cart.ts 对照着看】
// 购物车那边有 upsert + increment、有「本地合并进数据库」，这里全都没有 ——
// 收藏只有数据库一份存储，并且「收藏」这个动作本身是幂等的：
//   收藏两次 = 收藏一次，取消两次 = 取消一次。
// 幂等意味着不需要事务、不需要先查后写，一条语句就够。
//
// 【为什么没有 favorites.ts 那一半（纯逻辑那一半）】
// 购物车拆出 cart-types.ts，是因为未登录时要在浏览器里跑同一套逻辑。
// 收藏必须登录，所有逻辑都在服务端，没有「两边都要用」的东西可拆。
// 这里唯一值得单测的纯函数是 toProductListItem，它已经在
// src/lib/product-list.ts 里了。
// ============================================================================

/** 「我的收藏」页要的东西：能显示的商品 + 被藏起来的数量 */
export type FavoritesView = {
  items: ProductListItem[]
  /**
   * 收藏夹里已经下架、所以没列出来的商品数。
   *
   * 【为什么不直接把下架的商品也画出来】
   * 卡片整个是 <Link>，点进去是商品详情页，而 getProductDetail 对
   * isActive = false 的商品返回 null → 404。摆一排点进去就 404 的卡片
   * 比不显示更糟。但也不能装作没有：用户明明收藏过，列表里却少了，
   * 会以为是系统把收藏弄丢了。所以数出来告诉他有几款下架了。
   *
   * 收藏记录本身**没有**被删 —— 商品重新上架，它自己就回到列表里了。
   */
  hiddenCount: number
}

/** 收藏 / 取消收藏的结果 */
export type FavoriteMutationResult =
  | { ok: true; favorited: boolean }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 这个人收藏过这款商品吗？
 *
 * 详情页用它决定心形按钮的初始状态。
 * 【为什么不用 count()】findUnique 走的是 @@unique([userId, productId])
 * 那个索引，命中与否都是直接一次索引查找；count 还得数。这里只关心
 * 「有没有」，用 findUnique 语义最准。
 */
export async function isFavorited(
  userId: string,
  productId: string,
): Promise<boolean> {
  const row = await prisma.favorite.findUnique({
    where: { userId_productId: { userId, productId } },
    select: { id: true },
  })
  return row !== null
}

/**
 * 我的收藏列表（按收藏时间倒序，最近收藏的在最前面）。
 *
 * 【为什么不用分页】
 * 收藏是用户自己攒出来的短列表，不像评价那样会无限增长。
 * 真到了需要分页的规模，再加也不迟 —— 现在加就是多余的一层。
 */
export async function getFavorites(userId: string): Promise<FavoritesView> {
  const rows = await prisma.favorite.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      product: {
        // 在商品那张表的字段集合上多要一个 isActive ——
        // 下面要靠它把已下架的分出去
        select: { ...PRODUCT_LIST_SELECT, isActive: true },
      },
    },
  })

  const active = rows.filter((row) => row.product.isActive)

  return {
    items: active.map((row) => toProductListItem(row.product)),
    hiddenCount: rows.length - active.length,
  }
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/**
 * 设置收藏状态（幂等）。
 *
 * 【为什么是 set(desired) 而不是 toggle()】
 * toggle 的意思由**服务端当前的状态**决定，而请求是客户端发起的 ——
 * 客户端看到的那个状态可能已经旧了（在另一个标签页里取消过收藏，
 * 或者点得很快连点了两下）。那种情况下 toggle 会翻到用户不想要的方向。
 * 传「我想要什么」，服务端照着做，无论当前是什么状态结果都一样。
 *
 * 同一个理由也解释了为什么这里的 add 和 remove 都不需要先查一次。
 */
export async function setFavorite(
  userId: string,
  productId: string,
  favorited: boolean,
): Promise<FavoriteMutationResult> {
  if (!favorited) {
    // 取消收藏：删不到行也算成功（本来就没收藏过，结果正是用户要的）
    await prisma.favorite.deleteMany({ where: { userId, productId } })
    return { ok: true, favorited: false }
  }

  // 收藏之前先确认商品还在售。
  // 【为什么不用「直接插，靠外键报错」】外键只能挡住「商品不存在」，
  // 挡不住「商品已下架」—— 那是一行还在的数据，外键完全合法。
  // 下架的商品不该能被新收藏，所以这里得自己查一眼
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { isActive: true },
  })
  if (!product || !product.isActive) {
    return { ok: false, error: "商品不存在或已下架" }
  }

  try {
    await prisma.favorite.create({ data: { userId, productId } })
  } catch (error) {
    // P2002 = 唯一约束冲突。走到这里说明用户在两个页面/两次点击里
    // 同时收藏了同一款鞋，而我们要的结果（有一行收藏记录）已经达成了 ——
    // 这不是错误，什么都不用做
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { ok: true, favorited: true }
    }
    throw error
  }

  return { ok: true, favorited: true }
}
