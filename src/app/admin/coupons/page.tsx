import Link from "next/link"
import { Plus, TicketPercent } from "lucide-react"

import { CouponActiveToggle } from "@/components/admin/coupon-active-toggle"
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
import { couponLabel } from "@/lib/coupons"
import { listCoupons } from "@/lib/coupons-db"
import { formatDateInput } from "@/lib/form"
import { formatPrice } from "@/lib/format"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

export const metadata = {
  title: "优惠券 | 管理后台",
}

type AdminCouponsPageProps = {
  searchParams: Promise<{ created?: string }>
}

/**
 * 后台优惠券列表。
 *
 * 【为什么列表上不显示「已过期」这个状态，只显示「停用」】
 * 因为过期是**当前时间**的函数，不是数据里的字段 —— 同一张券今天看是
 * 「进行中」，明天看就是「已过期」，而它的数据一个字节都没变。
 * 列表上真正需要人来判断的是「这张券是不是我主动停掉的」，
 * 那是 isActive 字段，是真实状态。有效期直接列出来给管理员自己看。
 */
export default async function AdminCouponsPage({
  searchParams,
}: AdminCouponsPageProps) {
  const params = await searchParams
  const coupons = await listCoupons()

  // 建完跳回来带 ?created=1，显示一句「建好了」。
  // 【为什么用 URL 参数而不是 toast】redirect 之后客户端组件已经重新挂载了，
  // 没有地方能接住「刚刚发生了什么」——URL 是唯一能跨过这次跳转的信使。
  // 和 /admin/products?created=1 是同一套做法
  const justCreated = params.created === "1"

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">优惠券</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {coupons.length} 张券 ·「已用/总量」是核销次数，被订单取消退回的会从已用里减掉
          </p>
        </div>

        <Link href="/admin/coupons/new" className={cn(buttonVariants(), "gap-1.5")}>
          <Plus className="size-4" />
          新建优惠券
        </Link>
      </div>

      {justCreated ? (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          优惠券已创建。前台的商品详情页和购物车页会立刻出现领取入口
          （前提是「启用中」且当前在有效期内）。
        </div>
      ) : null}

      {coupons.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
          <TicketPercent className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">还没有优惠券</p>
          <p className="text-xs text-muted-foreground">
            建一张「满 800 减 100」试试：买家领券后下单，实付会直接少 100 元
          </p>
        </div>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>券</TableHead>
                <TableHead>优惠</TableHead>
                <TableHead>有效期</TableHead>
                <TableHead className="text-right">已用/总量</TableHead>
                <TableHead className="text-right">每人限领</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {coupons.map((coupon) => {
                const now = new Date()
                const expired = now > coupon.endAt
                const notStarted = now < coupon.startAt
                const soldOut = coupon.remaining === 0

                return (
                  <TableRow key={coupon.id}>
                    <TableCell>
                      <div className="font-mono text-sm font-medium">
                        {coupon.code}
                      </div>
                      {/* 券码是给机器看的，这句话是给人看的新闻标题 */}
                      <div className="text-xs text-muted-foreground">
                        {couponLabel(coupon)}
                      </div>
                    </TableCell>

                    <TableCell className="text-sm">
                      {coupon.type === "PERCENT" ? (
                        <span>
                          减 {coupon.value}%
                          <span className="text-muted-foreground">
                            {" "}
                            · 最多 {formatPrice(coupon.maxDiscount ?? 0)}
                          </span>
                        </span>
                      ) : (
                        <span>减 {formatPrice(coupon.value)}</span>
                      )}
                      {coupon.minSpend > 0 ? (
                        <div className="text-xs text-muted-foreground">
                          满 {formatPrice(coupon.minSpend)} 可用
                        </div>
                      ) : null}
                    </TableCell>

                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateInput(coupon.startAt)} ~ {formatDateInput(coupon.endAt)}
                    </TableCell>

                    <TableCell className="text-right tabular-nums">
                      {coupon.usedCount}/{coupon.totalLimit}
                      {soldOut ? (
                        <div className="text-xs text-amber-600">已发完</div>
                      ) : null}
                    </TableCell>

                    <TableCell className="text-right tabular-nums">
                      {coupon.perUserLimit}
                    </TableCell>

                    <TableCell>
                      {/* 状态可能同时成立好几条（停用 + 已过期），
                          所以是「全部列出来」而不是 if/else 挑一个 ——
                          停用和过期是两件不同的事，只显示一条会误导管理员 */}
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={coupon.isActive ? "default" : "secondary"}>
                          {coupon.isActive ? "启用中" : "已停用"}
                        </Badge>
                        {expired ? <Badge variant="outline">已过期</Badge> : null}
                        {notStarted ? <Badge variant="outline">未开始</Badge> : null}
                      </div>
                    </TableCell>

                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/admin/coupons/${coupon.id}`}
                          className={cn(
                            buttonVariants({ variant: "ghost", size: "sm" }),
                          )}
                        >
                          编辑
                        </Link>
                        <CouponActiveToggle
                          couponId={coupon.id}
                          isActive={coupon.isActive}
                          code={coupon.code}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
