import Link from "next/link"
import { notFound } from "next/navigation"
import {
  ArrowLeft,
  ExternalLink,
  Mail,
  MessageSquareQuote,
  User,
} from "lucide-react"

import { RefundReview } from "@/components/admin/refund-review"
import { OrderStatusBadge } from "@/components/orders/order-status-badge"
import { buttonVariants } from "@/components/ui/button"
import {
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  REFUND_STATUS,
  type OrderStatus,
} from "@/lib/constants"
import { formatPrice } from "@/lib/format"
import { getRefundDetailForAdmin } from "@/lib/refunds-db"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

type AdminRefundDetailPageProps = {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: AdminRefundDetailPageProps) {
  const { id } = await params
  return { title: `退款 ${id.slice(-8)} | 管理后台` }
}

/**
 * 退款详情。
 *
 * 【为什么这一页要同时显示「订单信息」和「退款申请」】
 * 管理员要做的判断是「这个退款该不该批」，而这个判断的依据一半在申请里
 * （什么原因、买家说了什么），另一半在订单里（买了什么、多少钱、
 * 什么时候下的单、发货了没有）。把订单信息折叠成一个链接让他自己点过去看，
 * 结果就是他每次都要来回跳两趟 —— 而这一页的**全部意义**
 * 就是让他能在一个屏幕上做出判断。
 */
export default async function AdminRefundDetailPage({
  params,
}: AdminRefundDetailPageProps) {
  const { id } = await params

  const refund = await getRefundDetailForAdmin(id)
  if (!refund) notFound()

  const isPending = refund.status === REFUND_STATUS.PENDING

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href="/admin/refunds"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 gap-1")}
      >
        <ArrowLeft className="size-4" />
        返回退款列表
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">退款申请</h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {refund.order.orderNo}
          </p>
        </div>

        <span
          className={cn(
            "rounded-full border px-3 py-1 text-sm",
            isPending
              ? "border-orange-200 bg-orange-50 text-orange-800"
              : "bg-muted text-muted-foreground",
          )}
        >
          {refund.statusLabel}
        </span>
      </div>

      {/* ---------------- 处理区 ---------------- */}
      {/* 只有 PENDING 才显示按钮。**这只是体验** —— 真正的门在
          approveRefund / rejectRefund 的 WHERE 条件上：
          就算有人手工构造请求，已经被处理过的退款单也改不动 */}
      {isPending && (
        <RefundReview refundId={refund.id} refundAmount={refund.refundAmount} />
      )}

      {/* ---------------- 处理结果 ---------------- */}
      {!isPending && (
        <div
          className={cn(
            "mb-6 rounded-xl border p-4 text-sm",
            refund.status === REFUND_STATUS.REFUNDED
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "bg-muted",
          )}
        >
          <p className="font-medium">
            {refund.status === REFUND_STATUS.REFUNDED
              ? `已退款 ${formatPrice(refund.refundAmount)}`
              : "这次申请被拒绝了"}
          </p>
          {refund.adminNote && (
            <p className="mt-1">理由：{refund.adminNote}</p>
          )}
          {refund.processedAt && (
            <p className="mt-1 text-xs opacity-80">
              处理时间：{refund.processedAt.toLocaleString("zh-CN")}
            </p>
          )}
          {refund.status === REFUND_STATUS.REJECTED && (
            // 拒绝之后订单回到了申请前的状态，这句话是给管理员看的确认 ——
            // 他需要知道「这一单又回到待发货了」，而不是以为它卡在退款里
            <p className="mt-1 text-xs">
              订单已回到「
              {ORDER_STATUS_LABEL[refund.previousStatus as OrderStatus] ??
                refund.previousStatus}
              」，买家可以再次申请。
            </p>
          )}
        </div>
      )}

      {/* ---------------- 退款申请内容 ---------------- */}
      <div className="mb-6 space-y-3 rounded-xl border p-4 text-sm">
        <h2 className="flex items-center gap-1.5 font-medium">
          <MessageSquareQuote className="size-4 text-muted-foreground" />
          退款申请
        </h2>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-muted-foreground">退款原因</div>
            <div>{refund.reasonLabel}</div>
          </div>
          <div>
            <div className="text-muted-foreground">申请时间</div>
            <div className="tabular-nums">
              {refund.createdAt.toLocaleString("zh-CN")}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">退款金额</div>
            {/* 这个数就是订单的实付（原价 - 优惠券），不是原价。
                管理员核对时可以对照下面商品清单里的「实付」那一行 */}
            <div className="font-medium tabular-nums">
              {formatPrice(refund.refundAmount)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">申请时的订单状态</div>
            <div>
              {ORDER_STATUS_LABEL[refund.previousStatus as OrderStatus] ??
                refund.previousStatus}
            </div>
          </div>
        </div>

        <div>
          <div className="text-muted-foreground">买家补充说明</div>
          {/* whitespace-pre-wrap：换行是买家有意敲的 */}
          <p className="whitespace-pre-wrap">
            {refund.description || "（没写）"}
          </p>
        </div>
      </div>

      {/* ---------------- 买家 ---------------- */}
      <div className="mb-6 space-y-3 rounded-xl border p-4 text-sm">
        <h2 className="font-medium">买家</h2>

        <div className="flex gap-2 text-muted-foreground">
          <User className="mt-0.5 size-4 shrink-0" />
          <span className="text-foreground">{refund.order.buyer.name}</span>
        </div>

        <div className="flex gap-2 text-muted-foreground">
          <Mail className="mt-0.5 size-4 shrink-0" />
          <span className="text-foreground">{refund.order.buyer.email}</span>
        </div>
      </div>

      {/* ---------------- 订单摘要 ---------------- */}
      <div className="mb-6 space-y-3 rounded-xl border p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">订单</h2>
          {/*
            【为什么这里直接跳后台的订单详情，而且用「整单」的说法】
            练手阶段一次只能对整单退款（不做部分退），所以管理员要看的
            永远是这一整单。跳到买家那侧的 /orders/[id] 是不行的 ——
            管理员没有那个权限视角（那个查询带 userId）。
          */}
          <Link
            href={`/admin/orders/${refund.order.id}`}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "gap-1",
            )}
          >
            <ExternalLink className="size-3.5" />
            查看完整订单
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-muted-foreground">订单状态</div>
            <div>
              <OrderStatusBadge
                status={refund.order.status}
                label={refund.order.statusLabel}
              />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">订单实付</div>
            <div className="tabular-nums">
              {formatPrice(refund.order.totalAmount)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">下单时间</div>
            <div className="tabular-nums">
              {refund.order.createdAt.toLocaleString("zh-CN")}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">商品</div>
            <div>
              {refund.order.itemKindCount} 种 · 共 {refund.order.totalQuantity} 件
            </div>
          </div>
        </div>

        {/* 订单当前如果不是 REFUNDING，说明有人手工改过库或者出现了
            没预料到的路径。这时候批准会失败（WHERE 条件拦下），
            提前说一句，省得管理员点两次才发现 */}
        {isPending && refund.order.status !== ORDER_STATUS.REFUNDING && (
          <p className="text-xs text-destructive">
            注意：订单当前状态是「{refund.order.statusLabel}」，不是「退款处理中」，
            批准会被拒绝。可能是数据被手工改动过。
          </p>
        )}
      </div>
    </div>
  )
}
