import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Info } from "lucide-react"

import { updateCouponAction } from "@/app/actions/admin"
import { CouponActiveToggle } from "@/components/admin/coupon-active-toggle"
import { CouponForm } from "@/components/admin/coupon-form"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { COUPON_TYPE } from "@/lib/constants"
import { couponLabel } from "@/lib/coupons"
import { getCouponById } from "@/lib/coupons-db"
import { formatDateInput } from "@/lib/form"
import { formatPrice, formatYuan } from "@/lib/format"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

type AdminCouponDetailPageProps = {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: AdminCouponDetailPageProps) {
  const { id } = await params
  const coupon = await getCouponById(id)
  return {
    title: coupon ? `${coupon.code} | 优惠券 | 管理后台` : "优惠券 | 管理后台",
  }
}

/**
 * 编辑优惠券。
 *
 * 【日期字段为什么要 formatDateInput 转成 "YYYY-MM-DD" 再回填】
 * <input type="date"> 只认这个格式。直接把 Date 塞给 defaultValue 的话，
 * 浏览器会渲染成空 —— 管理员打开编辑页看到两个空日期框，以为券没有有效期。
 * 转换函数在 src/lib/form.ts，和 parseDateInput 是一对。
 *
 * 【为什么编辑页要显示「已用/总量」而不是只给个输入框】
 * 发放总量可以改，但**不能改成小于已用掉的数**（那是逻辑上不可能的状态，
 * updateCoupon 会拒绝）。管理员得先看到已用多少，才知道自己能往下调到哪。
 */
export default async function AdminCouponDetailPage({
  params,
}: AdminCouponDetailPageProps) {
  const { id } = await params
  const coupon = await getCouponById(id)
  if (!coupon) notFound()

  const now = new Date()
  const expired = now > coupon.endAt
  const remaining = Math.max(0, coupon.totalLimit - coupon.usedCount)

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Link
        href="/admin/coupons"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 gap-1")}
      >
        <ArrowLeft className="size-4" />
        返回优惠券列表
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-bold tracking-tight">
              {coupon.code}
            </h1>
            <Badge variant={coupon.isActive ? "default" : "secondary"}>
              {coupon.isActive ? "启用中" : "已停用"}
            </Badge>
            {expired ? <Badge variant="outline">已过期</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {couponLabel(coupon)} · 已用 {coupon.usedCount}/{coupon.totalLimit}
            （还剩 {remaining} 张）
            {coupon.type === COUPON_TYPE.PERCENT
              ? ` · 最多减 ${formatPrice(coupon.maxDiscount ?? 0)}`
              : ""}
          </p>
        </div>

        <CouponActiveToggle
          couponId={coupon.id}
          isActive={coupon.isActive}
          code={coupon.code}
        />
      </div>

      {/*
        【为什么要在编辑页顶上写这段话】
        券是「还没发生的事」的规则，改了不影响已经用掉的历史订单 ——
        但**发放总量**是个例外（不能改得比已用的还小）。
        把这两件事说清楚，管理员才敢改，也才知道哪些改不动。
      */}
      <div className="mb-6 flex items-start gap-3 rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          改动只影响还没用这张券的买家。已经用它下过单的订单里，
          优惠金额是下单那一刻冻结的，不会跟着变。
          发放总量不能改得比已用次数（{coupon.usedCount}）更小。
        </p>
      </div>

      <div className="rounded-xl border p-5">
        <CouponForm
          action={updateCouponAction}
          couponId={coupon.id}
          submitLabel="保存修改"
          defaultValues={{
            code: coupon.code,
            type: coupon.type,
            // 【回填时要把「分」还原成「元」】不然管理员打开编辑页会看到
            // 「减免金额 10000」—— 他要么以为系统坏了，要么直接保存，
            // 把这张券从减 100 元改成减 10000 元。
            //
            // 转换用 formatYuan（分 → 元的文本），而不是自己写 value / 100：
            // 后者会把 1250 分显示成 "12.5"、把 100 分显示成 "1"，
            // 虽然也能被 parseYuanToCents 认回来，但和别的价格显示不一致。
            // 折扣券的 value 是百分比（不是钱），原样 String 出来
            value:
              coupon.type === COUPON_TYPE.PERCENT
                ? String(coupon.value)
                : formatYuan(coupon.value),
            minSpend: formatYuan(coupon.minSpend),
            maxDiscount:
              coupon.maxDiscount === null ? "" : formatYuan(coupon.maxDiscount),
            startAt: formatDateInput(coupon.startAt),
            endAt: formatDateInput(coupon.endAt),
            totalLimit: String(coupon.totalLimit),
            perUserLimit: String(coupon.perUserLimit),
            isActive: coupon.isActive,
          }}
        />
      </div>
    </div>
  )
}
