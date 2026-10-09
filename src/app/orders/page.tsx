import Link from "next/link"
import { redirect } from "next/navigation"
import { Package } from "lucide-react"

import { OrderStatusBadge } from "@/components/orders/order-status-badge"
import { buttonVariants } from "@/components/ui/button"
import { getCurrentUser } from "@/lib/auth"
import { ORDER_STATUS } from "@/lib/constants"
import { formatPrice } from "@/lib/format"
import { cancelExpiredOrders, getOrdersByUser } from "@/lib/orders"
import { cn } from "@/lib/utils"

// 要读 cookie 判断是谁，所以必须是动态页面 ——
// 否则 Next 会试图在构建时把它预渲染成一个静态 HTML，
// 结果就是所有用户看到同一份订单列表（或者干脆是空的）
export const dynamic = "force-dynamic"

export const metadata = {
  title: "我的订单 | 鞋店",
}

export default async function OrdersPage() {
  const user = await getCurrentUser()

  // 未登录不让看，并记住他想去哪，登录后自动跳回来
  if (!user) redirect("/login?next=/orders")

  // 【第 8 步的兜底】渲染前先把这个用户自己的超时订单扫一遍。
  //
  // 正路子是外部定时任务打 /api/cron/expire-orders，但用户电脑上不一定
  // 配了 cron。没有这一句的话，过期订单会一直显示「待支付」，
  // 看起来像功能坏了。
  //
  // 只扫当前用户（走 userId 索引，量很小），不在这里做全表扫描 ——
  // 那是定时任务该干的事，不该让每次页面访问都背上全表的开销。
  await cancelExpiredOrders({ userId: user.id })

  // 【关键】userId 是服务端从 cookie 里解出来的，不是页面参数。
  // 这个查询是不可能查出别人订单的 —— 越权在数据层就被挡死了，
  // 不依赖任何页面上的 if 判断
  const orders = await getOrdersByUser(user.id)

  if (orders.length === 0) {
    return <EmptyOrders />
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">我的订单</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {orders.length} 笔订单
        </p>
      </div>

      <ul className="space-y-4">
        {orders.map((order) => {
          const isPending = order.status === ORDER_STATUS.PENDING_PAYMENT

          return (
            <li key={order.id}>
              <Link
                href={`/orders/${order.id}`}
                className="block rounded-xl border transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                {/* 头部：单号 + 状态 */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-mono text-muted-foreground">
                      {order.orderNo}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {order.createdAt.toLocaleString("zh-CN")}
                    </span>
                  </div>

                  <OrderStatusBadge
                    status={order.status}
                    label={order.statusLabel}
                  />
                </div>

                {/* 主体：缩略图 + 概要 + 金额 */}
                <div className="flex items-center gap-4 p-4">
                  <div className="size-16 shrink-0 overflow-hidden rounded-lg border bg-muted">
                    {order.coverImage ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 本地图片，见 product-card.tsx 的说明
                      <img
                        src={order.coverImage}
                        alt=""
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center">
                        <Package className="size-5 text-muted-foreground" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      共 {order.itemKindCount} 种商品 · {order.totalQuantity} 件
                    </p>
                    {isPending && (
                      <p className="mt-1 text-xs text-amber-600">
                        待支付，请在{" "}
                        {order.expiresAt.toLocaleString("zh-CN")} 前完成支付
                      </p>
                    )}
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="text-xs text-muted-foreground">实付</div>
                    <div className="text-lg font-bold text-primary tabular-nums">
                      {formatPrice(order.totalAmount)}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function EmptyOrders() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-16 py-20">
        <Package className="size-10 text-muted-foreground" />
        <div className="space-y-1">
          <p className="font-medium">还没有订单</p>
          <p className="text-sm text-muted-foreground">
            挑一双喜欢的鞋，下单后会显示在这里
          </p>
        </div>
        <Link href="/products" className={cn(buttonVariants(), "mt-2")}>
          去逛逛
        </Link>
      </div>
    </div>
  )
}
