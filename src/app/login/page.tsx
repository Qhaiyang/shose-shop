import { redirect } from "next/navigation"

import { AuthForm } from "@/components/auth/auth-form"
import { getCurrentUser } from "@/lib/auth"

// 读了 cookie，天然是动态页面。写出来是为了让构建产物里一眼能看出
// 这一页不会被静态预渲染（否则登录态会被烤死在 HTML 里）
export const dynamic = "force-dynamic"

export const metadata = {
  title: "登录 | 鞋店",
}

type LoginPageProps = {
  // Next 16 里 searchParams 是 Promise，必须 await
  searchParams: Promise<{ next?: string | string[] }>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // 已经登录的人不该再看到登录页，直接送走
  const user = await getCurrentUser()
  if (user) redirect("/products")

  const { next } = await searchParams
  // URL 上可能带 ?next=xxx，登录成功后跳回去
  // （具体怎么防开放重定向，见 src/app/actions/auth.ts 的 safeNext）
  const nextPath = typeof next === "string" ? next : undefined

  return (
    <div className="mx-auto flex w-full max-w-6xl justify-center px-4 py-16">
      <AuthForm mode="login" next={nextPath} />
    </div>
  )
}
