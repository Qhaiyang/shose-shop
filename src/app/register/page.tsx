import { redirect } from "next/navigation"

import { AuthForm } from "@/components/auth/auth-form"
import { getCurrentUser } from "@/lib/auth"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "注册 | 鞋店",
}

type RegisterPageProps = {
  searchParams: Promise<{ next?: string | string[] }>
}

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const user = await getCurrentUser()
  if (user) redirect("/products")

  const { next } = await searchParams
  const nextPath = typeof next === "string" ? next : undefined

  return (
    <div className="mx-auto flex w-full max-w-6xl justify-center px-4 py-16">
      <AuthForm mode="register" next={nextPath} />
    </div>
  )
}
