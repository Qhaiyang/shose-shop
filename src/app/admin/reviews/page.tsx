import Link from "next/link"
import { ChevronLeft, ChevronRight, MessageSquareQuote } from "lucide-react"

import { DeleteReviewButton } from "@/components/admin/delete-review-button"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ADMIN_REVIEWS_PAGE_SIZE, ratingLabel } from "@/lib/reviews"
import { getAdminReviews } from "@/lib/reviews-db"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里，这一页不用重复写。
// 写操作（下架评价）在 src/app/actions/admin.ts 里另外校验了一遍 ——
// 理由见那个文件顶部的长注释：layout 拦不住 Server Action
export const dynamic = "force-dynamic"

export const metadata = { title: "评价管理 | 管理后台" }

// ============================================================================
// 评价管理
//
// 【为什么软删除的记录也显示在列表里】
// 如果删掉就从列表消失，「软删除」和「真删除」在界面上就毫无区别了：
// 管理员没法复查自己删过什么，误删了也发现不了。
// 所以这里把已下架的行渲染成灰底 + 标记，和正常评价一眼能分开。
// ============================================================================

type AdminReviewsPageProps = {
  // Next 16：searchParams 是 Promise
  searchParams: Promise<{ page?: string }>
}

export default async function AdminReviewsPage({
  searchParams,
}: AdminReviewsPageProps) {
  const params = await searchParams

  // 和后台订单页一样的解析：非法值统一落回第 1 页。
  // getAdminReviews 内部也会再洗一遍，双保险的成本是零
  const parsed = Number.parseInt(params.page ?? "1", 10)
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1

  const data = await getAdminReviews(page)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">评价管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {data.total} 条评价
          {data.deletedCount > 0 && ` · 其中 ${data.deletedCount} 条已下架`}
        </p>
      </div>

      {data.rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
          <MessageSquareQuote className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">还没有任何评价</p>
        </div>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>商品</TableHead>
                <TableHead>评价人</TableHead>
                <TableHead>评分</TableHead>
                <TableHead>内容</TableHead>
                <TableHead>时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {data.rows.map((review) => (
                <TableRow
                  key={review.id}
                  // 已下架的行整行压暗。管理员扫一眼就知道哪些是"不在前台"
                  className={cn(review.isDeleted && "opacity-50")}
                >
                  <TableCell>
                    <Link
                      href={`/products/${review.productId}`}
                      className="text-sm hover:underline"
                    >
                      {review.productName}
                    </Link>
                  </TableCell>

                  <TableCell>
                    <div className="text-sm">{review.authorName}</div>
                    <div className="text-xs text-muted-foreground">
                      {review.authorEmail}
                    </div>
                  </TableCell>

                  <TableCell className="text-sm whitespace-nowrap">
                    {review.rating} 星
                    <span className="ml-1 text-xs text-muted-foreground">
                      {ratingLabel(review.rating)}
                    </span>
                  </TableCell>

                  <TableCell className="max-w-md">
                    <p className="text-sm whitespace-pre-wrap">{review.content}</p>
                    {review.images.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        附 {review.images.length} 张图
                      </p>
                    )}
                  </TableCell>

                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {review.createdAt.toLocaleString("zh-CN")}
                  </TableCell>

                  <TableCell className="text-right">
                    {review.isDeleted ? (
                      <Badge variant="secondary">已下架</Badge>
                    ) : (
                      <DeleteReviewButton
                        reviewId={review.id}
                        productId={review.productId}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data.pageCount > 1 && (
        <Pager page={data.page} pageCount={data.pageCount} total={data.total} />
      )}

      <p className="text-xs text-muted-foreground">
        每页 {ADMIN_REVIEWS_PAGE_SIZE} 条
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function Pager({
  page,
  pageCount,
  total,
}: {
  page: number
  pageCount: number
  total: number
}) {
  // 这一页只有一个筛选条件（页码），拼起来简单，就不单独抽 queryHref 了。
  // 条件涨到两个以上时再抽 —— 见后台订单页那段注释的教训
  const hrefFor = (p: number) =>
    p > 1 ? `/admin/reviews?page=${p}` : "/admin/reviews"

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

function PageLink({
  href,
  children,
}: {
  href: string | null
  children: React.ReactNode
}) {
  const className = cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")

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
