"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCheck, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { confirmReceiptAction } from "@/app/actions/order"
import { Button } from "@/components/ui/button"

// ============================================================================
// 「确认收货」按钮（客户端，买家自己点）
//
// 【为什么这个动作没有二次确认弹窗】
// 发货是不可逆的商家动作，所以要慎重；确认收货的「代价」只是订单进入
// 完成态，点错了没有实际损失。为一个无风险的动作弹窗会让人烦。
//
// 反过来说，如果以后要做「确认收货后 7 天不能退货」这类规则，
// 那就要加 confirm 了 —— 判断标准是「点错了有没有代价」，不是「重不重要」。
//
// 【服务端两道防线】
//   confirmReceiptAction → getCurrentUser() 从 cookie 认人
//   confirmReceipt       → updateMany 的 WHERE 里带 userId + status='SHIPPED'
// 拿别人的订单 id 来调只会 count = 0。
// ============================================================================

export function ConfirmReceiptButton({ orderId }: { orderId: string }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleConfirm() {
    startTransition(async () => {
      const result = await confirmReceiptAction(orderId)

      if (!result.ok) {
        toast.error("确认收货失败", { description: result.error })
        router.refresh()
        return
      }

      toast.success("已确认收货", { description: "感谢购买，祝穿着愉快" })
      router.refresh()
    })
  }

  return (
    <Button onClick={handleConfirm} disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <CheckCheck className="size-4" />
      )}
      {pending ? "处理中…" : "确认收货"}
    </Button>
  )
}
