import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createCouponAction } from "@/app/actions/admin"
import { CouponForm } from "@/components/admin/coupon-form"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

export const metadata = {
  title: "新建优惠券 | 管理后台",
}

/**
 * 新建优惠券。
 *
 * 【为什么不像新建商品那样先填一半再跳去配规格】
 * 商品必须再配 SKU 才能卖，「分两步」是被业务逼出来的；
 * 券一张表就填完了，一次填完直接回列表最省事。
 */
export default function NewCouponPage() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <Link
        href="/admin/coupons"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 gap-1")}
      >
        <ArrowLeft className="size-4" />
        返回优惠券列表
      </Link>

      <h1 className="text-2xl font-bold tracking-tight">新建优惠券</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        两种券：满减券填「减多少钱」，折扣券填「减百分之几」。
        金额一律按「元」填，服务端会转成「分」存起来 —— 全站的钱都是整数分。
      </p>

      <div className="rounded-xl border p-5">
        <CouponForm action={createCouponAction} submitLabel="创建优惠券" />
      </div>
    </div>
  )
}
