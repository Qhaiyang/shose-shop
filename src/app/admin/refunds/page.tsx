import Link from "next/link"
import { RotateCcw } from "lucide-react"

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
import { REFUND_STATUS, REFUND_STATUS_LABEL } from "@/lib/constants"
import { formatPrice } from "@/lib/format"
import { listRefundRequests } from "@/lib/refunds-db"
import { cn } from "@/lib/utils"

// 权限校验在 admin/layout.tsx 里。这里只管展示。
export const dynamic = "force-dynamic"

export const metadata = {
  title: "退款处理 | 管理后台",
}

// ---------------------------------------------------------------------------
// 两个 tab
//
// 【为什么是「待处理 / 已处理」而不是按状态分四个 tab】
// 管理员打开这个页面只有一个目的：**有没有事情等着我做**。
// 他关心的是「待办」和「已办完」。至于已处理的那一堆里哪些是批准的、
// 哪些是拒绝的，那是复盘时才看的东西 —— 列表里用状态徽章区分就够了，
// 不值得为它多两个 tab 把「有没有待办」这个最重要的问题挤到角落。
//
// 【和 /my-coupons 一样放在 URL 里】
// 刷新不丢、能分享、能前进后退，而且页面保持服务端渲染。
// ---------------------------------------------------------------------------

const TABS = [
  { key: "pending", label: "待处理" },
  { key: "processed", label: "已处理" },
] as const

type TabKey = (typeof TABS)[number]["key"]

type AdminRefundsPageProps = {
  // Next 16：searchParams 是 Promise，必须 await
  searchParams: Promise<{ tab?: string }>
}

export default async function AdminRefundsPage({
  searchParams,
}: AdminRefundsPageProps) {
  const params = await searchParams

  // 非法值（?tab=xxx）当成「待处理」。理由同 /my-coupons：
  // 一个纯展示参数为它抛错，只会让人以为网站坏了
  const tab: TabKey = TABS.some((t) => t.key === params.tab)
    ? (params.tab as TabKey)
    : "pending"

  const [pending, processed] = await Promise.all([
    listRefundRequests({ tab: "pending" }),
    listRefundRequests({ tab: "processed" }),
  ])

  const rows = tab === "pending" ? pending : processed

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">退款处理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          买家提交退款申请后在这里审核。批准会原路退款并回滚库存与优惠券，
          拒绝必须填写理由。
        </p>
      </div>

      {/* ---------------- tab ---------------- */}
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(({ key, label }) => {
          const count = key === "pending" ? pending.length : processed.length

          return (
            <Link
              key={key}
              href={`/admin/refunds?tab=${key}`}
              aria-current={key === tab ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition-colors",
                key === tab
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-muted",
              )}
            >
              {label}
              {count > 0 && <span className="ml-1 text-xs opacity-70">{count}</span>}
            </Link>
          )
        })}
      </div>

      {/* ---------------- 列表 ---------------- */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
          <RotateCcw className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {tab === "pending" ? "没有待处理的退款申请" : "还没有处理过的退款申请"}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>订单号</TableHead>
                <TableHead>买家</TableHead>
                <TableHead>退款原因</TableHead>
                <TableHead className="text-right">退款金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>申请时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {rows.map((refund) => (
                <TableRow key={refund.id}>
                  <TableCell className="font-mono text-xs">
                    {refund.order.orderNo}
                  </TableCell>

                  <TableCell>
                    <div className="text-sm">{refund.buyer.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {refund.buyer.email}
                    </div>
                  </TableCell>

                  <TableCell className="text-sm">
                    {refund.reasonLabel}
                  </TableCell>

                  {/* 退款金额用加粗，因为它是管理员点「批准」前最该核对的数字 */}
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatPrice(refund.refundAmount)}
                  </TableCell>

                  <TableCell>
                    <RefundStatusBadge
                      status={refund.status}
                      label={refund.statusLabel}
                    />
                  </TableCell>

                  <TableCell className="text-xs text-muted-foreground">
                    {refund.createdAt.toLocaleString("zh-CN")}
                  </TableCell>

                  <TableCell className="text-right">
                    <Link
                      href={`/admin/refunds/${refund.id}`}
                      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                    >
                      {refund.status === REFUND_STATUS.PENDING ? "去处理" : "查看"}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

/**
 * 退款状态徽章。
 *
 * 【为什么不复用 OrderStatusBadge】
 * 两者是**两套状态**：一个是「这笔交易走到哪了」，一个是「这次售后诉求
 * 批没批」。REFUNDED 这个词两边都有，但含义不同（订单已退款 / 退款申请
 * 已完成），硬塞进一个 Record 会让两边都变含糊。
 *
 * 【为什么不抽成组件文件】
 * 只有这一页和详情页会用，而且详情页那边是「状态 + 一段说明」，
 * 形状不一样。等第三个地方要用时再抽，现在抽是提前设计。
 */
function RefundStatusBadge({
  status,
  label,
}: {
  status: string
  label: string
}) {
  const variants: Record<string, string> = {
    [REFUND_STATUS.PENDING]:
      "bg-orange-100 text-orange-800 hover:bg-orange-100",
    [REFUND_STATUS.REFUNDED]:
      "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
    [REFUND_STATUS.REJECTED]: "bg-muted text-muted-foreground hover:bg-muted",
    [REFUND_STATUS.APPROVED]: "bg-blue-100 text-blue-800 hover:bg-blue-100",
  }

  return (
    <Badge className={cn("border-0", variants[status] ?? "bg-muted")}>
      {label || REFUND_STATUS_LABEL.PENDING}
    </Badge>
  )
}
