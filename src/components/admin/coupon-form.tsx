"use client"

import { useActionState, useState } from "react"
import { Loader2, Save } from "lucide-react"

import type { CouponFormState, CouponFormValues } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { COUPON_TYPE, COUPON_TYPE_LABEL } from "@/lib/constants"
import { percentDiscountLabel } from "@/lib/coupons"

// ============================================================================
// 优惠券表单（新建 / 编辑共用一个组件）
//
// 【为什么和 product-form.tsx 一样用受控输入 + useActionState】
// 理由完全一样（见那个文件开头的长注释）：React 19 在 action 结束后会
// 自动重置表单，不回传 values 的话，管理员填了一屏数字、因为「每人限领
// 不能超过发放总量」被拒，回来一看全空了 —— 那一屏数字他要重填一遍。
//
// 【这个表单和商品表单最大的不同：字段的含义会变】
// 选「满减券」时，"减免金额" 填的是元（100 = 100 元）；
// 选「折扣券」时，"折扣百分比" 填的是 10（= 9 折）。
// 同一个输入框两种读法，所以选了 type 之后标题、提示、placeholder
// 都要跟着变 —— 这是唯一需要 type 参与渲染的地方。
// 也是本项目少见的「表单字段之间互相影响」的例子。
// ============================================================================

type CouponFormProps = {
  action: (prevState: CouponFormState, formData: FormData) => Promise<CouponFormState>
  /** 编辑模式传券 id；新建模式不传 */
  couponId?: string
  defaultValues?: CouponFormValues
  submitLabel: string
}

const EMPTY: CouponFormValues = {
  code: "",
  type: COUPON_TYPE.FIXED,
  value: "",
  minSpend: "",
  maxDiscount: "",
  startAt: "",
  endAt: "",
  totalLimit: "",
  perUserLimit: "1",
  isActive: true,
}

export function CouponForm({
  action,
  couponId,
  defaultValues,
  submitLabel,
}: CouponFormProps) {
  const [state, formAction, pending] = useActionState(action, undefined)

  const serverValues: CouponFormValues = state?.values ?? defaultValues ?? EMPTY
  const [values, setValues] = useState(serverValues)

  // 服务端给了新结果就同步过来（渲染期间 setState，理由同 product-form.tsx）
  const [seen, setSeen] = useState(state)
  if (state !== seen) {
    setSeen(state)
    setValues(serverValues)
  }

  const isPercent = values.type === COUPON_TYPE.PERCENT

  /** 更新一个文本字段 */
  const field = (key: Exclude<keyof CouponFormValues, "isActive">) => ({
    value: values[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value
      setValues((prev) => ({ ...prev, [key]: next }))
    },
  })

  // 折扣百分比的有效范围（1~99）提示给用户看：填 10 就是 9 折。
  // 只在用户填了个像样的整数时才算 —— 否则会显示成 "NaN 折"
  const percentValue = Number(values.value)
  const percentHint =
    isPercent && Number.isInteger(percentValue) && percentValue >= 1 && percentValue <= 99
      ? `填 ${percentValue} 表示「${percentDiscountLabel(percentValue)} 折」（减 ${percentValue}%）`
      : "填的是「减掉的百分比」：9 折填 10，8.5 折填 15"

  return (
    // noValidate：关掉浏览器原生气泡，统一由服务端的 zodSchema 说话
    <form action={formAction} noValidate className="space-y-5">
      {couponId ? <input type="hidden" name="couponId" value={couponId} /> : null}

      {state?.message ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {state.message}
        </div>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="券码"
          errors={state?.errors?.code}
          hint="只能填字母、数字、下划线和横杠，保存时统一转成大写"
        >
          <Input
            name="code"
            {...field("code")}
            placeholder="SAVE100"
            maxLength={32}
            className="uppercase"
          />
        </Field>

        <Field label="类型" errors={state?.errors?.type}>
          {/*
            【为什么这里用原生 <select>，而不是 components/ui/select】
            ui/select 是 base-ui 的菜单式下拉，用起来需要一套 Trigger/Content/Item
            的组合，而且它**不是**原生表单控件 —— 提交时靠组件内部渲染的
            隐藏 input 把值带出去。两个选项的下拉不值得引入这一层：
            原生 <select name="type"> 会老老实实进 FormData，
            键盘、屏幕阅读器、手机上的原生选择器全都白拿
          */}
          <select
            name="type"
            value={values.type}
            onChange={(event) => {
              const next = event.target.value
              setValues((prev) => ({ ...prev, type: next }))
            }}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
          >
            <option value={COUPON_TYPE.FIXED}>{COUPON_TYPE_LABEL.FIXED}（满 X 减 Y）</option>
            <option value={COUPON_TYPE.PERCENT}>
              {COUPON_TYPE_LABEL.PERCENT}（打 X 折，最多减 Y）
            </option>
          </select>
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label={isPercent ? "折扣百分比" : "减免金额（元）"}
          errors={state?.errors?.value}
          hint={percentHint}
        >
          <Input
            name="value"
            {...field("value")}
            inputMode="decimal"
            placeholder={isPercent ? "10" : "100"}
          />
        </Field>

        <Field
          label="使用门槛（元）"
          errors={state?.errors?.minSpend}
          hint="订单商品原价合计达到这个数才能用。0 表示无门槛"
        >
          <Input name="minSpend" {...field("minSpend")} inputMode="decimal" placeholder="800" />
        </Field>
      </div>

      {/*
        封顶只在折扣券上出现。
        【为什么干脆不渲染它，而不是渲染成 disabled】
        disabled 的输入框不会进 FormData，于是「满减券的 maxDiscount 是
        什么」会变成 undefined —— 而 service 那边要的是明确的 null。
        不渲染的话，我们自己在提交前就知道它不存在，语义更干净。
        （真渲染成 hidden + value="" 也行，但那是在表单里留一个
          「看得见却填不了」的字段，用户会先试着点两下。）
      */}
      {isPercent ? (
        <Field
          label="最多减（元）"
          errors={state?.errors?.maxDiscount}
          hint="折扣券必须封顶，否则买贵重商品时一单能减掉一大截"
        >
          <Input
            name="maxDiscount"
            {...field("maxDiscount")}
            inputMode="decimal"
            placeholder="50"
          />
        </Field>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="开始时间" errors={state?.errors?.startAt} hint="当天 00:00 起可用">
          <Input name="startAt" type="date" {...field("startAt")} />
        </Field>

        <Field
          label="结束时间"
          errors={state?.errors?.endAt}
          hint="当天 23:59 前可用 —— 填「到 10 月 31 日」就是 31 号一整天"
        >
          <Input name="endAt" type="date" {...field("endAt")} />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="发放总量"
          errors={state?.errors?.totalLimit}
          hint="这张券一共能核销多少次。发完之后就领不到了"
        >
          <Input name="totalLimit" {...field("totalLimit")} inputMode="numeric" placeholder="100" />
        </Field>

        <Field
          label="每人限领"
          errors={state?.errors?.perUserLimit}
          hint="同一个人最多能领几张。填 1 就是每人一张"
        >
          <Input
            name="perUserLimit"
            {...field("perUserLimit")}
            inputMode="numeric"
            placeholder="1"
          />
        </Field>
      </div>

      {/*
        复选框不参与上面的受控 values（它是 boolean，field() 只处理字符串），
        单独写。defaultChecked 而不是 checked：它有 defaultValue 那种
        「只在初始化时生效」的特性，但这里正好是我们想要的 ——
        失败回填时用 values.isActive 的值渲染，之后用户手动改由浏览器管。
        隐藏的 "isActive" 不需要：没勾选的复选框干脆不进 FormData，
        服务端 `=== "on"` 天然把「没有」当成 false
      */}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={values.isActive}
          className="size-4 rounded border-input accent-primary"
        />
        立即启用（不勾选则建好后处于停用状态，前台看不到）
      </label>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {pending ? "保存中…" : submitLabel}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// 带标签 + 错误提示的字段包装（和 product-form.tsx 里的是同一个东西）
//
// 【为什么不抽成公共组件】
// 两个表单的字段种类不同（这里多一个 select、那里多一个 textarea），
// 公共组件的错误染色逻辑要从 `[&_input]` 变成「所有可能的控件」。
// 现在只有两份，抄一遍比引入一个「万能 Field」更省事 ——
// 到第三份再抽，那时候才看得清该抽什么
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  errors,
  children,
}: {
  label: string
  hint?: string
  errors?: string[]
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="block">{label}</Label>

      <div
        className={
          errors?.length
            ? "[&_input]:border-destructive [&_select]:border-destructive"
            : ""
        }
      >
        {children}
      </div>

      {hint && !errors?.length ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}

      {errors?.map((error) => (
        <p key={error} className="text-xs text-destructive">
          {error}
        </p>
      ))}
    </div>
  )
}
