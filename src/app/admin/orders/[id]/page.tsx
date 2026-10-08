import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Mail, MapPin, Phone, StickyNote, User } from "lucide-react"

import { ShipButton } from "@/components/admin/ship-button"
import { OrderItemsCard } from "@/components/orders/order-items-card"
import { OrderStatusBadge } from "@/components/orders/order-status-badge"
import { OrderTimeline } from "@/components/orders/order-timeline"
import { buttonVariants } from "@/components/ui/button"
import { ORDER_STATUS } from "@/lib/constants"
import { getOrderDetailForAdmin } from "@/lib/orders"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

type AdminOrderDetailPageProps = {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: AdminOrderDetailPageProps) {
  const { id } = await params
  return { title: `订单 ${id.slice(-8)} | 管理后台` }
}

export default async function AdminOrderDetailPage({
  params,
}: AdminOrderDetailPageProps) {
  const { id } = await params

  // 管理员视角：不带 userId，能看全站订单。
  // 这个查询之所以敢这么宽，是因为进到这一页之前，layout 已经确认过
  // 当前用户是管理员了。（但 Server Action 没有这层保护，见 actions/admin.ts）
  const order = await getOrderDetailForAdmin(id)
  if (!order) notFound()

  const canShip = order.status === ORDER_STATUS.PAID

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href="/admin/orders"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 gap-1")}
      >
        <ArrowLeft className="size-4" />
        返回订单列表
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">订单详情</h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {order.orderNo}
          </p>
        </div>

        <OrderStatusBadge status={order.status} label={order.statusLabel} />
      </div>

      {/* ---------------- 发货操作区 ---------------- */}
      {canShip && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex-1 text-sm text-blue-900">
            <p className="font-medium">这笔订单已付款，等待发货</p>
            <p className="mt-0.5 text-blue-700">
              点「确认发货」后订单会变成「已发货」，买家那边能看到并确认收货。
              库存不会因为发货而变化 —— 库存在下单那一刻就扣过了。
            </p>
          </div>
          <ShipButton orderId={order.id} />
        </div>
      )}

      {/* ---------------- 买家信息 ---------------- */}
      {/* 管理员要联系买家，所以这块在后台是必须的，而在买家自己的页面上没有 */}
      <div className="mb-6 space-y-3 rounded-xl border p-4 text-sm">
        <h2 className="font-medium">买家</h2>

        <div className="flex gap-2 text-muted-foreground">
          <User className="mt-0.5 size-4 shrink-0" />
          <span className="text-foreground">{order.buyer.name}</span>
        </div>

        <div className="flex gap-2 text-muted-foreground">
          <Mail className="mt-0.5 size-4 shrink-0" />
          <span className="text-foreground">{order.buyer.email}</span>
        </div>
      </div>

      {/* ---------------- 收货信息 ---------------- */}
      <div className="mb-6 space-y-3 rounded-xl border p-4 text-sm">
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

      {/* ---------------- 买家备注 ---------------- */}
      {/* 【后台是只读的，而且空备注也要显示一行】
          买家写「不要放快递柜」就是写给打包的人看的，打包的人正是看着
          这一页干活 —— 所以这块在后台不是「顺带展示」，它是备注真正的
          读者。空的时候也保留标题和「未填写」，管理员才分得清
          「买家没写」和「这一页漏做了」 */}
      <div className="mb-6 space-y-2 rounded-xl border p-4 text-sm">
        <h2 className="flex items-center gap-1.5 font-medium">
          <StickyNote className="size-4 text-muted-foreground" />
          买家备注
        </h2>

        {order.note ? (
          // whitespace-pre-wrap：换行是买家有意敲的
          <p className="whitespace-pre-wrap text-foreground">{order.note}</p>
        ) : (
          <p className="text-muted-foreground">未填写</p>
        )}
      </div>

      {/* ---------------- 商品清单 ---------------- */}
      {/* 管理员看的是同一张清单，所以「原价 / 优惠 / 实付」三行和券码
          也自动跟着出现 —— 对账时要知道这单核销的是哪张券 */}
      <OrderItemsCard
        items={order.items}
        totalAmount={order.totalAmount}
        itemsTotal={order.itemsTotal}
        discountAmount={order.discountAmount}
        coupon={order.coupon}
      />

      {/* ---------------- 时间轴 ---------------- */}
      <div className="mt-6">
        <OrderTimeline order={order} />
      </div>
    </div>
  )
}
