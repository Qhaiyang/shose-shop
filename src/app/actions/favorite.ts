"use server"

import { revalidatePath } from "next/cache"

import { getCurrentUser } from "@/lib/auth"
import { setFavorite } from "@/lib/favorites-db"

// ============================================================================
// 收藏 Server Action
//
// 【和购物车 action 一样的安全前提】
// Server Action 编译后就是一个可以被任意 POST 直接打的接口，不经过 UI。
// 所以：
//   ✗ 不接受客户端传 userId —— 那等于让攻击者决定「我是谁」
//   ✓ 每次自己从 cookie 里解析（getCurrentUser）
//
// 【但收藏这里多一条：必须登录】
// 购物车允许游客（先存 localStorage），收藏不允许 —— 它没有对应的
// 本地存储，userId 是这张表的一部分。所以未登录直接拒掉，
// 而不是「默默地用某个匿名身份存下来」。
// ============================================================================

export type FavoriteActionResult =
  | { ok: true; favorited: boolean }
  | { ok: false; error: string }

/**
 * 收藏 / 取消收藏一款商品。
 *
 * @param productId 商品 id（SPU，不是 SKU —— 收藏的是「这款鞋」）
 * @param favorited 想要的结果状态，而不是「翻转」。
 *                  理由写在 src/lib/favorites-db.ts 的 setFavorite 上
 */
export async function setFavoriteAction(
  productId: string,
  favorited: boolean,
): Promise<FavoriteActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: "请先登录" }

  // 参数来自网络，先收窄。长度上限是照着 cuid 的量级给的余量，
  // 不是精确值 —— 目的是别让一个几 MB 的字符串进到查询里
  if (typeof productId !== "string" || productId.length === 0 || productId.length > 64) {
    return { ok: false, error: "参数不合法" }
  }
  // 【为什么显式判 boolean】不判的话，传进来的 "false" 是真值，
  // 会被当成「要收藏」—— 和后台批量上下架踩过的是同一个坑
  // （见 src/app/actions/admin.ts 里 isActive 那段注释）
  if (typeof favorited !== "boolean") {
    return { ok: false, error: "参数不合法" }
  }

  const result = await setFavorite(user.id, productId, favorited)
  if (!result.ok) return result

  // 详情页和收藏页都是 dynamic 渲染（它们读了 cookies/searchParams），
  // 本来就不吃缓存，这一句现在其实不做任何事。
  // 留着是因为它把「改了收藏 → 这两处的界面会变」这个依赖关系写在代码里；
  // 哪天有人给某一页加上静态缓存，不至于悄悄僵住
  revalidatePath("/favorites")
  revalidatePath(`/products/${productId}`)

  return result
}
