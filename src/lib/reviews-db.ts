import { Prisma } from "@/generated/prisma/client"
import { ORDER_STATUS } from "@/lib/constants"
import { parseImages } from "@/lib/format"
import { prisma } from "@/lib/prisma"
import {
  ADMIN_REVIEWS_PAGE_SIZE,
  REVIEWS_PAGE_SIZE,
  summarizeRatings,
  type RatingSummary,
} from "@/lib/reviews"

// ============================================================================
// 商品评价：数据库读写（只在 Server Component / Server Action 里用）
//
// 纯逻辑（星级解析、分布汇总）在 reviews.ts，那边不碰 prisma，
// 客户端组件可以安全导入。这里只做「取数据 / 写数据」。
// ============================================================================

/** 详情页评价区展示一条评价需要的全部字段 */
export type ReviewView = {
  id: string
  rating: number
  content: string
  /** 已解析成数组的图片路径 */
  images: string[]
  /** 评价人昵称。只取昵称，不带邮箱 —— 详情页是公开页面 */
  authorName: string
  createdAt: Date
}

export type ProductReviewPage = {
  rows: ReviewView[]
  total: number
  page: number
  pageCount: number
  summary: RatingSummary
}

/**
 * 【为什么把 page 洗一遍而不是直接信】
 * 和后台订单列表是同一个坑：URL 里的 ?reviewPage=abc 会让 parseInt 得到
 * NaN，NaN 进了 skip 就是一个 PrismaClientValidationError（500），
 * 而不是「显示第一页」。让这个函数自己保证「拿到的 page 一定可用」，
 * 调用方就不用处处小心。
 */
function safePage(raw: number | undefined): number {
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw as number)) : 1
}

/**
 * 某款商品的评价列表 + 评分汇总。
 *
 * 【为什么 count / 列表 / 分布要放在一次 $transaction 里】
 * 三条查询分开跑的话，中间可能插进来一条新评价 —— 于是「共 3 条」、
 * 列表里 4 行、分布图加起来 4 条，三个数字互相打架。
 * 放进同一个事务读，拿到的是同一个快照。
 *
 * 【为什么列表要按 (createdAt, id) 双字段排序】
 * 只按 createdAt 排的话，同一毫秒创建的两条评价顺序是不确定的 ——
 * 分页时可能出现「第 1 页和第 2 页都显示同一条，另一条不见了」。
 * 补一个唯一的 id 作为第二排序键，顺序才是全序。
 */
export async function getProductReviews(
  productId: string,
  page?: number,
): Promise<ProductReviewPage> {
  const currentPage = safePage(page)
  // 软删除的评价对买家不可见 —— isDeleted 是管理员下架违规内容用的
  const where = { productId, isDeleted: false }

  // 【为什么三条查询要先各自建好、再交给 $transaction】
  // $transaction 的数组形式会给每个元素一个「上下文类型」，而 Prisma 的
  // groupBy 泛型一旦从上下文类型反推，_count 就退化成 `true | {...}`，
  // 于是 bucket._count._all 直接编译不过。先在各自的位置建好，
  // 每个调用的返回类型就已经定型了，再塞进事务里就行。
  const countQuery = prisma.review.count({ where })

  const listQuery = prisma.review.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (currentPage - 1) * REVIEWS_PAGE_SIZE,
    take: REVIEWS_PAGE_SIZE,
    select: {
      id: true,
      rating: true,
      content: true,
      images: true,
      createdAt: true,
      user: { select: { name: true } },
    },
  })

  // 让数据库把「每个星级有几条」数好再回来，
  // 而不是把所有评价的 rating 捞到应用层循环 —— 评价多了就是几千行。
  // orderBy 在这里不是必须的（下面会按星级归到固定的五行里），
  // 但 Prisma 的类型要求带上它，顺带也让结果顺序确定
  const bucketsQuery = prisma.review.groupBy({
    by: ["rating"],
    where,
    orderBy: { rating: "desc" },
    _count: { _all: true },
  })

  const [total, rows, buckets] = await prisma.$transaction([
    countQuery,
    listQuery,
    bucketsQuery,
  ])

  return {
    rows: rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      content: row.content,
      images: parseImages(row.images),
      authorName: row.user.name,
      createdAt: row.createdAt,
    })),
    total,
    page: currentPage,
    pageCount: Math.max(1, Math.ceil(total / REVIEWS_PAGE_SIZE)),
    summary: summarizeRatings(
      buckets.map((bucket) => ({
        rating: bucket.rating,
        count: bucket._count._all,
      })),
    ),
  }
}

// ---------------------------------------------------------------------------
// 写：提交评价
// ---------------------------------------------------------------------------

export type CreateReviewInput = {
  rating: number
  content: string
  images: string[]
}

export type CreateReviewResult =
  | { ok: true; productId: string }
  | { ok: false; error: string }

/** 只关心成功与否的写操作（软删除）用这个 */
export type ReviewMutationResult = { ok: true } | { ok: false; error: string }

/**
 * 提交一条评价。
 *
 * 【鉴权为什么不能用「有没有传 userId」来判断】
 * userId 是调用方（Server Action）从 cookie 里解出来的，这里只做一件事：
 * **用 WHERE 确认这条订单项真的属于他**。和 getOrderDetail 一样的思路 ——
 * 把归属判断写进查询条件，而不是「查出来再 if」。
 *
 * 【为什么必须重新查一次订单状态，而不是相信前端】
 * 「去评价」按钮只在已完成订单的页面渲染，但 Server Action 是个
 * 独立的 POST 端点，谁都可以直接调它。所以「只有买过且订单已完成」
 * 这条规则，必须在写入前用数据库里的**当前**状态再确认一遍。
 *
 * 【并发重复提交怎么办】
 * 这里先查一次 review 是否存在，是为了给出一句人话的提示。
 * 真正的防线是 orderItemId 上的 @unique —— 两个请求同时通过检查时，
 * 数据库只会让一个成功，另一个抛 P2002，我们把它翻译成同一句提示。
 * 又是那套「应用层给体验，数据库给保证」。
 */
export async function createReview(
  orderItemId: string,
  userId: string,
  input: CreateReviewInput,
): Promise<CreateReviewResult> {
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      id: true,
      // 订单项本身不带 productId —— 下单快照里存的是商品名/尺码/颜色/价格，
      // 商品 id 顺着 skuId 关联上去拿（见 src/lib/orders.ts 的说明）
      sku: { select: { productId: true } },
      order: { select: { userId: true, status: true } },
      review: { select: { id: true } },
    },
  })

  // 不存在、和不是自己的订单，返回**同一句话**。
  // 分开说就等于告诉调用者「这个订单项是存在的」，可以拿它探测数据
  if (!item || item.order.userId !== userId) {
    return { ok: false, error: "找不到这条订单商品" }
  }

  if (item.order.status !== ORDER_STATUS.COMPLETED) {
    return { ok: false, error: "订单确认收货之后才能评价" }
  }

  const productId = item.sku?.productId
  // SKU 被物理删除后 skuId 会置空。商品都没了，评价也就无处可挂。
  // （正常路径不会走到这里：deleteSku 会拒绝删除被订单引用过的 SKU）
  if (!productId) {
    return { ok: false, error: "这款商品已经下架，无法评价" }
  }

  if (item.review) {
    return { ok: false, error: "这条商品已经评价过了" }
  }

  try {
    await prisma.review.create({
      data: {
        userId,
        productId,
        orderItemId: item.id,
        rating: input.rating,
        content: input.content,
        // SQLite 不支持标量数组，只能自己序列化
        images: JSON.stringify(input.images),
      },
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // 上面那次「查过没有」到这次 create 之间，另一个请求抢先写进去了
      return { ok: false, error: "这条商品已经评价过了" }
    }
    throw error
  }

  // 把 productId 带回去，调用方要用它作废详情页的缓存
  return { ok: true, productId }
}

/**
 * 软删除一条评价（管理员）。
 *
 * 【为什么是 updateMany + count 而不是先查再改】
 * 老套路：把「当前必须是未删除」写进 WHERE，靠受影响行数判断。
 * 两个管理员同时点删除，只有第一个 count = 1，第二个会拿到
 * 「评价不存在或已被删除」—— 而不是把 deletedAt 之类的字段写两遍。
 */
export async function softDeleteReview(
  reviewId: string,
): Promise<ReviewMutationResult> {
  const result = await prisma.review.updateMany({
    where: { id: reviewId, isDeleted: false },
    data: { isDeleted: true },
  })

  if (result.count === 0) {
    return { ok: false, error: "评价不存在或已被删除" }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// 管理后台：评价列表
// ---------------------------------------------------------------------------

export type AdminReviewRow = {
  id: string
  rating: number
  content: string
  images: string[]
  isDeleted: boolean
  createdAt: Date
  productId: string
  productName: string
  authorName: string
  authorEmail: string
}

export type AdminReviewPage = {
  rows: AdminReviewRow[]
  total: number
  /** 其中被软删除的条数，页面上用来提示「还有 N 条已下架」 */
  deletedCount: number
  page: number
  pageCount: number
}

/**
 * 全站评价列表（管理员）。
 *
 * 【为什么软删除的记录也留在列表里】
 * 如果删掉就从列表里消失，那「软删除」和「真删除」在界面上毫无区别，
 * 管理员没法复查自己删过什么、也发现不了误删。
 * 列表里把已下架的渲染成灰底 + 标记，一眼能区分。
 *
 * 【和 getAdminOrders 一样，这个函数故意不带权限条件】
 * 它查的是全站数据。所以调用点（/admin/reviews 页面）必须自己是管理员 ——
 * 页面走 layout 那道门，写操作走 actions/admin.ts 里的 requireAdmin。
 */
export async function getAdminReviews(page?: number): Promise<AdminReviewPage> {
  const currentPage = safePage(page)

  const [total, deletedCount, rows] = await prisma.$transaction([
    prisma.review.count(),
    prisma.review.count({ where: { isDeleted: true } }),
    prisma.review.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (currentPage - 1) * ADMIN_REVIEWS_PAGE_SIZE,
      take: ADMIN_REVIEWS_PAGE_SIZE,
      select: {
        id: true,
        rating: true,
        content: true,
        images: true,
        isDeleted: true,
        createdAt: true,
        productId: true,
        product: { select: { name: true } },
        user: { select: { name: true, email: true } },
      },
    }),
  ])

  return {
    rows: rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      content: row.content,
      images: parseImages(row.images),
      isDeleted: row.isDeleted,
      createdAt: row.createdAt,
      productId: row.productId,
      productName: row.product.name,
      authorName: row.user.name,
      authorEmail: row.user.email,
    })),
    total,
    deletedCount,
    page: currentPage,
    pageCount: Math.max(1, Math.ceil(total / ADMIN_REVIEWS_PAGE_SIZE)),
  }
}
