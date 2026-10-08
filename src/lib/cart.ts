import { prisma } from "@/lib/prisma"
import { parseImages } from "@/lib/format"
import type { CartItemView, CartLine } from "@/lib/cart-types"

// ============================================================================
// 购物车（服务端 / 数据库侧）
//
// 已登录用户的购物车存在 cart_items 表里。这张表有一个关键约束：
//   @@unique([userId, skuId])
// 即「一个用户 + 一个 SKU 只能有一行」。
//
// 这条约束让「同 SKU 数量累加」变得非常简单且【并发安全】：
// 用 upsert + increment 一条语句搞定，不需要先查再判断再写。
// 如果没有这个唯一约束，两个并发的加购请求可能同时查到"不存在"，
// 然后各插一行，购物车里就出现两条相同的 SKU。
// ============================================================================

/** 单次最多购买件数 */
const MAX_QUANTITY_PER_ORDER = 10

// ---------------------------------------------------------------------------
// 内部：把查询结果转成展示形态
// ---------------------------------------------------------------------------

/** prisma 查询里需要带上的字段，抽出来复用 */
const SKU_WITH_PRODUCT = {
  id: true,
  skuCode: true,
  size: true,
  color: true,
  price: true,
  stock: true,
  product: {
    select: { id: true, name: true, images: true },
  },
} as const

type SkuWithProduct = {
  id: string
  skuCode: string
  size: string
  color: string
  price: number
  stock: number
  product: { id: string; name: string; images: string }
}

function toCartItemView(sku: SkuWithProduct, quantity: number): CartItemView {
  return {
    skuId: sku.id,
    quantity,
    skuCode: sku.skuCode,
    productId: sku.product.id,
    productName: sku.product.name,
    size: sku.size,
    color: sku.color,
    price: sku.price,
    image: parseImages(sku.product.images)[0] ?? null,
    stock: sku.stock,
  }
}

/** 把数量限制在可购范围内 */
function clampQuantity(quantity: number, stock: number): number {
  const max = Math.max(1, Math.min(stock, MAX_QUANTITY_PER_ORDER))
  return Math.min(Math.max(1, Math.floor(quantity)), max)
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 按 skuId 批量取商品详情。
 *
 * 两个用途：
 *   1. 给本地购物车（localStorage）刷新价格和库存 —— 本地存的只是快照，
 *      可能已经过期
 *   2. 给数据库购物车补齐商品信息（cart_items 表只存 skuId + quantity）
 *
 * 【注意返回顺序】按传入的 ids 顺序返回，且会过滤掉已删除的 SKU。
 * 调用方需要自己处理「本地有、数据库里查不到」的情况（说明该 SKU 被删了）。
 */
export async function getCartItemViews(
  skuIds: string[],
): Promise<CartItemView[]> {
  if (skuIds.length === 0) return []

  const skus = await prisma.sku.findMany({
    where: { id: { in: skuIds } },
    select: SKU_WITH_PRODUCT,
  })

  const bySkuId = new Map(skus.map((s) => [s.id, s]))

  // 按传入顺序返回，保持购物车里的商品顺序稳定
  return skuIds
    .map((skuId) => bySkuId.get(skuId))
    .filter((sku): sku is SkuWithProduct => sku !== undefined)
    .map((sku) => toCartItemView(sku, 1)) // quantity 由调用方补上
}

/** 读取数据库购物车 */
export async function getDbCartItems(userId: string): Promise<CartItemView[]> {
  const rows = await prisma.cartItem.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      quantity: true,
      sku: { select: SKU_WITH_PRODUCT },
    },
  })

  return rows.map((row) => toCartItemView(row.sku, row.quantity))
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/**
 * 加购（已登录用户）。
 *
 * upsert 是关键：
 *   - 已存在 (userId, skuId) → update 分支，quantity 用 increment 原子累加
 *   - 不存在 → create 分支
 * 整个过程是一条 SQL，不存在「先查后写」的竞态窗口。
 */
export async function addToDbCart(
  userId: string,
  skuId: string,
  quantity: number,
): Promise<void> {
  const sku = await prisma.sku.findUnique({
    where: { id: skuId },
    select: { stock: true },
  })

  // SKU 不存在或已售罄，直接忽略（前端正常不会走到这里）
  if (!sku || sku.stock === 0) return

  const qty = clampQuantity(quantity, sku.stock)

  await prisma.cartItem.upsert({
    where: { userId_skuId: { userId, skuId } },
    update: { quantity: { increment: qty } },
    create: { userId, skuId, quantity: qty },
  })
}

/**
 * 把本地购物车合并进数据库（登录后调用）。
 *
 * 【为什么放在事务里】
 * 合并可能涉及多个 SKU，要么全成功要么全失败。如果中途出错留下半份购物车，
 * 用户会以为商品丢了。
 *
 * @returns 合并后的数据库购物车
 */
export async function mergeLocalCartIntoDb(
  userId: string,
  lines: CartLine[],
): Promise<CartItemView[]> {
  if (lines.length === 0) return getDbCartItems(userId)

  // 先查出所有涉及 SKU 的库存，用来夹取数量
  const skus = await prisma.sku.findMany({
    where: { id: { in: lines.map((l) => l.skuId) } },
    select: { id: true, stock: true },
  })
  const stockBySkuId = new Map(skus.map((s) => [s.id, s.stock]))

  await prisma.$transaction(
    lines
      // 过滤掉已被删除的 SKU（本地存的是旧快照）
      .filter((line) => stockBySkuId.has(line.skuId))
      .map((line) => {
        const stock = stockBySkuId.get(line.skuId) ?? 0
        const qty = clampQuantity(line.quantity, stock)

        return prisma.cartItem.upsert({
          where: { userId_skuId: { userId, skuId: line.skuId } },
          // 本地已有 + 数据库已有 → 数量相加。
          // 这就是「登录后合并、同 SKU 累加」的核心一行
          update: { quantity: { increment: qty } },
          create: { userId, skuId: line.skuId, quantity: qty },
        })
      }),
  )

  return getDbCartItems(userId)
}

/** 修改数量（已登录） */
export async function setDbCartQuantity(
  userId: string,
  skuId: string,
  quantity: number,
): Promise<void> {
  const sku = await prisma.sku.findUnique({
    where: { id: skuId },
    select: { stock: true },
  })
  if (!sku) return

  await prisma.cartItem.updateMany({
    // 带 userId 条件，防止越权改别人的购物车
    where: { userId, skuId },
    data: { quantity: clampQuantity(quantity, sku.stock) },
  })
}

/** 移除条目（已登录） */
export async function removeDbCartItem(
  userId: string,
  skuId: string,
): Promise<void> {
  await prisma.cartItem.deleteMany({
    where: { userId, skuId },
  })
}

/** 清空（已登录） */
export async function clearDbCart(userId: string): Promise<void> {
  await prisma.cartItem.deleteMany({ where: { userId } })
}
