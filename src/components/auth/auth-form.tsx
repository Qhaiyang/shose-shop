"use client"

import { useActionState, type ReactNode } from "react"
import Link from "next/link"
import { Loader2, Lock, Mail, User as UserIcon } from "lucide-react"

import { loginAction, registerAction } from "@/app/actions/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// ============================================================================
// 登录 / 注册表单（客户端）
//
// 【为什么登录和注册合成一个组件】
// 两者只差一个「昵称」字段和几个文案，其余（邮箱、密码、错误展示、
// 提交按钮的 loading 态、底部切换链接）完全一样。合成一个组件用 mode
// 分支，比复制两份再各自维护要省事得多。
//
// 【useActionState 是怎么工作的】
//   const [state, formAction, pending] = useActionState(action, 初始值)
//     state      → 上一次 Server Action 的返回值（错误信息就靠它）
//     formAction → 直接塞给 <form action={formAction}>
//     pending    → 提交中为 true，用来禁用按钮、显示 loading
//
// 提交时 React 会自动把表单里的 <input name="..."> 打包成 FormData
// 发给服务端，不需要我们手写 fetch，也不需要 useState 存每个字段的值。
// ============================================================================

type AuthFormProps = {
  mode: "login" | "register"
  /** 登录/注册成功后跳回哪里，由 URL 上的 ?next= 传进来 */
  next?: string
}

const COPY = {
  login: {
    title: "登录",
    description: "登录后购物车会同步到账号，换设备也能看到",
    submit: "登录",
    switchText: "还没有账号？",
    switchLink: "立即注册",
    switchHref: "/register",
  },
  register: {
    title: "注册",
    description: "创建一个账号，开始你的第一双鞋",
    submit: "注册",
    switchText: "已经有账号了？",
    switchLink: "去登录",
    switchHref: "/login",
  },
} as const

export function AuthForm({ mode, next }: AuthFormProps) {
  const copy = COPY[mode]

  // 两个 action 的签名一致，所以可以直接按 mode 选一个传进去
  const [state, formAction, pending] = useActionState(
    mode === "login" ? loginAction : registerAction,
    undefined,
  )

  // 切换登录/注册时要把 next 一起带过去，否则登录完就跳不回原页面了
  const switchHref = next
    ? `${copy.switchHref}?next=${encodeURIComponent(next)}`
    : copy.switchHref

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>

      {/*
        【为什么用 <form action={...}> 而不是 onSubmit + fetch】
        Server Action 直接挂在 form 的 action 上，即使 JS 还没加载完
        （或者用户禁用了 JS）表单也能提交，这是渐进增强。
        另外 React 会自动处理提交状态和返回值，省掉一堆手写逻辑。
      */}
      <form action={formAction} className="space-y-4">
        {/* 把跳转目标藏在隐藏字段里，随表单一起提交给 Server Action */}
        {next && <input type="hidden" name="next" value={next} />}

        {mode === "register" && (
          <Field
            id="name"
            label="昵称"
            icon={<UserIcon className="size-4" />}
            errors={state?.errors?.name}
          >
            <Input
              id="name"
              name="name"
              placeholder="怎么称呼你"
              autoComplete="nickname"
              required
              aria-invalid={!!state?.errors?.name}
            />
          </Field>
        )}

        <Field
          id="email"
          label="邮箱"
          icon={<Mail className="size-4" />}
          errors={state?.errors?.email}
        >
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            required
            aria-invalid={!!state?.errors?.email}
          />
        </Field>

        <Field
          id="password"
          label="密码"
          icon={<Lock className="size-4" />}
          errors={state?.errors?.password}
          hint={mode === "register" ? "至少 8 位，需包含字母和数字" : undefined}
        >
          <Input
            id="password"
            name="password"
            type="password"
            placeholder={mode === "register" ? "设置一个密码" : "输入密码"}
            autoComplete={
              mode === "register" ? "new-password" : "current-password"
            }
            required
            aria-invalid={!!state?.errors?.password}
          />
        </Field>

        {/* 整体性错误（比如「邮箱或密码不正确」），放在最显眼的位置 */}
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
          {pending ? "提交中…" : copy.submit}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        {copy.switchText}{" "}
        <Link href={switchHref} className="font-medium text-primary hover:underline">
          {copy.switchLink}
        </Link>
      </p>

      {/* 学习项目专属：把种子账号写在这儿，省得每次都去翻 seed.ts
          【生产环境不显示】这两个账号只在本地库才种（见 prisma/seed.ts 的
          shouldSeedDemoAccounts）。线上既没有这两个账号，把密码印在
          登录页上更是等于给后台留了张告示 —— 所以线上直接不渲染。 */}
      {mode === "login" && process.env.NODE_ENV !== "production" && (
        <DemoAccounts />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 字段包装：统一「标签 + 输入框 + 错误信息」的结构
// ---------------------------------------------------------------------------
type FieldProps = {
  id: string
  label: string
  icon: ReactNode
  errors?: string[]
  hint?: string
  children: ReactNode
}

function Field({ id, label, icon, errors, hint, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="gap-1.5">
        {icon}
        {label}
      </Label>
      {children}
      {errors?.length ? (
        <p className="text-xs text-destructive">{errors.join("；")}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 演示账号提示
// ---------------------------------------------------------------------------
function DemoAccounts() {
  return (
    <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
      <p className="mb-1.5 font-medium text-foreground">演示账号</p>
      <ul className="space-y-0.5">
        <li className="flex justify-between">
          <span>普通用户</span>
          <code className="text-foreground">user@shop.dev / user123</code>
        </li>
        <li className="flex justify-between">
          <span>管理员</span>
          <code className="text-foreground">admin@shop.dev / admin123</code>
        </li>
      </ul>
      <p className="mt-1.5">（来自 prisma/seed.ts，仅用于本地学习）</p>
    </div>
  )
}
