"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, BadgeCheck, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { requestRefundAction } from "@/app/actions/refund"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  ORDER_STATUS,
  REFUND_DESCRIPTION_MAX_LENGTH,
  REFUND_REASON,
  REFUND_REASON_LABEL,
  REFUND_REASON_VALUES,
  REFUND_STATUS,
  type OrderStatus,
} from "@/lib/constants"
import { formatPrice } from "@/lib/format"
import type { RefundView } from "@/lib/refunds"

// ============================================================================
// 退款卡片（买家视角）
//
// 【三种形态，由订单状态和最近一次申请一起决定】
//   REFUNDING            → 「退款处理中」+ 预计退款金额
//   REFUNDED             → 「已退款 ¥X」+ 退款时间
//   可退款 + 上次被拒     → 显示拒绝理由，并且**还能再申请**
//   可退款 + 没有待处理   → 一个「申请退款」按钮
//
// 【为什么「能不能申请」由外面传进来，而不是这里判断状态】
// 和 OrderNoteCard 的 editable 是同一个理由：「哪个状态能退」是业务规则，
// 定义在 lib/constants.ts 的 isRefundable。服务端算一次传下来，
// 客户端再算一遍就等于规则有了两个副本 —— 而这种分叉的表现是
// 「按钮出现了但点了报错」，最难查的一类。
//
// 【为什么这次必须 router.refresh()，备注卡片却不用】
// 备注改完，页面别的地方都不变，所以本地 state 就够了。
// 退款不一样：提交成功后订单状态从「已支付」变成「退款处理中」，
// 页头的徽章、时间轴、这个卡片自己、甚至连「确认收货」按钮都该消失。
// 这些全是服务端渲染出来的，本地改不了，只能让服务端重画一遍。
// ============================================================================

type RefundCardProps = {
  orderId: string
  status: OrderStatus
  /** 实付金额（分）。退款退的就是它 —— 页面上要写清楚，避免用户以为退原价 */
  totalAmount: number
  refundedAt: Date | null
  /** 这一单最近一次退款申请，没申请过就是 null */
  refund: RefundView | null
  /** 服务端算好的 isRefundable(status) */
  refundable: boolean
}

export function RefundCard({
  orderId,
  status,
  totalAmount,
  refundedAt,
  refund,
  refundable,
}: RefundCardProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)

  function submit() {
    const form = formRef.current
    if (!form) return

    // 【为什么用 new FormData(form) 而不是 useState 存每个字段】
    // 表单里只有两个字段，而且提交后整页都会重新渲染（这个组件会被
    // 服务端的新数据替换掉），没有「保留用户输入」的需求。
    // 交给浏览器收集，少两处 state，也少两处可能出现的不一致。
    const formData = new FormData(form)

    startTransition(async () => {
      const result = await requestRefundAction(orderId, formData)

      if (!result.ok) {
        // 最常见的失败是「打开表单时还能退，点提交时状态已经变了」
        // （比如管理员刚好发了货又…）。这不是 bug，原样显示服务端的话，
        // 然后刷一下让页面回到真实状态
        setError(result.error)
        router.refresh()
        return
      }

      toast.success("退款申请已提交", {
        description: `预计退款 ${formatPrice(result.refundAmount)}，管理员审核后会通知你`,
      })
      setOpen(false)
      setError(null)
      // 状态徽章、时间轴、按钮都得跟着变，只能让服务端重画
      router.refresh()
    })
  }

  // ---------------- 处理中 ----------------
  if (status === ORDER_STATUS.REFUNDING) {
    return (
      <Shell tone="amber" icon={<Loader2 className="size-5 animate-spin" />}>
        <p className="font-medium">退款处理中</p>
        <p className="mt-0.5">
          预计退款 {formatPrice(refund?.refundAmount ?? totalAmount)}
          {refund ? `，原因：${refund.reasonLabel}` : null}
        </p>
        <p className="mt-0.5 text-xs opacity-80">
          管理员审核通过后，款项会原路退回。这段时间订单不能发货或确认收货。
        </p>
      </Shell>
    )
  }

  // ---------------- 已退款 ----------------
  if (status === ORDER_STATUS.REFUNDED) {
    return (
      <Shell tone="rose" icon={<BadgeCheck className="size-5" />}>
        <p className="font-medium">
          已退款 {formatPrice(refund?.refundAmount ?? totalAmount)}
        </p>
        {refundedAt && (
          <p className="mt-0.5 text-xs opacity-80">
            退款时间：{refundedAt.toLocaleString("zh-CN")}
          </p>
        )}
        <p className="mt-0.5 text-xs opacity-80">
          这笔订单已经结束，商品和优惠券都已退回。感谢购买。
        </p>
      </Shell>
    )
  }

  // ---------------- 不可申请，也没什么可说的 ----------------
  if (!refundable) return null

  const rejected = refund?.status === REFUND_STATUS.REJECTED ? refund : null

  return (
    <div className="mt-6 space-y-3 rounded-xl border p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 font-medium">
            <RotateCcw className="size-4 text-muted-foreground" />
            退款
          </h2>
          <p className="mt-1 text-muted-foreground">
            退款金额为实付金额 {formatPrice(totalAmount)}
            （使用了优惠券的话，优惠部分不退）。
          </p>
        </div>

        {!open && (
          <Button
            type="button"
            variant={rejected ? "outline" : "default"}
            size="sm"
            onClick={() => {
              setError(null)
              setOpen(true)
            }}
            className="shrink-0"
          >
            {rejected ? "再次申请" : "申请退款"}
          </Button>
        )}
      </div>

      {/* 上一次被拒的说明。**必须显示理由** —— 用户看到「已拒绝」却不知道
          凭什么，下一步只会来投诉。管理员填的理由在这里原样展示 */}
      {rejected && !open && (
        <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-muted-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p>
              上次申请（{rejected.reasonLabel}）未通过
              {rejected.adminNote ? `：${rejected.adminNote}` : null}
            </p>
            <p className="mt-0.5 text-xs">
              如果情况有变化，可以补充说明后重新提交。
            </p>
          </div>
        </div>
      )}

      {open && (
        <form ref={formRef} className="space-y-3 border-t pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="refund-reason">退款原因</Label>
            {/*
              原生 <select>，不用 components/ui/select，理由见 coupon-form.tsx：
              它老老实实进 FormData，键盘和手机上的原生选择器全都白拿。
              这里比那边更需要这个性质 —— 这个表单是直接 new FormData(form) 提交的
            */}
            <select
              id="refund-reason"
              name="reason"
              defaultValue={REFUND_REASON.REGRET}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
            >
              {REFUND_REASON_VALUES.map((reason) => (
                <option key={reason} value={reason}>
                  {REFUND_REASON_LABEL[reason]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="refund-description">
              补充说明
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                （选填，选「其他」时建议写清楚）
              </span>
            </Label>
            <Textarea
              id="refund-description"
              name="description"
              rows={2}
              maxLength={REFUND_DESCRIPTION_MAX_LENGTH}
              placeholder="例如：42 码偏大，想换 41 码"
              aria-invalid={!!error}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={pending}
              className="gap-1.5"
            >
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {pending ? "提交中…" : "提交申请"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false)
                setError(null)
              }}
              disabled={pending}
            >
              取消
            </Button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>
      )}
    </div>
  )
}

/**
 * 处理中 / 已退款这两态共用的外壳。
 *
 * 【为什么颜色由调用方传一个「调子」而不是两个类名字符串】
 * 传类名的话，调用方就得知道 Tailwind 的那一长串（border-amber-200
 * bg-amber-50 text-amber-900…），两组颜色散在文件里。传 tone
 * 让「哪些颜色是一套」收敛到下面这一张表里 —— 和 OrderStatusBadge
 * 的 STATUS_VARIANT 是同一个套路。
 */
function Shell({
  tone,
  icon,
  children,
}: {
  tone: "amber" | "rose"
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
  } as const

  return (
    <div
      className={`mt-6 flex items-start gap-3 rounded-xl border p-4 text-sm ${tones[tone]}`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}
