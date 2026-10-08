"use client"

import { useEffect, useActionState, useRef } from "react"
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

  // ---- 幂等键 ----
  //
  // 【为什么不是 useState(() => crypto.randomUUID())】
  // 惰性初始化看着更简洁，但它在 **SSR 和 hydration 各跑一次**：
  // 服务端算出 UUID-A 渲染进 HTML，客户端 hydration 时算出 UUID-B，
  // 两者对不上 → React 报 hydration mismatch（"Prop `value` did not match"）。
  // 所以首屏两端必须是同一个值，真键只能等挂载之后再生成。
  //
  // 【为什么是「写 DOM」而不是 useEffect + setState】
  // 两条路都能避开 mismatch，但 setState 那条被 lint 拦住了：
  // 项目开了 react-hooks/set-state-in-effect，同步 setState 会触发一次
  // 级联重渲染。而真正的理由是 —— 这个键**从不参与渲染**，
  // 它只是提交时随表单带上去的一个字符串。既然屏幕上没有它，
  // 就没必要放进 React 状态、没必要为它多跑一次 render。
  // 直接写 DOM 反而更贴近本质：这是一次「与 React 之外的系统（浏览器表单）
  // 同步」，正是 effect 的正统用途。
  //
  // 所以这个 input 是**非受控**的：首屏渲染不带 value 属性，
  // 两端一致（不会 mismatch）；挂载后 effect 把真实 UUID 填进去
  //
  // 【为什么用 useEffect 而不是每次 render 现生成】
  // effect 只在客户端、挂载后跑一次，跑完键就固定了 —— 用户狂点提交、
  // 请求超时重试，带的都还是同一个键，服务端这才认得出「这是同一个请求」。
  //
  // 【为什么在挂载时生成，而不是每次 submit 时生成】
  // 每次 submit 现生成的话，双击提交的两次请求会各带一个新键，
  // 服务端看成两笔不同的订单 —— 等于没做。
  //
  // 【为什么交给 crypto.randomUUID()】
  // 浏览器保证它全局唯一，不用引第三方库，也不会因为两台设备
  // 同时下单而撞号（这正是不用「时间戳」当键的原因：并发下会重复）。
  //
  // 【effect 跑到之前那一瞬间空着，会不会出问题】
  // 不会。空串提交上去，Server Action 那边把它归成 null = 「不做幂等」，
  // 也就是退化成加这个字段之前的行为，只是少了去重保护，不会出错。
  // 何况 effect 在 hydration 后立刻执行，人手动点提交不可能抢在它前面。
  //
  // 【后退再提交这个场景它管不着，也不需要管】
  // 下单成功会 redirect 到订单页，结算页被卸载；用户后退回来是重新挂载，
  // 会拿到一个新键。但那时购物车已经被第一单清空了，撞的是
  // 「购物车是空的」——本来就下不了第二单
  const idempotencyKeyRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 写的是 DOM 的 value，不是 React state —— 见上面那段解释
    if (idempotencyKeyRef.current) {
      idempotencyKeyRef.current.value = crypto.randomUUID()
    }
  }, [])

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
      {/* 隐藏字段：和地址、备注一起提交上去，服务端据此认出重复请求。
          它不影响钱和货，客户端改它最多让自己少一次去重保护。
          非受控 + 不带 value：首屏两端都是空，键由上面那个 effect 填进来 */}
      <input type="hidden" name="idempotencyKey" ref={idempotencyKeyRef} />

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
