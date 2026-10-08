"use client"

import { useActionState, useState } from "react"
import { Loader2, Save } from "lucide-react"

import type { ProductFormState, ProductFormValues } from "@/app/actions/admin"
import { ImageListEditor } from "@/components/admin/image-list-editor"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

// ============================================================================
// 商品表单（新建 / 编辑共用一个组件）
//
// 【为什么新建和编辑不各写一个】
// 字段、校验规则、错误展示完全一样，唯一的区别是：
//   - 编辑模式多一个隐藏的 productId
//   - 按钮文案不同
// 复制一份出来，以后加一个字段就得改两处，迟早有一处忘了改。
//
// 【为什么用 useActionState 而不是 useTransition + 手动收集 state】
// 校验失败时服务端要把「哪个字段错了」传回来渲染在对应输入框下面。
// useActionState 就是干这个的：action 的返回值 (prevState) 直接拿到，
// 不需要自己维护一个 errors 的 useState。
//
// 【为什么输入框是「受控」的（value + onChange），而不是 defaultValue】
// 这是这一节最容易踩的坑。React 19 有个行为：
// 用 <form action={fn}> 提交后，React 会**自动重置整个表单**，
// 把每个输入框恢复成它的 defaultValue。
//
// 于是就有了一个两难：
//   - 用 defaultValue：提交成功后表单自动清空（很爽），但校验失败时
//     用户填的内容也被一起抹掉，他得全部重打一遍
//   - 想让它「失败时保留」，就得事后改 defaultValue —— 可是对一个
//     **非受控**输入框来说，defaultValue 只在初始化那一刻有效，
//     之后改它 React 会直接警告你，行为也不保证
//
// 受控输入框就没有这个问题：显示什么完全由 state 决定，
// React 怎么重置 DOM 都影响不到它。代价是多几行 onChange ——
// 换来的是「表单显示什么」这件事只有一个唯一来源。
//
// ============================================================================

type ProductFormProps = {
  /** 服务端 action。编辑模式传 updateProductAction，它会读 formData 里的 productId */
  action: (prevState: ProductFormState, formData: FormData) => Promise<ProductFormState>
  /** 编辑模式传商品 id；新建模式不传 */
  productId?: string
  defaultValues?: ProductFormValues
  submitLabel: string
}

const EMPTY: ProductFormValues = {
  name: "",
  description: "",
  category: "",
  images: [],
}

export function ProductForm({
  action,
  productId,
  defaultValues,
  submitLabel,
}: ProductFormProps) {
  const [state, formAction, pending] = useActionState(action, undefined)

  // 服务端每次回话都在告诉我们「表单现在该显示什么」：
  //   - 校验失败 → state.values 是用户刚填的，原样填回去
  //   - 校验成功 → state.values 是 undefined，回落到数据库里的当前值
  //     （编辑页保存成功后，revalidatePath 会让服务端重新查一遍，
  //       defaultValues 就是刚存进去的值）
  const serverValues: ProductFormValues = state?.values ?? defaultValues ?? EMPTY

  const [values, setValues] = useState(serverValues)

  // 服务端给了新结果就同步过来。
  // 【为什么在渲染期间 setState 而不是放 useEffect】
  // 放 effect 里会先渲染一帧旧值再渲染新值，错误提示和输入框会错开一帧；
  // react-hooks/set-state-in-effect 那条 lint 规则也不允许。
  // React 官方支持这种「条件成立就直接 setState」的写法，它会立刻用新值
  // 重新渲染，用户看不到中间那一帧。
  // 条件必须是比较两个值（state !== seen），否则会无限重渲染
  const [seen, setSeen] = useState(state)
  if (state !== seen) {
    setSeen(state)
    setValues(serverValues)
  }

  /** 只更新其中一个文本字段，其余保持不动。
   *  images 是 string[]，走下面的 ImageListEditor，不经过这里 ——
   *  所以这里的 key 只收三个字符串字段，values[key] 就一定是 string */
  const field = (key: "name" | "description" | "category") => ({
    value: values[key],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      const next = event.target.value
      setValues((prev) => ({ ...prev, [key]: next }))
    },
  })

  return (
    // noValidate：关掉浏览器的原生气泡校验，统一由服务端 zod 说话。
    // 否则「必填」的提示有两套样式，用户会看到两种不同的报错
    <form action={formAction} noValidate className="space-y-5">
      {/* 编辑模式靠这个字段告诉 action 改哪一条。
          它是隐藏输入而不是 action 的参数 —— 因为 formAction 只接受 formData */}
      {productId ? <input type="hidden" name="productId" value={productId} /> : null}

      {/* ---------------- 整体错误 ---------------- */}
      {state?.message ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {state.message}
        </div>
      ) : null}

      <Field label="商品名称" errors={state?.errors?.name}>
        <Input name="name" {...field("name")} placeholder="例如：轻量透气跑步鞋" maxLength={60} />
      </Field>

      <Field label="分类" errors={state?.errors?.category} hint="例如：跑步鞋 / 篮球鞋 / 休闲鞋">
        <Input name="category" {...field("category")} placeholder="跑步鞋" maxLength={20} />
      </Field>

      <Field label="商品描述" errors={state?.errors?.description}>
        <Textarea
          name="description"
          {...field("description")}
          placeholder="介绍一下这双鞋的卖点、材质、适合的场景……"
          rows={5}
          maxLength={2000}
        />
      </Field>

      {/*
        图片用「增删 URL + 上下调顺序」的列表编辑，而不是上传控件。
        理由没变：这一节要练的是 CRUD，不是文件上传 ——
        存储、大小限制、类型校验、清理孤儿文件是另一个话题。
        把「图片是什么」和「图片从哪来」解耦，以后要换成上传，
        只要让上传的结果往 images 数组里塞就行。

        值的提交还是走下面这个隐藏输入框（name="images"，一行一个路径），
        服务端的 parseImageLines 照旧解析 —— 提交机制和以前完全一样，
        变的只是「怎么编辑这个数组」。
      */}
      {/* readOnly：值来自 values.images，不受控由用户直接编辑。
          不加的话 React 会警告「给了 value 却没给 onChange」 */}
      <input type="hidden" name="images" value={values.images.join("\n")} readOnly />
      <Field
        label="商品图片"
        errors={state?.errors?.images}
        hint="图片放在 public/shoes/ 下，例如 /shoes/prod_running-1.svg。点「添加」加一张，用 ↑↓ 调整顺序。"
      >
        <ImageListEditor
          images={values.images}
          onChange={(next) => setValues((prev) => ({ ...prev, images: next }))}
        />
      </Field>

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
// 带标签 + 错误提示的字段包装
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

      {/* 有错时把输入框的边框染红。输入框是 children，不方便从外面注入
          aria-invalid，用后代选择器更省事 */}
      <div
        className={
          errors?.length
            ? "[&_input]:border-destructive [&_textarea]:border-destructive"
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
