"use client"

import { useState } from "react"
import Link from "next/link"
import { TicketPercent } from "lucide-react"

import { CHECKOUT_FORM_ID } from "@/components/checkout/checkout-form"
import { Separator } from "@/components/ui/separator"
import { couponFaceValue, couponLabel, couponThresholdText } from "@/lib/coupons"
import type { UsableCoupon } from "@/lib/coupons-db"
import { formatDateInput } from "@/lib/form"
import { formatPrice } from "@/lib/format"
import { cn } from "@/lib/utils"

// ============================================================================
// 结算页：选券 + 金额汇总（客户端）
//
// 【为什么「选券」和「金额」在同一个组件里】
// 只有它们两个会随选择变化。如果拆成两个客户端组件，就得为
// 「选了哪张券」引入 Context 或者把整页塞进一个大客户端组件 ——
// 为了一处联动付这个代价不值。所以这一小块自己关起门来算。
//
// 【单选按钮为什么不在 <form> 里面】
// 这个组件渲染在右边那一栏，而表单在左边那一栏。靠 HTML 原生的
// form 属性把两边接起来（见 checkout-form.tsx 上 CHECKOUT_FORM_ID 的注释）。
// 浏览器负责收集，我们不用手写任何 JS 去同步。
//
// 【金额一律从服务端算好传进来】
// 每个选项能减多少（discountCents）是服务端用 coupons.ts 里那个纯函数
// 算好一起给的。这里只是「把选中的那一项的数字显示出来」，
// 不在浏览器里重算一遍 —— 免得将来两边算法走岔。
// 真正下单时服务端还会再算第三次（那一次才算数）。
// ============================================================================

type CheckoutCouponProps = {
  /** 这笔订单能用的券（服务端已按门槛/有效期/是否用过筛过，并算好了各自减多少） */
  coupons: UsableCoupon[]
  /** 商品原价合计（分），不含优惠 */
  itemsTotal: number
}

export function CheckoutCoupon({ coupons, itemsTotal }: CheckoutCouponProps) {
  // 默认不选券。和现实一致：券要用户自己决定用不用，
  // 默认帮他选一张是替他做决定（万一他想把券留到下一单更大的订单呢）
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = coupons.find((item) => item.userCouponId === selectedId) ?? null
  const discount = selected?.discountCents ?? 0
  const payable = itemsTotal - discount

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <TicketPercent className="size-4" />
          优惠券
        </h3>

        {coupons.length === 0 ? (
          // 【为什么要解释「为什么没有券」】
          // 用户兜里明明有券，这里却是空的，他只会觉得系统丢了东西。
          // 口令是金额门槛：券不是没有，是这单还不够格用
          <div className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
            这笔订单暂时没有可用的券
            <Link
              href="/my-coupons"
              className="ml-1 underline underline-offset-4 hover:text-foreground"
            >
              看看我的券
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {/* 「不使用」也是一个选项，而不是「点一下取消选中」——
                单选按钮组必须有默认项，否则用户没法反悔 */}
            <Option
              selected={selectedId === null}
              onSelect={() => setSelectedId(null)}
              title="不使用优惠券"
            />

            {coupons.map((item) => (
              <Option
                key={item.userCouponId}
                selected={selectedId === item.userCouponId}
                onSelect={() => setSelectedId(item.userCouponId)}
                title={couponLabel(item.coupon)}
                // 单选按钮的 value 就是这个券实例的 id，提交时进 FormData
                // 的名字是 userCouponId —— 和 createOrderAction 里读的那个对上
                //
                // 【value 用的是 userCouponId 而不是 couponId】
                // 服务端按 (id, userId) 查这张券是不是本人的（getOwnedCoupon），
                // 越权就被 WHERE 挡在门外，不需要在业务逻辑里再判一次
                value={item.userCouponId}
                right={
                  <span className="text-xs font-medium text-primary">
                    省 {formatPrice(item.discountCents)}
                  </span>
                }
                detail={`${couponFaceValue(item.coupon)} · ${couponThresholdText(item.coupon)} · ${formatDateInput(item.coupon.endAt)} 前有效`}
              />
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* ---------------- 金额 ---------------- */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">商品总额</span>
          <span className="tabular-nums">{formatPrice(itemsTotal)}</span>
        </div>

        {/* 【优惠为 0 时整行不显示】「优惠 -¥0.00」看着像没生效。
            没用券的时候，这一行本来就不该存在 */}
        {discount > 0 ? (
          <div className="flex justify-between text-primary">
            <span>优惠</span>
            <span className="tabular-nums">-{formatPrice(discount)}</span>
          </div>
        ) : null}

        <div className="flex items-baseline justify-between pt-1">
          <span className="font-medium">实付</span>
          <span className="text-2xl font-bold text-primary tabular-nums">
            {formatPrice(payable)}
          </span>
        </div>

        {selected ? (
          <p className="text-right text-xs text-muted-foreground">
            已选 <span className="font-mono">{selected.coupon.code}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 一个券选项。
 *
 * 【为什么把整个标签包在 <label> 里】
 * 点哪儿都能选中（圆点、文字、空白处），这是原生 radio + label 的默认行为。
 * 自己写 div + onClick 的话，键盘用户按空格选不上、屏幕阅读器也读不出
 * 「这是一个选项」—— 白扔了浏览器给的东西。
 */
function Option({
  selected,
  onSelect,
  title,
  value = "",
  detail,
  right,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  /** 券实例 id。不使用优惠券时是空串 */
  value?: string
  detail?: string
  right?: React.ReactNode
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
      )}
    >
      <input
        type="radio"
        name="userCouponId"
        value={value}
        // 关键的一句：把身体在表单外的控件挂到那张表单上
        form={CHECKOUT_FORM_ID}
        checked={selected}
        onChange={onSelect}
        className="size-4 shrink-0 accent-primary"
      />

      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {detail ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>

      {right}
    </label>
  )
}
