import Link from "next/link"
import {
  AlertTriangle,
  ArrowRight,
  Package,
  ShoppingCart,
  Truck,
  Wallet,
} from "lucide-react"

import { SalesTrendChart } from "@/components/admin/sales-trend-chart"
import { buttonVariants } from "@/components/ui/button"
import {
  LOW_STOCK_THRESHOLD,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  type OrderStatus,
} from "@/lib/constants"
import { getAdminDashboard } from "@/lib/dashboard"
import { formatPrice } from "@/lib/format"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里，这一页不用重复写。
// 但记住：那只保护页面，不保护 Server Action。
export const dynamic = "force-dynamic"

/** 每个状态卡片点进去要带的筛选条件 */
const STAT_CARDS: { status: OrderStatus; hint: string }[] = [
  { status: ORDER_STATUS.PENDING_PAYMENT, hint: "等买家付款，超时会被自动取消" },
  { status: ORDER_STATUS.PAID, hint: "已经付款，等你发货" },
  { status: ORDER_STATUS.SHIPPED, hint: "已寄出，等买家确认收货" },
  { status: ORDER_STATUS.COMPLETED, hint: "交易完成" },
  { status: ORDER_STATUS.CANCELLED, hint: "超时或主动取消，库存已归还" },
]

export default async function AdminDashboardPage() {
  const dashboard = await getAdminDashboard()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">概览</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          全站共 {dashboard.totalOrders} 笔订单
        </p>
      </div>

      {/* ---------------- 今日经营 ----------------
          这四张卡片都会跳到一个「用同一个条件筛过的列表」。
          注意每张卡的 href 和它的数字来源必须完全对应：
            · 今日订单数 → count(createdAt ∈ 今天)      → ?range=today
            · 今日销售额 → sum(已付款金额, paidAt ∈ 今天) → ?paidToday=1
          这两个条件的口径**不一样**（一个是下单时间，一个是到账时间），
          所以链接也不一样。如果图省事让两张卡都指向 ?range=today，
          点「今日销售额」进去看到的会是另一批订单，数字对不上。
          看板最忌讳的就是「数字和明细对不上」——一旦发生，
          管理员就不再信任这一页的任何数字了。 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          href="/admin/orders?range=today"
          icon={<ShoppingCart className="size-4" />}
          label="今日订单数"
          value={String(dashboard.todayOrderCount)}
          hint={`其中 ${dashboard.todayPaidOrderCount} 笔已付款`}
        />

        <KpiCard
          href="/admin/orders?paidToday=1"
          icon={<Wallet className="size-4" />}
          label="今日销售额"
          // 数据库里存的是分，展示才转成元 —— 转换只发生在渲染这一层
          value={formatPrice(dashboard.todayRevenue)}
          hint="按到账时间统计，不含已取消"
          tone="primary"
        />

        <KpiCard
          href={`/admin/orders?status=${ORDER_STATUS.PAID}`}
          icon={<Truck className="size-4" />}
          label="待发货"
          value={String(dashboard.pendingShipmentCount)}
          hint={
            dashboard.pendingShipmentCount > 0
              ? "已经付款、等你发货"
              : "没有积压的订单"
          }
          // 有活没干完才标黄。全是 0 的时候标黄只会让人麻木
          tone={dashboard.pendingShipmentCount > 0 ? "warning" : "default"}
        />

        <KpiCard
          href="/admin/products?stock=low"
          icon={<AlertTriangle className="size-4" />}
          label="低库存规格"
          value={String(dashboard.lowStockSkuCount)}
          hint={
            dashboard.lowStockSkuCount > 0
              ? `低于 ${LOW_STOCK_THRESHOLD} 件，分布在 ${dashboard.lowStockProductCount} 款商品`
              : `没有低于 ${LOW_STOCK_THRESHOLD} 件的规格`
          }
          tone={dashboard.lowStockSkuCount > 0 ? "warning" : "default"}
        />
      </div>

      {/* ---------------- 近 7 天销售额趋势 ---------------- */}
      <div className="rounded-xl border p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">近 7 天销售额</h2>
          <span className="text-xs text-muted-foreground">
            按到账时间统计，不含已取消
          </span>
        </div>
        <div className="mt-4">
          <SalesTrendChart data={dashboard.salesTrend} />
        </div>
      </div>

      {/* ---------------- 状态卡片 ---------------- */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {STAT_CARDS.map((card) => (
          <Link
            key={card.status}
            href={`/admin/orders?status=${card.status}`}
            className="group rounded-xl border p-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
          >
            <div className="text-sm text-muted-foreground">
              {ORDER_STATUS_LABEL[card.status]}
            </div>
            <div className="mt-1 text-3xl font-bold tabular-nums">
              {dashboard.statusStats[card.status]}
            </div>
            <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {card.hint}
            </div>
          </Link>
        ))}
      </div>

      {/* ---------------- 待处理 ---------------- */}
      <div className="rounded-xl border p-5">
        <h2 className="font-semibold">待你处理</h2>

        {dashboard.pendingShipmentCount === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            没有待发货的订单。
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-blue-50 p-4">
            <p className="text-sm text-blue-900">
              有{" "}
              <span className="font-semibold">
                {dashboard.pendingShipmentCount}
              </span>{" "}
              笔订单已经付款、等你发货。
            </p>
            <Link
              href={`/admin/orders?status=${ORDER_STATUS.PAID}`}
              className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
            >
              去发货
              <ArrowRight className="size-4" />
            </Link>
          </div>
        )}
      </div>

      {/* ---------------- 商品管理入口 ---------------- */}
      <div className="rounded-xl border p-5">
        <div className="flex items-center gap-2">
          <Package className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">商品管理</h2>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          改价格、调库存、上下架都在这里。
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/admin/products"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            商品列表
            <ArrowRight className="size-4" />
          </Link>

          <Link
            href="/admin/products/new"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            新建商品
          </Link>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

/**
 * 看板上的一个指标卡片。
 *
 * 【为什么整张卡都是 <Link>】
 * 看板的用处不是「看」，是「看完之后跳过去处理」。
 * 看到一个数字却发现点不动，是最让人烦躁的交互 ——
 * 所以整张卡做成链接，而不是在卡片里塞一个「查看详情」小按钮。
 */
function KpiCard({
  href,
  icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  href: string
  icon: React.ReactNode
  label: string
  value: string
  hint: string
  tone?: "default" | "warning" | "primary"
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-xl border p-4 transition-colors hover:bg-muted/40",
        tone === "warning" && "border-amber-200 bg-amber-50/60 hover:border-amber-300",
        tone === "primary" && "border-primary/30 bg-primary/5 hover:border-primary/50",
      )}
    >
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>

      <div
        className={cn(
          "mt-1.5 text-3xl font-bold tabular-nums",
          // 金额比纯数字长得多（¥1,234.00），字号降一档才不会被挤断
          tone === "primary" && "text-2xl",
        )}
      >
        {value}
      </div>

      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {hint}
      </div>
    </Link>
  )
}
