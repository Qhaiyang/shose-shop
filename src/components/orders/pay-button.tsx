"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CreditCard, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { loadStripe } from "@stripe/stripe-js"
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js"

import { createPaymentIntentAction } from "@/app/actions/order"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// ============================================================================
// 「去支付」按钮（客户端）
//
// 【三个阶段】
//   idle                  —— 一个「去支付」按钮，点了才开始建 PI
//   creating-pi           —— 正在调 createPaymentIntentAction 拿 clientSecret，
//                            按钮转圈、禁用，防止连点建出两个 PI
//   awaiting-confirmation —— 已经拿到 clientSecret，弹出一个对话框渲染
//                            Stripe 的 <PaymentElement>，等用户填卡付款
//
// 【为什么是「三态」，而不是沿用旧版 useTransition 的「两态」】
// 旧版模拟支付点一下就是「正在支付 → 成功」，一个 useTransition 管得住。
// 真实支付中间多了一步：先建 PI（拿 clientSecret），再填卡（Stripe 的页面）。
// 这两步之间如果还允许用户连点，就会「点了两次、建了两个 PI」——
// 而第二个 PI 会把订单上的 stripePaymentIntentId 覆盖掉，旧 PI 日后
// 成功支付的 webhook 就找不到归属了。所以「建 PI」这一步必须被禁用挡住。
// ============================================================================

/**
 * 模块级只建一次 stripePromise。
 *
 * 【为什么可以放心写在模块顶层】
 * loadStripe 在服务端（SSR / build）会直接 resolve 成 null、不碰 window，
 * 所以 import 这个文件不会在构建期炸（见 stripe-js 源码里 loadScript 对
 * `typeof window === "undefined"` 的处理）。真正的 Stripe.js 脚本只在浏览器
 * 里、第一次真正用到时才注入。
 */
const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
)

/**
 * 「等 webhook 翻状态」的探测节奏。
 *
 * 卡一付完，Stripe 就发 payment_intent.succeeded，但它到我们这儿有几秒的
 * 网络与排队延迟（本地 stripe listen 通常 <1s，生产走 Stripe → 部署平台
 * 一般 2~5s）。这期间订单还是「待支付」，所以不能立刻宣布成功 ——
 * 见 PaymentForm 里那段说明。1s 一问、最多 20 次，覆盖到绝大多数情况。
 */
const POLL_INTERVAL_MS = 1000
const POLL_MAX_ATTEMPTS = 20

export function PayButton({ orderId }: { orderId: string }) {
  // clientSecret 是「要不要渲染收银台」的开关，属于渲染相关状态，
  // 所以进 state（拿没拿到它，直接决定 UI 长什么样）
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handlePay() {
    startTransition(async () => {
      const result = await createPaymentIntentAction(orderId)

      if (!result.ok) {
        toast.error("支付失败", { description: result.error })
        // 失败原因可能是「已经付过了」「已超时」，页面上的状态已经过时了，
        // 刷一下让服务端重新查一遍
        router.refresh()
        return
      }

      // 拿到 clientSecret 就弹出收银台。订单状态此时仍是「待支付」，
      // 要等用户真的付了钱、webhook 回来，才翻成「已支付」
      setClientSecret(result.clientSecret)
    })
  }

  return (
    <>
      <Button onClick={handlePay} disabled={pending}>
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <CreditCard className="size-4" />
        )}
        {pending ? "正在打开支付…" : "去支付"}
      </Button>

      {clientSecret && (
        <StripePaymentDialog
          orderId={orderId}
          clientSecret={clientSecret}
          onClose={() => setClientSecret(null)}
        />
      )}
    </>
  )
}

/**
 * 收银台对话框：把 Stripe 的 <PaymentElement> 包进 <Elements>。
 *
 * 【为什么拆成三个组件，而不是全塞进 PayButton】
 * <PaymentElement> 里的表单控件要用 useStripe()/useElements()，而这两个
 * hook 必须跑在 <Elements> 的**子组件**里 —— 不能和 <Elements> 在同一个
 * 组件里出现。所以收银台必然要拆一层：外层包 <Elements>，内层才用 hook。
 *
 * 【对话框是「支付是否已生效」的唯一探针】
 * 订单有没有翻成「已支付」，只有订单页那个服务端块知道。这个对话框靠
 * 定时 router.refresh() 去问它。用户手动关掉对话框（点 X / 点遮罩）就
 * 失去了这个自动探测 —— 之后得自己刷新页面才知道支付生效没有。这是可接受的
 * 取舍：关掉对话框本来就等于「不看了」。
 */
function StripePaymentDialog({
  orderId,
  clientSecret,
  onClose,
}: {
  orderId: string
  clientSecret: string
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>完成支付</DialogTitle>
          <DialogDescription>
            支付由 Stripe 处理，本店不接触你的卡号。
          </DialogDescription>
        </DialogHeader>
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <PaymentForm orderId={orderId} />
        </Elements>
      </DialogContent>
    </Dialog>
  )
}

function PaymentForm({ orderId }: { orderId: string }) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // 卡已确认、正在等 webhook 翻订单状态。true 时把表单换成「确认中」面板
  const [confirming, setConfirming] = useState(false)
  // 轮询到头也没等到状态变化
  const [timedOut, setTimedOut] = useState(false)
  const router = useRouter()

  // 轮询句柄是「非渲染值」—— 它不参与任何 UI 输出，所以用 ref 而不是 state
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // 【为什么在 cleanup 里停轮询，而不是在 onClose 里】
  // onClose 只覆盖「用户主动关」这一条路。订单变 PAID 之后，是**父级那个
  // PENDING_PAYMENT 条件块**把 PayButton 连同这个对话框一起卸载的 ——
  // 那条路根本不经过 onClose。挂在 cleanup 上，两条路都干净。
  // （不清的话，组件卸载后定时器还在跑，会往已卸载的组件 setState）
  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) clearInterval(pollTimer.current)
    }
  }, [])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    // 理论上不可能：<Elements> 都包好了 stripe/elements 一定有值。
    // 但 loadStripe 在没配 publishable key 时会给 null，这里兜一句
    // 比让 useStripe() 的返回值往下走、在 confirmPayment 里炸得更清楚
    if (!stripe || !elements) return

    setSubmitting(true)
    setErrorMessage(null)

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        // 万一命中需要跳转的支付方式，就把它带回订单页
        return_url: `${window.location.origin}/orders/${orderId}`,
      },
      // 卡支付（本地测试用的 4242）不需要跳转，确认完当场返回结果；
      // 只有那些必须跳到发卡行页面的方式才会真的重定向
      redirect: "if_required",
    })

    if (error) {
      // 卡被拒、CVC 错这类是「这一次没付成」，留在对话框里让用户重试，
      // 不要关掉 —— 关掉等于把填了一半的卡信息扔了
      setErrorMessage(error.message ?? "支付失败，请重试")
      setSubmitting(false)
      return
    }

    // 【为什么这里不立刻 toast「支付成功」】
    // confirmPayment 成功只说明**卡那边**过了；订单翻成「已支付」是 webhook
    // 的事，中间有几秒延迟。这时候就报成功，用户看到的却是徽章还写着
    // 「待支付」—— 自相矛盾的画面会让人以为没付上、再点一次「去支付」。
    // 所以改成：切到「确认中」面板，用 router.refresh() 当探针去轮询，
    // 直到订单页变成「已支付」（那个条件块连同本组件一起卸载，面板自然消失）。
    setSubmitting(false)
    setConfirming(true)

    let attempts = 0
    pollTimer.current = setInterval(() => {
      attempts += 1
      // 刷新会重跑服务端组件，订单一旦变 PAID，父级的条件块就不再渲染，
      // 本组件被卸载 → cleanup 清掉这个定时器
      router.refresh()

      if (attempts >= POLL_MAX_ATTEMPTS) {
        if (pollTimer.current !== null) clearInterval(pollTimer.current)
        pollTimer.current = null
        setTimedOut(true)
      }
    }, POLL_INTERVAL_MS)
  }

  // 卡已确认，正在等订单状态落地
  if (confirming) {
    return (
      <div className="space-y-4">
        {timedOut ? (
          <>
            <p className="text-sm text-muted-foreground">
              支付已完成。订单状态还在确认中，稍等一会儿刷新看看。
            </p>
            {/* 超时后不能干等：给一个显式的刷新入口，用户能自己再问一次 */}
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => router.refresh()}
            >
              刷新页面
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            支付成功，正在确认订单状态…
          </p>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}
      <Button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="w-full"
      >
        {submitting && <Loader2 className="size-4 animate-spin" />}
        支付
      </Button>
    </form>
  )
}
