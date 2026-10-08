"use server"

import { revalidatePath } from "next/cache"

import { getCurrentUser } from "@/lib/auth"
import {
  addToDbCart,
  getCartItemViews,
  getDbCartItems,
  mergeLocalCartIntoDb,
  removeDbCartItem,
  setDbCartQuantity,
} from "@/lib/cart"
import { z } from "zod"
import type { CartItemView } from "@/lib/cart-types"
// 校验规则集中在 src/lib/schemas.ts —— 那里解释了为什么不能定义在本文件里
// （"use server" 文件只能导出 async 函数，schema 一旦定义在这儿就没法被测试 import）
import { cartLineSchema, skuIdSchema } from "@/lib/schemas"

// ============================================================================
// 购物车 Server Actions
//
// 【安全前提，务必记住】
// Server Action 编译后会变成一个可以被任意 POST 请求直接调用的接口，
// 不经过你的 UI。所以：
//   ✗ 绝对不能接受客户端传来的 userId —— 攻击者可以传别人的 id
//   ✓ 必须每次用 getCurrentUser() 从 cookie 里自己解析出用户
// 下面每个 action 的第一件事都是取 user，就是这个原因。
//
// 【为什么不传 userId 参数】
// 有些人会写 addToCart(userId, skuId)，然后在前端传当前用户 id。
// 这等于把「我是谁」的决定权交给了客户端 —— 攻击者改个请求就能操作别人的购物车。
// ============================================================================

type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 未登录用户：刷新本地购物车的价格和库存
// ---------------------------------------------------------------------------

/**
 * 本地购物车（localStorage）只存快照，可能已经过期。
 * 购物车页面加载时调这个函数拿最新的价格和库存。
 *
 * 【这个 action 不需要登录】它只是按 skuId 查公开的商品信息，
 * 不涉及任何用户私有数据，所以未登录也能调。
 */
export async function refreshCartItemsAction(
  skuIds: string[],
): Promise<CartItemView[]> {
  const parsed = z.array(skuIdSchema).max(100).safeParse(skuIds)
  if (!parsed.success) return []

  return getCartItemViews(parsed.data)
}

// ---------------------------------------------------------------------------
// 已登录用户：数据库购物车
// ---------------------------------------------------------------------------

/** 加入购物车（已登录）。同一个 SKU 会自动累加数量 */
export async function addToCartAction(
  skuId: string,
  quantity: number,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: "未登录" }

  const parsed = cartLineSchema.safeParse({ skuId, quantity })
  if (!parsed.success) return { ok: false, error: "参数不合法" }

  await addToDbCart(user.id, parsed.data.skuId, parsed.data.quantity)

  revalidatePath("/cart")
  return { ok: true, data: undefined }
}

/** 修改数量 */
export async function updateCartQuantityAction(
  skuId: string,
  quantity: number,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: "未登录" }

  const parsed = cartLineSchema.safeParse({ skuId, quantity })
  if (!parsed.success) return { ok: false, error: "参数不合法" }

  await setDbCartQuantity(user.id, parsed.data.skuId, parsed.data.quantity)

  revalidatePath("/cart")
  return { ok: true, data: undefined }
}

/** 移除条目 */
export async function removeCartItemAction(
  skuId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: "未登录" }

  if (!skuIdSchema.safeParse(skuId).success) {
    return { ok: false, error: "参数不合法" }
  }

  await removeDbCartItem(user.id, skuId)

  revalidatePath("/cart")
  return { ok: true, data: undefined }
}

// ---------------------------------------------------------------------------
// 登录后合并本地购物车 → 数据库
// ---------------------------------------------------------------------------

/**
 * 把 localStorage 里的购物车合并进数据库。
 *
 * 合并策略：同 SKU 数量相加（不是覆盖，也不是取最大值）。
 * 例：本地有 2 件 A，数据库里已有 1 件 A，合并后是 3 件。
 *
 * 之所以相加而不是覆盖：用户可能在登录前加购过（本地 2 件），
 * 上次登录时也加过（数据库 1 件），两批都是他真实想买的。
 *
 * 合并成功后由调用方负责清空本地购物车，避免下次登录重复合并。
 */
export async function mergeLocalCartAction(
  lines: { skuId: string; quantity: number }[],
): Promise<ActionResult<CartItemView[]>> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: "未登录" }

  const parsed = z.array(cartLineSchema).max(100).safeParse(lines)
  if (!parsed.success) return { ok: false, error: "参数不合法" }

  const merged = await mergeLocalCartIntoDb(user.id, parsed.data)

  revalidatePath("/cart")
  return { ok: true, data: merged }
}

/** 读取数据库购物车（客户端主动刷新用） */
export async function fetchDbCartAction(): Promise<CartItemView[]> {
  const user = await getCurrentUser()
  if (!user) return []

  return getDbCartItems(user.id)
}
