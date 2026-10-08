"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, Loader2, X } from "lucide-react"
import { toast } from "sonner"

import { approveRefundAction, rejectRefundAction } from "@/app/actions/refund"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { REFUND_ADMIN_NOTE_MAX_LENGTH } from "@/lib/constants"
import { formatPrice } from "@/lib/format"

// ============================================================================
// 退款的「批准 / 拒绝」（客户端，管理员用）
//
// 【为什么这两个按钮在一个组件里，而不是各写一个】
// 它们共用同一块 UI：一排按钮，点拒绝时展开一个理由输入框。
// 拆成两个组件的话，那个输入框的位置、拒绝完要不要收起、
// 按钮之间的互斥（正在提交时两个都要禁用）都得在两处各写一遍。
//
// 【为什么批准不需要二次确认，拒绝却要填理由】
// 判断标准是「点错了有没有代价」：
//   - 批准点错了，订单已经退款、库存和券都回滚了，**不可逆** ——
//     但真正的防线不是弹窗（弹窗只会被无脑点掉），而是状态机：
//     订单已经是 REFUNDED 了，再点一次会直接失败。
//   - 拒绝点错了可以再改（用户重新申请就行），真正的问题是
//     **买家不知道凭什么**，所以理由才是必须的，确认框反而是多余的。
//
// 【服务端两道防线】
//   approveRefundAction / rejectRefundAction → requireAdmin()
//   approveRefund / rejectRefund → 条件更新 WHERE status='PENDING'
// 两个管理员同时点，只有一个能成功；另一个拿到「已经被处理过了」。
// ============================================================================

type RefundReviewProps = {
  refundId: string
  /** 退款金额（分）。批准前要让人看清要退多少钱 */
  refundAmount: number
}

export function RefundReview({ refundId, refundAmount }: RefundReviewProps) {
  const [rejecting, setRejecting] = useState(false)
  // 拒绝理由的草稿。**必须有**，不能靠 DOM 里的值 ——
  // 理由校验失败（空着提交）时，管理员刚打的字必须还在。
  // 这个「草稿 + 提交」的写法照抄 OrderNoteCard，理由见那里的注释
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function approve() {
    startTransition(async () => {
      const result = await approveRefundAction(refundId)

      if (!result.ok) {
        // 最常见的失败是「另一个管理员刚好也点了」—— 这不是 bug，
        // 是状态真的变了。显示服务端的话，刷新让页面回到真实状态
        toast.error("批准失败", { description: result.error })
        router.refresh()
        return
      }

      toast.success("已批准退款", {
        description: `${formatPrice(result.refundAmount)} 已退回买家，库存和优惠券已回滚`,
      })
      setRejecting(false)
      router.refresh()
    })
  }

  function reject() {
    // 手工拼 FormData，而不是让 <form> 自己提交。
    // 【为什么不用 <form action={客户端函数}>】那样写更短，但 React 在
    // action 跑完会重置表单 —— 校验失败时管理员刚打的理由就没了，
    // 得重新打一遍。自己管草稿虽然多几行，但行为是确定的
    const formData = new FormData()
    formData.set("adminNote", note)

    startTransition(async () => {
      const result = await rejectRefundAction(refundId, formData)

      if (!result.ok) {
        // 校验失败（没填理由）停在这里，让管理员补上再提交。
        // 草稿在 state 里，一个字都不会丢
        setError(result.error)
        return
      }

      toast.success("已拒绝退款", {
        description: "买家能看到你填的理由，订单已退回原状态",
      })
      setRejecting(false)
      setNote("")
      setError(null)
      router.refresh()
    })
  }

  if (!rejecting) {
    return (
      <div className="mt-6 rounded-xl border border-orange-200 bg-orange-50 p-4">
        <p className="text-sm font-medium text-orange-900">
          这笔退款申请等待处理，涉及金额 {formatPrice(refundAmount)}
        </p>
        <p className="mt-0.5 text-sm text-orange-700">
          批准后订单变为「已退款」，库存和优惠券会一并回滚 ——
          这个操作不可撤销。拒绝则把订单放回买家申请前的状态，他可以再次申请。
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Button onClick={approve} disabled={pending} className="gap-1.5">
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {pending ? "处理中…" : "批准退款"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setError(null)
              setRejecting(true)
            }}
            disabled={pending}
            className="gap-1.5"
          >
            <X className="size-4" />
            拒绝
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6 space-y-3 rounded-xl border p-4">
      <div className="space-y-1.5">
        <Label htmlFor="admin-note">
          拒绝理由
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            （会显示给买家，必须填）
          </span>
        </Label>
        <Textarea
          id="admin-note"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={REFUND_ADMIN_NOTE_MAX_LENGTH}
          placeholder="例如：鞋子已穿着超过 7 天，不符合无理由退货条件"
          aria-invalid={!!error}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={reject}
          disabled={pending}
          className="gap-1.5"
        >
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {pending ? "提交中…" : "确认拒绝"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setRejecting(false)
            setError(null)
          }}
          disabled={pending}
        >
          取消
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
