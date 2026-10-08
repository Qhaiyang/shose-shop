import { CATEGORY_MAX_LENGTH, PRODUCT_SEARCH_MAX_LENGTH } from "@/lib/constants"

// ============================================================================
// 前台商品列表的 URL 参数解析
//
// 这一页的搜索 / 分类 / 排序完全由 URL 驱动：?q= 搜索、?category= 分类、
// ?sort= 排序。解析是纯函数，方便单元测试 —— 输入是不可信的 URL 字符串，
// 输出是收窄后的、能直接塞进 Prisma where / 排序逻辑里的干净值。
// ============================================================================

export const PRODUCT_SORTS = ["newest", "price_asc", "price_desc"] as const
export type ProductSort = (typeof PRODUCT_SORTS)[number]

export type ProductListQuery = {
  /** 搜索关键词，空字符串表示「不搜索」 */
  q: string
  /** 分类名，undefined 表示「不筛分类」 */
  category?: string
  /** 排序方式，永远是白名单里的三个值之一 */
  sort: ProductSort
}

/**
 * 把不可信的 URL 参数解析成干净的查询条件。
 *
 * 【为什么 sort 一定要白名单】
 * 排序方向本来只允许三个字面量。如果直接 `params.sort` 传下去，
 * 恶意或手滑的 ?sort=price_asc; DROP TABLE 就会一路走到排序逻辑里。
 * 虽然我们的排序不是拼进 SQL 的（是在 JS 里 sort 的），不会注入，
 * 但「任何不在白名单里的值都落回默认」这个习惯要养成 ——
 * 哪天排序真的下沉到 SQL orderBy，这里就是最后一道闸。
 */
export function parseProductListQuery(params: {
  q?: string | null
  category?: string | null
  sort?: string | null
}): ProductListQuery {
  // 截断长度：不是防注入（查询都是参数化的），是防一个几万字符的关键词
  // 让 LIKE 白白扫一遍全表。商品名/描述最长也就几十个字，40 个字已经是
  // 「他可能粘贴错东西了」的信号
  const q = (params.q ?? "").trim().slice(0, PRODUCT_SEARCH_MAX_LENGTH)

  // 分类同理。注意空串要归为 undefined —— 「筛空分类」和「不筛分类」
  // 在语义上必须是一回事，否则数据库里若有 category 为空的商品，
  // 空串会变成「只找分类为空」的筛选
  const category = (params.category ?? "").trim().slice(0, CATEGORY_MAX_LENGTH)

  const sort = (PRODUCT_SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as ProductSort)
    : "newest"

  return { q, category: category || undefined, sort }
}
