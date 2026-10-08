import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { CheckCheck, Clock, MapPin, Phone, Truck } from "lucide-react"

import { ConfirmReceiptButton } from "@/components/orders/confirm-receipt-button"
import { OrderItemsCard } from "@/components/orders/order-items-card"
import { OrderNoteCard } from "@/components/orders/order-note-card"
import { OrderStatusBadge } from "@/components/orders/order-status-badge"
import { OrderTimeline } from "@/components/orders/order-timeline"
import { PayButton } from "@/components/orders/pay-button"
import { RefundCard } from "@/components/orders/refund-card"
import { ReviewButton } from "@/components/orders/review-button"
import { buttonVariants } from "@/components/ui/button"
import { getCurrentUser } from "@/lib/auth"
import { isNoteEditable, isRefundable, ORDER_STATUS } from "@/lib/constants"
import {
  cancelExpiredOrders,
  getOrderDetail,
  type OrderItemView,
} from "@/lib/orders"
import { getLatestRefundForOrder } from "@/lib/refunds-db"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

type OrderDetailPageProps = {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: OrderDetailPageProps) {
  const { id } = await params
  return { title: `订单 ${id.slice(-8)} | 鞋店` }
}

/**
 * 已完成订单里，每一行商品右侧显示什么。
 *
 * 【只有「已完成」的订单才有评价这一说】
 * 还没收到货就能评价的话，评价区会被「还没发货，先给个五星」刷满，
 * 对后来的买家毫无参考价值。所以入口只在 COMPLETED 状态出现 ——
 * 这也是服务端 createReview 会再确认一遍的条件。
 *
 * 【为什么「已评价」要显示一行灰字、而不是干脆什么都不显示】
 * 不显示的话，用户会以为漏了或者找不着入口，反复点开订单看。
 * 一句话说明白「这件已经评过了」，比留白友好。
 */
function renderReviewAction(item: OrderItemView) {
  // 取不到商品（SKU 被物理删除）就没法评价 —— 详情页也打不开
  if (!item.productId) return null

  if (item.reviewId) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">已评价</span>
    )
  }

  return <ReviewButton orderItemId={item.id} />
}

export default async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const { id } = await params

  const user = await getCurrentUser()
  if (!user) redirect(`/login?next=/orders/${id}`)

  // 【第 8 步的兜底】用户直接点开一条早就过期的订单链接时，
  // 先把这个人的超时订单扫一遍，免得看到一条「已过期却还显示待支付」的订单。
  // 只扫当前用户，走 userId 索引，代价很小
  await cancelExpiredOrders({ userId: user.id })

  // 注意 userId 一起传进去：查别人的订单会返回 null，
  // 然后走 notFound()。不区分「不存在」和「不是你的」，避免泄露订单是否存在
  const order = await getOrderDetail(id, user.id)
  if (!order) notFound()

  // 最近一次退款申请。**不带 userId 的查询不在这里** ——
  // getLatestRefundForOrder 自己会带上，理由见那个函数的注释
  const refund = await getLatestRefundForOrder(order.id, user.id)

  const isPending = order.status === ORDER_STATUS.PENDING_PAYMENT
  const isShipped = order.status === ORDER_STATUS.SHIPPED

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">订单详情</h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {order.orderNo}
          </p>
        </div>

        <OrderStatusBadge status={order.status} label={order.statusLabel} />
      </div>

      {/* ---------------- 待支付提醒 ---------------- */}
      {isPending && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <Clock className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm text-amber-900">
            <p className="font-medium">
              请在 {order.expiresAt.toLocaleString("zh-CN")} 前完成支付
            </p>
            <p className="mt-0.5 text-amber-700">
              库存已经为你锁定，超时未支付会自动取消并释放库存。
            </p>
          </div>
          <PayButton orderId={order.id} />
        </div>
      )}

      {/* ---------------- 已发货：引导确认收货 ---------------- */}
      {isShipped && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-violet-200 bg-violet-50 p-4">
          <Truck className="mt-0.5 size-5 shrink-0 text-violet-600" />
          <div className="flex-1 text-sm text-violet-900">
            <p className="font-medium">包裹已发出</p>
            <p className="mt-0.5 text-violet-700">
              收到货检查无误后，点右边按钮确认收货，订单就完成了。
            </p>
          </div>
          <ConfirmReceiptButton orderId={order.id} />
        </div>
      )}

      {/* ---------------- 已完成 ---------------- */}
      {order.status === ORDER_STATUS.COMPLETED && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCheck className="size-5 shrink-0 text-emerald-600" />
          <p>这笔订单已完成，感谢购买。</p>
        </div>
      )}

      {/* ---------------- 退款 ----------------
          【为什么放在这一串状态提示的最下面，而不是页面最底下】
          它和上面三个横幅是同一类东西：「这个订单现在处于什么状况，
          你能做什么」。放在一起，用户从上往下读一遍就全知道了。
          放到商品清单下面的话，退款这个「有事要办」的入口就会被
          「收货信息」「订单备注」这些静态信息淹没。
          【为什么它自己决定显不显示】不可退款且没有退款历史时
          组件返回 null，页面这里不用写条件 —— 判断散在页面里的话，
          以后加一个状态就得回头来改这一处布局代码 */}
      <RefundCard
        orderId={order.id}
        status={order.status}
        totalAmount={order.totalAmount}
        refundedAt={order.refundedAt}
        refund={refund}
        refundable={isRefundable(order.status)}
      />

      {/* ---------------- 商品清单 ---------------- */}
      {/* 只有已完成订单才把「去评价」传下去；其余状态传 undefined，
          OrderItemsCard 就退化成纯展示 —— 管理员那边的用法完全一样 */}
      <OrderItemsCard
        items={order.items}
        totalAmount={order.totalAmount}
        itemsTotal={order.itemsTotal}
        discountAmount={order.discountAmount}
        coupon={order.coupon}
        itemAction={
          order.status === ORDER_STATUS.COMPLETED ? renderReviewAction : undefined
        }
      />

      {/* ---------------- 收货信息 ---------------- */}
      <div className="mt-6 space-y-3 rounded-xl border p-4 text-sm">
        <h2 className="font-medium">收货信息</h2>

        <div className="flex gap-2 text-muted-foreground">
          <MapPin className="mt-0.5 size-4 shrink-0" />
          <span className="text-foreground">{order.address}</span>
        </div>

        <div className="flex gap-2 text-muted-foreground">
          <Phone className="mt-0.5 size-4 shrink-0" />
          <span className="text-foreground">{order.phone}</span>
        </div>
      </div>

      {/* ---------------- 订单备注 ---------------- */}
      {/* 「能不能改」在这里算一次就传下去（isNoteEditable 是纯函数，
          和 updateOrderNote 的 SQL 条件同源）。
          【为什么放在收货信息下面】它和地址、电话同属「这一单要送到哪、
          有什么交代」，放一起读起来是一件事；放最上面会喧宾夺主 */}
      <OrderNoteCard
        orderId={order.id}
        initialNote={order.note}
        editable={isNoteEditable(order.status)}
        statusLabel={order.statusLabel}
      />

      {/* ---------------- 时间轴 ---------------- */}
      <div className="mt-6">
        <OrderTimeline order={order} />
      </div>

      <div className="mt-8 flex justify-center">
        <Link href="/products" className={cn(buttonVariants({ variant: "outline" }))}>
          继续逛逛
        </Link>
      </div>
    </div>
  )
}
