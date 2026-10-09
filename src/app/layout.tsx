import type { Metadata } from "next"
import Link from "next/link"
import { Geist, Geist_Mono } from "next/font/google"

import { OrderChat } from "@/components/ai/order-chat"
import { HeaderAuth } from "@/components/auth/header-auth"
import { CartBadge } from "@/components/cart/cart-badge"
import { CartSync } from "@/components/cart/cart-sync"
import { Toaster } from "@/components/ui/sonner"
import { getCurrentUser } from "@/lib/auth"
import { getDbCartItems } from "@/lib/cart"
import { cartCount } from "@/lib/cart-types"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: {
    default: "鞋店 | 学习用电商 Demo",
    template: "%s",
  },
  description: "一个用来练习 SPU/SKU、购物车、库存扣减和订单状态机的电商项目",
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // 【为什么 layout 要 async】
  // getCurrentUser() 里读了 cookies()，这会让整个路由变成动态渲染
  // （每个请求都重新执行），所以购物车角标不会把数字烤死在构建产物里。
  const user = await getCurrentUser()

  // 已登录才有数据库购物车，未登录为空（本地购物车数量由客户端组件自己读）
  const dbItems = user ? await getDbCartItems(user.id) : []

  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* 全局购物车同步器：负责 localStorage 水合 + 登录后合并到数据库。
            它不渲染任何 UI，放在这里是为了每一页都能生效 */}
        <CartSync userId={user?.id ?? null} />

        {/* ---------- 顶部导航 ---------- */}
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
            <Link href="/products" className="text-lg font-bold tracking-tight">
              鞋<span className="text-primary">店</span>
            </Link>

            <nav className="flex items-center gap-4 text-sm">
              <Link
                href="/products"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                全部商品
              </Link>
            </nav>

            <div className="ml-auto flex items-center gap-2">
              <CartBadge
                isLoggedIn={user !== null}
                dbCount={cartCount(dbItems)}
              />

              <HeaderAuth user={user} />
            </div>
          </div>
        </header>

        {/* ---------- 页面内容 ---------- */}
        <main className="flex-1">{children}</main>

        {/* ---------- 页脚 ---------- */}
        <footer className="border-t py-6">
          <div className="mx-auto w-full max-w-6xl px-4 text-sm text-muted-foreground">
            学习用项目 · 不产生真实交易
          </div>
        </footer>

        {/* 订单助手悬浮球。只在登录后出现 —— 它要查的是「你的」订单，
            没登录就没什么可查的。注意这道判断只是「不给用户添堵」，
            真正的挡板在 action 里（Server Action 可以被直接 POST 调） */}
        {user && <OrderChat />}

        {/* sonner 的 Toast 容器，全局挂一次即可，各处用 toast() 调用 */}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  )
}
