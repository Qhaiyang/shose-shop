"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { CreditCard, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { payOrderAction } from "@/app/actions/order"
import { Button } from "@/components/ui/button"

// ============================================================================
// 「去支付」按钮（客户端）
//
// 【为什么用 useTransition 而不是 useState 的 loading 标志】
// 调用 Server Action 会触发服务端重新渲染（router.refresh），
// 这属于「一次过渡」，useTransition 天生就是干这个的：
// 它会一直保持 isPending = true 直到刷新后的新 UI 渲染完成，
// 而手动 setLoading(false) 通常在响应回来那一刻就关了，
// 用户会看到「按钮不转了但页面还是旧的」这个中间态。
//
// 【为什么点一次就够，不怕用户连点】
// 按钮在 isPending 期间是 disabled 的，挡住了大部分重复点击。
// 但真正兜底的是服务端 payOrder 里那条带 status = 'PENDING_PAYMENT'
// 的 UPDATE —— 就算请求真的重复发出了（网络重试、用户开了两个标签页），
// 也只有第一次能匹配上，第二次 count = 0 会被拒掉。
// 前端禁用是体验，服务端条件更新才是安全性。
// ============================================================================

export function PayButton({ orderId }: { orderId: string }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handlePay() {
    startTransition(async () => {
      const result = await payOrderAction(orderId)

      if (!result.ok) {
        toast.error("支付失败", { description: result.error })
        // 失败原因可能是「已经付过了」「已超时」，页面上的状态已经过时了，
        // 刷一下让服务端重新查一遍
        router.refresh()
        return
      }

      toast.success("支付成功", { description: "我们已经收到你的订单，正在准备发货" })
      // 让服务端组件重跑：状态徽章从「待支付」变「已支付」，
      // 支付时间那一行也会冒出来
      router.refresh()
    })
  }

  return (
    <Button onClick={handlePay} disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <CreditCard className="size-4" />
      )}
      {pending ? "支付中…" : "去支付"}
    </Button>
  )
}
