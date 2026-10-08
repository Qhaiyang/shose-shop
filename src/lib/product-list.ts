import { parseImages } from "@/lib/format"
// 【必须是 import type】下面这个文件（products.ts）import 了 prisma，
// 而这里只借它的类型。type-only import 编译后会被完全抹掉，
// 所以这个模块不会把数据库客户端拖进任何引用它的地方
// （客户端组件、单元测试都能安全地 import 它）
import type { ProductListItem } from "@/lib/products"

// ============================================================================
// 「商品行 → 商品卡片数据」的映射
//
// 【为什么单独抽一个文件，而不是留在 products.ts 里】
// 有两个调用方了：
//   1. getAllProducts()  —— 商品列表页
//   2. getFavorites()    —— 我的收藏（src/lib/favorites-db.ts）
// 两边查的是同一张表、要的是同一个卡片形状。各写一份的话，哪天给
// ProductListItem 加一个字段（比如加个「新品」标记），收藏页会静默地
// 漏掉它 —— 页面上什么都不报错，就是少一块。
//
// 顺带的好处：这是个不碰数据库的纯函数，能直接单测
// （见 tests/unit/product-list.test.ts）。
// ============================================================================

/**
 * 算 ProductListItem 需要的最小字段集合。
 *
 * 注意只取 price / stock，不取整行 SKU —— 卡片上要显示的是价格区间
 * 和「是否全部售罄」，把每个 SKU 的颜色尺码都拉回来纯属浪费。
 */
export const PRODUCT_LIST_SELECT = {
  id: true,
  name: true,
  category: true,
  images: true,
  skus: {
    select: { price: true, stock: true },
  },
} as const

/** PRODUCT_LIST_SELECT 查出来的行的形状 */
export type ProductListRow = {
  id: string
  name: string
  category: string
  /** JSON 字符串数组，需要 parseImages 解析 */
  images: string
  skus: { price: number; stock: number }[]
}

/**
 * 把一行商品数据摊平成卡片需要的形状。
 *
 * 几个边界情况的处理写在下面各自的注释里，它们都是「看起来显然、
 * 但一句话写错就会静默出错」的地方。
 */
export function toProductListItem(product: ProductListRow): ProductListItem {
  const prices = product.skus.map((s) => s.price)
  const images = parseImages(product.images)

  return {
    id: product.id,
    name: product.name,
    category: product.category,
    // 主图就是第一张。没有图时给 null，让组件去渲染占位而不是塞个空串进 <img src="">
    image: images[0] ?? null,
    // Math.min() 对空数组返回 Infinity，会一路传到界面上变成 "Infinity 元"，
    // 所以要单独处理「一个 SKU 都没有」的商品
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    // every 对空数组返回 true —— 没有 SKU 的商品算售罄，符合直觉
    soldOut: product.skus.every((s) => s.stock === 0),
    skuCount: product.skus.length,
  }
}
