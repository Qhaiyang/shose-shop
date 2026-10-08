"use client"

import { useEffect, useActionState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, MapPin, Phone, StickyNote } from "lucide-react"

import { createOrderAction } from "@/app/actions/order"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ORDER_NOTE_MAX_LENGTH } from "@/lib/constants"

// ============================================================================
// 结算表单（客户端）
//
// 【表单里为什么只有收货信息和备注，没有任何金额】
// 商品、数量、单价、总价全都不在这个表单里。
// 用户按下「提交订单」时，服务端是拿 cookie 里的 userId 去数据库查购物车
// 来算钱的，表单里就算被篡改也影响不到金额。
// 这是「凡是从客户端来的数据都不可信」的最直接体现。
//
// 备注是这张表单里唯一「客户端说了算」的字段 —— 因为它本来就不影响
// 钱和货，只是买家留给自己和打包员的一句话。但它也不是随便收的：
// 长度上限、trim、空串归一成 null 都在服务端再过一遍。
//
// 【useActionState】
// 返回值里的 message 用来显示「库存不足」「登录失效」这类整体错误，
// errors 用来显示单个字段的错误。和登录表单是同一套模式。
// ============================================================================

/**
 * 这张表单的 DOM id。
 *
 * 【为什么要有它】
 * 优惠券的单选按钮渲染在**右边那一栏**（结算页的金额汇总区），
 * 不在这个 <form> 里面。它们靠 HTML 原生的 form 属性关联回来：
 * 只要给 <input form={CHECKOUT_FORM_ID}>，浏览器就会把这个
 * 「身体在表单外」的控件算作这张表单的一部分，提交时一起收进。
 *
 * 这样做的好处是：选券的那块交互和地址表单可以是两个互不依赖的
 * 组件，不用为了共享「选了哪张券」把它俩塞进同一个客户端组件，
 * 也不用为这一个字符串引入 Context。
 *
 * 【为什么必须 export 出去给别的文件用】
 * 这个 id 有两个持有者（表单自己、外面的单选按钮），
 * 把字面量抄两遍，改了一处另一处就静默失效 —— 表现是
 * 「选了券但下单时没减钱」，很难查。所以只留一个定义。
 */
export const CHECKOUT_FORM_ID = "checkout-form"

export function CheckoutForm() {
  const [state, formAction, pending] = useActionState(
    createOrderAction,
    undefined,
  )
  const router = useRouter()

  // 下单失败且带回了具体 SKU 时，刷新一次页面 —— 让右上角订单摘要
  // （Server Component）重新查一遍库存，把库存不足的那一行标红。
  // revalidatePath 只是让缓存失效，得靠 router.refresh() 真正触发重渲染。
  // state 由 useActionState 持有，refresh 不会清掉它，报错文案还在。
  useEffect(() => {
    if (state?.insufficientSkuId) {
      router.refresh()
    }
  }, [state?.insufficientSkuId, router])

  return (
    <form id={CHECKOUT_FORM_ID} action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="address" className="gap-1.5">
          <MapPin className="size-4" />
          收货地址
        </Label>
        <Textarea
          id="address"
          name="address"
          rows={3}
          placeholder="省 / 市 / 区 + 详细地址，例如：上海市浦东新区张江路 100 号 3 号楼 502"
          required
          aria-invalid={!!state?.errors?.address}
        />
        {state?.errors?.address && (
          <p className="text-xs text-destructive">
            {state.errors.address.join("；")}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="phone" className="gap-1.5">
          <Phone className="size-4" />
          手机号
        </Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          inputMode="numeric"
          placeholder="11 位手机号"
          autoComplete="tel"
          required
          aria-invalid={!!state?.errors?.phone}
        />
        {state?.errors?.phone && (
          <p className="text-xs text-destructive">
            {state.errors.phone.join("；")}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="note" className="gap-1.5">
          <StickyNote className="size-4" />
          订单备注
          <span className="font-normal text-muted-foreground">（选填）</span>
        </Label>
        <Textarea
          id="note"
          name="note"
          rows={2}
          // maxLength 只是「别让人白写一堆再被打回来」的体验优化。
          // 真正的上限在服务端（orderNoteSchema），因为前端限制随手就能绕过
          maxLength={ORDER_NOTE_MAX_LENGTH}
          placeholder="有什么要交代的？例如：请工作日送达、放门口快递柜"
          aria-invalid={!!state?.errors?.note}
        />
        {state?.errors?.note && (
          <p className="text-xs text-destructive">
            {state.errors.note.join("；")}
          </p>
        )}
      </div>

      {/* 整体错误：库存不足、登录失效等 */}
      {state?.message && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {state.message}
        </p>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Loader2 className="size-4 animate-spin" />}
        {pending ? "正在提交…" : "提交订单"}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        提交后库存会被立即锁定，请在 15 分钟内完成支付
      </p>
    </form>
  )
}
