"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Truck } from "lucide-react"
import { toast } from "sonner"

import { shipOrderAction } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"

// ============================================================================
// 「发货」按钮（客户端，管理员用）
//
// 【为什么发货要做成按钮 + 二次确认，而不是页面加载时自动执行】
// 状态流转是**不可逆**的（SHIPPED 之后不能回到 PAID）。这类操作必须由人
// 明确触发，而且要让操作者看懂自己点的是什么。所以按钮上写「确认发货」，
// 而不是一个含糊的「确定」。
//
// 【为什么不用 <form action> + useActionState】
// 没有表单字段要填，也不需要保留上次的错误状态 —— 失败弹个 toast 就够。
// 和支付按钮是同一套取舍（见 pay-button.tsx）。
//
// 【前端 disabled 只是体验，不是安全】
// 就算有人把 disabled 去掉疯狂点击，服务端 shipOrderAction 里：
//   1. requireAdmin() 拦住非管理员
//   2. shipOrder 的 updateMany 带 status = 'PAID' 条件
// 两道防线都在服务端，前端怎么改都没用。
// ============================================================================

export function ShipButton({ orderId }: { orderId: string }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleShip() {
    startTransition(async () => {
      const result = await shipOrderAction(orderId)

      if (!result.ok) {
        toast.error("发货失败", { description: result.error })
        // 失败原因可能是「订单已经不是待发货了」，页面上的状态已经过时，
        // 刷一下让服务端重新查
        router.refresh()
        return
      }

      toast.success("已发货", {
        description: "买家会看到订单变成「已发货」",
      })
      router.refresh()
    })
  }

  return (
    <Button onClick={handleShip} disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Truck className="size-4" />
      )}
      {pending ? "处理中…" : "确认发货"}
    </Button>
  )
}
