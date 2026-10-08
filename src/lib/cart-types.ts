// ============================================================================
// 购物车类型
//
// 【为什么单独一个文件】
// 购物车有两套存储：未登录时在浏览器 localStorage（客户端），登录后在数据库
// （服务端）。两边都需要同一套类型，但这个文件不能 import prisma —— 否则客户端
// 组件一旦 import 它，就会把整个数据库客户端打进浏览器 bundle，既臃肿又危险。
// 所以类型定义单独放这里，只依赖纯类型，两边都能安全引用。
// ============================================================================

/**
 * 购物车条目的「存储形态」——只管标识和数量。
 * 数据库里的 CartItem 表就是这个形状（再加 id/userId 等）。
 */
export type CartLine = {
  skuId: string
  quantity: number
}

/**
 * 购物车条目的「展示形态」——带上商品快照。
 *
 * 为什么要存快照（而不是每次拿 skuId 去查库）？
 *   1. 未登录用户的购物车在 localStorage 里，页面要立刻渲染出来，
 *      不能等一次网络往返
 *   2. localStorage 里只有 skuId 的话，用户断网/后端挂了就啥也看不到
 * 代价是快照可能过期（比如管理员改了价）。所以购物车页面加载时会调
 * 服务端刷新一次价格和库存，下单时（第 6 步）还会再校验一次。
 */
export type CartItemView = {
  skuId: string
  quantity: number

  // ---- 商品快照 ----
  skuCode: string
  productId: string
  productName: string
  size: string
  color: string
  /** 单价，单位：分 */
  price: number
  /** 商品主图路径 */
  image: string | null

  // ---- 实时数据（每次从服务端刷新）----
  /** 当前库存，用于提示「库存不足」并把数量压到可购范围 */
  stock: number
}

/** 购物车小计（单位：分） */
export function cartSubtotal(items: CartItemView[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

/** 购物车总件数 */
export function cartCount(items: CartItemView[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0)
}

// ---------------------------------------------------------------------------
// 库存校验
//
// 【为什么抽成纯函数】
// 「哪些行库存不足」这个判断在购物车页和结算页各用了一次，之前是各自
// 手写一个 filter。抽出来有两个好处：
//   1. 两边不会再写岔（一个用 stock===0、另一个用 quantity>stock）
//   2. 纯函数不碰数据库，能直接单测
// ---------------------------------------------------------------------------

/** 一条库存出问题的购物车条目 */
export type StockProblem = {
  skuId: string
  /** 当前库存 */
  stock: number
  /** 购物车里的数量 */
  quantity: number
}

/**
 * 找出库存不足的条目。
 *
 * 不足有两种情况：
 *   - 库存为 0（已售罄）
 *   - 想买的数量超过了现有库存（quantity > stock）
 */
export function findStockProblems(
  items: { skuId: string; stock: number; quantity: number }[],
): StockProblem[] {
  return items
    .filter((item) => item.stock === 0 || item.quantity > item.stock)
    .map(({ skuId, stock, quantity }) => ({ skuId, stock, quantity }))
}
