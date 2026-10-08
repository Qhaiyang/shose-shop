import Link from "next/link"
import { ChevronLeft, ChevronRight, MessageSquare, Star } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import {
  formatRating,
  RATING_VALUES_DESC,
  REVIEWS_PAGE_SIZE,
} from "@/lib/reviews"
import type { ProductReviewPage } from "@/lib/reviews-db"
import { cn } from "@/lib/utils"

// ============================================================================
// 商品详情页的评价区（服务端组件）
//
// 【为什么整块是服务端渲染的】
// 它没有交互：分数、分布、列表、翻页全是只读内容。翻页用链接（?reviewPage=N）
// 而不是客户端 state —— 和商品列表页的三个筛选条件是同一个思路：
// 条件进 URL，刷新还在、链接能分享、前进后退正常，而且不用发一份 JS。
//
// 【数据由页面传进来，不在这里查】
// 组件只负责「把给它的东西画出来」。查库放在页面里，好处是这个组件
// 可以被任何数据源复用，测试时也不用起数据库。
// ============================================================================

export function ProductReviews({
  productId,
  data,
}: {
  productId: string
  data: ProductReviewPage
}) {
  const { rows, total, page, pageCount, summary } = data

  return (
    <section id="reviews" className="scroll-mt-8 space-y-6">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">用户评价</h2>
        <span className="text-sm text-muted-foreground">共 {total} 条</span>
      </div>

      {total === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
          <MessageSquare className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            还没有评价。确认收货之后，可以在订单详情页里评价这一单。
          </p>
        </div>
      ) : (
        <>
          {/* ---------------- 评分总览 ---------------- */}
          <div className="flex flex-col gap-6 rounded-xl border p-5 sm:flex-row sm:items-center sm:gap-10">
            <div className="text-center sm:w-40 sm:shrink-0">
              <div className="text-4xl font-bold tabular-nums">
                {formatRating(summary.average, summary.total)}
              </div>
              <div className="mt-1 flex justify-center">
                {/* 平均分 4.3 该显示四颗还是一颗半？这里按四舍五入显示整颗 ——
                    半颗星要额外准备一个图标，为这点精度加一份资源不划算，
                    右下角的数字才是精确值 */}
                <Stars value={Math.round(summary.average)} />
              </div>
            </div>

            {/* 分布条：5 星在最上面 */}
            <div className="flex-1 space-y-1.5">
              {summary.bars.map((bar) => (
                <div key={bar.rating} className="flex items-center gap-3 text-sm">
                  <span className="w-8 shrink-0 text-muted-foreground tabular-nums">
                    {bar.rating} 星
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-amber-400"
                      // 内联 style 而不是 Tailwind 类：宽度是运行时算出来的，
                      // 不可能提前写进类名里
                      style={{ width: `${bar.percent}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">
                    {bar.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ---------------- 评价列表 ---------------- */}
          <ul className="space-y-4">
            {rows.map((review) => (
              <li key={review.id} className="rounded-xl border p-4">
                <div className="flex items-center gap-3">
                  {/* 没有头像系统，用昵称首字母顶一下 —— 比一个通用的
                      灰色小人图标更能区分不同的人 */}
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                    {review.authorName.slice(0, 1)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {review.authorName}
                    </div>
                    <Stars value={review.rating} />
                  </div>

                  <span className="shrink-0 text-xs text-muted-foreground">
                    {review.createdAt.toLocaleDateString("zh-CN")}
                  </span>
                </div>

                <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap">
                  {review.content}
                </p>

                {review.images.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {review.images.map((src) => (
                      // 这里不用 next/image：这些路径是用户填的任意外部地址，
                      // 走 next/image 需要给每个域名配 remotePatterns，
                      // 为一个学习项目去开一层图片优化代理不值得。
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={src}
                        src={src}
                        alt="买家晒图"
                        className="size-20 rounded-lg border object-cover"
                      />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {pageCount > 1 && (
            <Pager productId={productId} page={page} pageCount={pageCount} total={total} />
          )}

          <p className="text-xs text-muted-foreground">
            每页最多 {REVIEWS_PAGE_SIZE} 条，只显示未被下架的评价。
          </p>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

/**
 * 五颗星。value 是「亮几颗」——传平均分时调用方已经四舍五入过了。
 *
 * 【为什么用 aria-label 而不是在图标里塞文字】
 * 图标是纯装饰，读屏软件念一串「星星星星星」毫无意义。
 * 包一层带 aria-label 的容器，让它被读成「评分 4 星」。
 */
function Stars({ value }: { value: number }) {
  return (
    <div className="flex gap-0.5" aria-label={`评分 ${value} 星`} role="img">
      {RATING_VALUES_DESC.map((star) => (
        <Star
          key={star}
          aria-hidden
          className={cn(
            "size-3.5",
            star <= value
              ? "fill-amber-400 text-amber-500"
              : "text-muted-foreground/40",
          )}
        />
      ))}
    </div>
  )
}

function Pager({
  productId,
  page,
  pageCount,
  total,
}: {
  productId: string
  page: number
  pageCount: number
  total: number
}) {
  // 翻页后要跳回评价区，否则用户被甩回页面顶部，还得自己往下滚 ——
  // #reviews 就是为此存在的锚点（section 上那个 scroll-mt-8 是它的搭档）
  const hrefFor = (p: number) =>
    `/products/${productId}?reviewPage=${p}#reviews`

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground">
        第 {page} / {pageCount} 页，共 {total} 条
      </p>

      <div className="flex gap-2">
        <PageLink href={page > 1 ? hrefFor(page - 1) : null}>
          <ChevronLeft className="size-4" />
          上一页
        </PageLink>
        <PageLink href={page < pageCount ? hrefFor(page + 1) : null}>
          下一页
          <ChevronRight className="size-4" />
        </PageLink>
      </div>
    </div>
  )
}

/** 到边界时渲染成禁用的 <span>：一个点不动的链接比灰按钮更让人困惑 */
function PageLink({
  href,
  children,
}: {
  href: string | null
  children: React.ReactNode
}) {
  const className = cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    "gap-1",
  )

  if (!href) {
    return (
      <span className={cn(className, "pointer-events-none opacity-50")}>
        {children}
      </span>
    )
  }

  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}
