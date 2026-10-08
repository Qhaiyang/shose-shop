// ============================================================================
// 商品评价：纯逻辑（常量 / 解析 / 汇总）
//
// 【为什么这个文件里没有一句数据库代码】
// 详情页的评价区里有个星条分布图，那是**客户端组件**要用的东西。
// 而客户端组件的依赖链上只要出现 @/lib/prisma（better-sqlite3 原生模块），
// 浏览器打包就会报 "Can't resolve 'fs'"。所以这里只放不碰数据库的部分，
// 查库的那半边在 reviews-db.ts —— 和尺码建议（size-guide / size-guide-db）
// 是同一套拆法。
// ============================================================================

/** 星级范围。1 星到 5 星，没有 0 星也没有半星 */
export const REVIEW_MIN_RATING = 1
export const REVIEW_MAX_RATING = 5

/** 星条分布图从上往下渲染的顺序：5 星在最上面 */
export const RATING_VALUES_DESC = [5, 4, 3, 2, 1] as const

/**
 * 评价内容的长度限制。
 *
 * 【为什么有下限】
 * 「好」「不错」这种两个字的内容对后来买家没有任何信息量。
 * 下限不是为了刁难用户，是让这一栏真的有用。
 * 上限是防「粘贴进来一整篇文章」，把详情页撑爆。
 */
export const REVIEW_MIN_CONTENT = 5
export const REVIEW_MAX_CONTENT = 500

/** 一条评价最多几张图 */
export const REVIEW_MAX_IMAGES = 3

/** 详情页评价区一页显示几条 */
export const REVIEWS_PAGE_SIZE = 5

/** 后台评价列表一页显示几条 */
export const ADMIN_REVIEWS_PAGE_SIZE = 20

/** 星级对应的中文标签，鼠标悬停和提交后展示都用它 */
export const RATING_LABEL: Record<number, string> = {
  5: "非常满意",
  4: "满意",
  3: "一般",
  2: "不太满意",
  1: "不满意",
}

/** 数据库里可能存着越界的星级（SQLite 不会拦），给个兜底文案 */
export function ratingLabel(rating: number): string {
  return RATING_LABEL[rating] ?? "未评分"
}

/**
 * 把表单里传来的星级收窄成 1~5 的整数。
 *
 * 表单一律是字符串，「5」和 5 都可能进来，所以统一先转数字再判范围。
 * 拿不准就返回 null，由 zod / 调用方决定报什么错 ——
 * 绝不做「四舍五入到最近的合法值」这种自作主张的修正。
 */
export function parseRating(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isInteger(input) &&
      input >= REVIEW_MIN_RATING &&
      input <= REVIEW_MAX_RATING
      ? input
      : null
  }

  if (typeof input === "string") {
    // 只认「纯整数字符串」。用 Number() 的话 "" 会变成 0，
    // "3.7" 会变成 3.7，都得再拦一道，不如直接用正则卡死格式
    if (!/^\d+$/.test(input.trim())) return null
    return parseRating(Number(input.trim()))
  }

  return null
}

/**
 * 平均分展示：保留一位小数。
 * 0 条评价时不能显示 "0.0 分" —— 那会被读成「大家都给了 0 分」，
 * 实际是「还没有人评过」，两者天差地别。
 */
export function formatRating(average: number, total: number): string {
  if (total === 0) return "暂无评分"
  return average.toFixed(1)
}

/** 数据库 groupBy 直接给出的形状：某个星级有几条 */
export type RatingBucket = {
  rating: number
  count: number
}

/** 星条分布图的一行 */
export type RatingBar = {
  rating: number
  count: number
  /** 占比，四舍五入到整数百分比。total 为 0 时是 0 */
  percent: number
}

export type RatingSummary = {
  /** 参与统计的评价条数 */
  total: number
  /** 平均分，保留一位小数。total 为 0 时是 0 */
  average: number
  /** 5 星到 1 星，**固定五行**，没有的补 0 —— 少一行会让分布图缺一根柱子 */
  bars: RatingBar[]
}

/**
 * 把「各星级各几条」汇总成详情页要用的平均分 + 分布。
 *
 * 【为什么要单独写一个函数、而不是在 SQL 里算】
 * 平均分放 SQL 里一个 AVG() 就出来了，但分布图的百分比、五行的补齐、
 * 空数据的边界，这些都得在应用层做。既然反正要过一遍应用层，
 * 就把它做成一个**纯粹的函数**：输入是几行计数，输出是可直接渲染的结构。
 * 这样它的每个边界（空、全是同一个星级、越界的星级）都能用单元测试钉死，
 * 不需要起数据库。
 *
 * 【越界的星级怎么办】
 * SQLite 没有 CHECK 约束，理论上库里可能有一条 rating = 7 的脏数据。
 * 这里直接忽略它 —— 宁可少算一条，也不要让分布图多出一根「7 星」的柱子。
 */
export function summarizeRatings(buckets: RatingBucket[]): RatingSummary {
  const counts = new Map<number, number>()
  let total = 0
  let weighted = 0

  for (const bucket of buckets) {
    if (
      !Number.isInteger(bucket.rating) ||
      bucket.rating < REVIEW_MIN_RATING ||
      bucket.rating > REVIEW_MAX_RATING
    ) {
      continue
    }
    counts.set(bucket.rating, (counts.get(bucket.rating) ?? 0) + bucket.count)
    total += bucket.count
    weighted += bucket.rating * bucket.count
  }

  return {
    total,
    // 一位小数：Math.round(x * 10) / 10 而不是 toFixed，
    // 因为这里要的是**数字**，格式化交给 formatRating
    average: total === 0 ? 0 : Math.round((weighted / total) * 10) / 10,
    bars: RATING_VALUES_DESC.map((rating) => {
      const count = counts.get(rating) ?? 0
      return {
        rating,
        count,
        // 百分比可能有小数，分布图只要个整数宽度。宁可各段加起来是 99%，
        // 也不要为凑成 100% 去调整某一根柱子的宽度 —— 那才是真的错
        percent: total === 0 ? 0 : Math.round((count / total) * 100),
      }
    }),
  }
}
