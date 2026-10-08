import Link from "next/link"
import { ChevronLeft, ChevronRight, Package } from "lucide-react"

import { OrderStatusBadge } from "@/components/orders/order-status-badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_VALUES,
  orderStatusSchema,
  type OrderStatus,
} from "@/lib/constants"
import { formatPrice } from "@/lib/format"
import { ADMIN_PAGE_SIZE, getAdminOrderStats, getAdminOrders } from "@/lib/orders"
import { cn } from "@/lib/utils"

// 权限校验在 layout 里。这里只管展示。
export const dynamic = "force-dynamic"

export const metadata = {
  title: "订单管理 | 管理后台",
}

type AdminOrdersPageProps = {
  // Next 16：searchParams 是 Promise，必须 await
  searchParams: Promise<{
    status?: string
    page?: string
    range?: string
    paidToday?: string
  }>
}

/**
 * 当前生效的筛选条件。
 *
 * 【为什么把「解析 URL」和「拼 URL」都收在一个类型上】
 * 这一页的筛选条件从 1 个（status）变成了 3 个，而且可以组合。
 * 如果每个链接还是手写字符串，很快就会漏掉某个条件 ——
 * 典型的症状是「翻到第二页，筛选没了」。
 * 统一走 queryHref 之后，条件只有一份，改也只用改一处。
 */
type OrderFilters = {
  status?: OrderStatus
  createdToday?: boolean
  paidToday?: boolean
}

/** 把筛选条件拼成 URL。page 为 1 时不写进 query，保持链接干净 */
function queryHref(filters: OrderFilters, page = 1): string {
  const query = new URLSearchParams()
  if (filters.status) query.set("status", filters.status)
  if (filters.createdToday) query.set("range", "today")
  if (filters.paidToday) query.set("paidToday", "1")
  if (page > 1) query.set("page", String(page))

  const qs = query.toString()
  return `/admin/orders${qs ? `?${qs}` : ""}`
}

export default async function AdminOrdersPage({
  searchParams,
}: AdminOrdersPageProps) {
  const params = await searchParams

  // ---- 解析 URL 参数 ----
  // 【为什么用 zod 解析而不是直接信】
  // URL 是用户完全可控的。?status=DROP TABLE 或者 ?page=abc 都会进来。
  // safeParse 失败就当没传，而不是把脏值塞进 Prisma 的 where ——
  // 那样轻则查不到东西，重则把「非法状态」当成正常筛选条件静默通过。
  const parsedStatus = orderStatusSchema.safeParse(params.status)
  const status: OrderStatus | undefined = parsedStatus.success
    ? parsedStatus.data
    : undefined

  const parsedPage = Number.parseInt(params.page ?? "1", 10)
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1

  // 和 ?active=1 一个思路：只认约定的字面量，其余一律当成「没传」。
  // 这两个筛选对应后台首页的「今日订单数 / 今日销售额」两张卡片
  const createdToday = params.range === "today"
  const paidToday = params.paidToday === "1"

  const filters: OrderFilters = { status, createdToday, paidToday }

  const [data, stats] = await Promise.all([
    getAdminOrders({ status, page, createdToday, paidToday }),
    getAdminOrderStats(),
  ])

  const scopeLabel = createdToday ? "今天下单" : paidToday ? "今天付款" : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">订单管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {status ? ORDER_STATUS_LABEL[status] : "全部订单"}
          {scopeLabel ? ` · ${scopeLabel}` : ""}：{data.total} 笔
        </p>
      </div>

      {/* ---------------- 状态筛选 ---------------- */}
      {/*
        用 <Link> 而不是客户端组件的 <Select>：
        筛选条件放进 URL 有几个白送的好处 ——
          1. 刷新页面筛选条件还在
          2. 链接可以直接发给别人
          3. 浏览器前进/后退能正常用
          4. 不需要任何客户端 JS
        这也让这一页可以是一个纯 Server Component。
      */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterTab href={queryHref({ ...filters, status: undefined })} active={!status}>
          全部
          <span className="ml-1 text-xs opacity-70">{stats.total}</span>
        </FilterTab>

        {ORDER_STATUS_VALUES.map((s) => (
          <FilterTab
            key={s}
            href={queryHref({ ...filters, status: s })}
            active={status === s}
          >
            {ORDER_STATUS_LABEL[s]}
            <span className="ml-1 text-xs opacity-70">{stats[s]}</span>
          </FilterTab>
        ))}

        <span className="mx-1 h-5 w-px bg-border" aria-hidden />

        {/*
          两个「今天」互斥：同时点开会变成「今天下单且今天付款」，
          那是个有意义但没人会主动想的条件。
          让它俩互相踢掉对方，界面就永远不会出现一个说不清的状态。
          点「今天下单」时传 createdToday: !createdToday ——
          queryHref 只写 truthy 的条件，所以从「开」变「关」时
          这个参数会自动从 URL 里消失，不需要额外写清除逻辑。
        */}
        <FilterTab
          href={queryHref({ status, createdToday: !createdToday })}
          active={createdToday}
        >
          今天下单
        </FilterTab>

        <FilterTab
          href={queryHref({ status, paidToday: !paidToday })}
          active={paidToday}
        >
          今天付款
        </FilterTab>
      </div>

      {/* ---------------- 列表 ---------------- */}
      {data.rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
          <Package className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            没有符合条件的订单
          </p>
        </div>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>订单号</TableHead>
                <TableHead>买家</TableHead>
                <TableHead className="text-right">件数</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>下单时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {data.rows.map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-mono text-xs">
                    {order.orderNo}
                  </TableCell>

                  <TableCell>
                    <div className="text-sm">{order.buyer.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {order.buyer.email}
                    </div>
                  </TableCell>

                  <TableCell className="text-right tabular-nums">
                    {order.totalQuantity}
                  </TableCell>

                  <TableCell className="text-right font-medium tabular-nums">
                    {formatPrice(order.totalAmount)}
                  </TableCell>

                  <TableCell>
                    <OrderStatusBadge
                      status={order.status}
                      label={order.statusLabel}
                    />
                  </TableCell>

                  <TableCell className="text-xs text-muted-foreground">
                    {order.createdAt.toLocaleString("zh-CN")}
                  </TableCell>

                  <TableCell className="text-right">
                    <Link
                      href={`/admin/orders/${order.id}`}
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                      )}
                    >
                      {order.status === ORDER_STATUS.PAID ? "去发货" : "查看"}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ---------------- 分页 ---------------- */}
      {data.pageCount > 1 && (
        <Pager
          filters={filters}
          page={data.page}
          pageCount={data.pageCount}
          total={data.total}
        />
      )}

      <p className="text-xs text-muted-foreground">
        每页 {ADMIN_PAGE_SIZE} 条
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function FilterTab({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "hover:bg-muted",
      )}
    >
      {children}
    </Link>
  )
}

function Pager({
  filters,
  page,
  pageCount,
  total,
}: {
  filters: OrderFilters
  page: number
  pageCount: number
  total: number
}) {
  // 翻页时要把**全部**筛选条件一起带上，否则一翻页筛选就丢了。
  // 上一版这里只带了 status —— 那时也确实只有 status 可选。
  // 条件从 1 个涨到 3 个的时候，正是这类「手写拼接」最容易漏的地方，
  // 所以现在统一交给 queryHref
  const hrefFor = (p: number) => queryHref(filters, p)

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground">
        第 {page} / {pageCount} 页，共 {total} 笔
      </p>

      <div className="flex gap-2">
        {/* 到边界时渲染成禁用的 <span> 而不是 <Link> ——
            链接点了没用比按钮变灰更让人困惑 */}
        {page > 1 ? (
          <Link
            href={hrefFor(page - 1)}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
          >
            <ChevronLeft className="size-4" />
            上一页
          </Link>
        ) : (
          <span
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "pointer-events-none gap-1 opacity-50",
            )}
          >
            <ChevronLeft className="size-4" />
            上一页
          </span>
        )}

        {page < pageCount ? (
          <Link
            href={hrefFor(page + 1)}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
          >
            下一页
            <ChevronRight className="size-4" />
          </Link>
        ) : (
          <span
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "pointer-events-none gap-1 opacity-50",
            )}
          >
            下一页
            <ChevronRight className="size-4" />
          </span>
        )}
      </div>
    </div>
  )
}
