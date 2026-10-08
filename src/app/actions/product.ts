"use server"

import { getSkuAvailability } from "@/lib/products"
import { skuIdSchema } from "@/lib/schemas"

// ============================================================================
// 商品只读 Server Actions
//
// 【为什么这个 action 不需要登录】
// 库存和价格是公开的商品信息，浏览者（未登录）也需要看。
// 它不碰任何用户私有数据，所以不调 getCurrentUser。
// ============================================================================

export type SkuAvailabilityResult =
  | { ok: true; stock: number; price: number }
  | { ok: false; error: string }

/**
 * 查单个 SKU 的实时库存和价格。
 *
 * 详情页在用户切换规格时调它，绕过「页面加载那一刻」的快照。
 * skuId 是公开数据（就在 URL / 页面里），不是秘密，这里校验只是防脏输入。
 */
export async function getSkuAvailabilityAction(
  skuId: string,
): Promise<SkuAvailabilityResult> {
  const parsed = skuIdSchema.safeParse(skuId)
  if (!parsed.success) return { ok: false, error: "规格参数不合法" }

  const sku = await getSkuAvailability(parsed.data)
  if (!sku) return { ok: false, error: "该规格已不存在" }

  return { ok: true, stock: sku.stock, price: sku.price }
}
