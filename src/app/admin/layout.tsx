import Link from "next/link"
import { redirect } from "next/navigation"
import {
  LayoutDashboard,
  MessageSquareQuote,
  Package,
  RotateCcw,
  Ruler,
  ShoppingBag,
  TicketPercent,
} from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { getCurrentUser } from "@/lib/auth"
import { USER_ROLE } from "@/lib/constants"
import { cn } from "@/lib/utils"

// ============================================================================
// 后台布局 —— 权限校验的第一道门
//
// 【为什么放在 layout 里】
// /admin 下面会挂很多页面（订单列表、订单详情、商品管理……）。
// 把校验写在 layout 里，就等于给整个子树加了一道门，
// 以后新加页面自动受保护，不会出现「新页面忘了加校验」。
//
// 【但 layout 不是保险箱！】
// 它只拦得住**页面渲染**。Server Action 编译后是独立的 POST 端点，
// 调用时根本不经过这棵组件树。所以 actions/admin.ts 里每个 action
// 都自己又查了一遍权限。
//
// 两处都写不是冗余，是纵深防御：layout 让用户看不见后台，
// action 里的校验保证就算被绕过也改不动数据。
//
// 【为什么未登录用 redirect，已登录但没权限用「渲染一个提示页」】
//   - 未登录：他可能只是管理员，登录后就能进 —— 跳登录页是有帮助的
//   - 已登录但非管理员：跳登录页毫无意义（他已经登录了），
//     跳首页又会让人以为页面坏了。直接告诉他「你没权限」最清楚
// ============================================================================

export const dynamic = "force-dynamic"

export const metadata = {
  title: "管理后台 | 鞋店",
}

const NAV = [
  { href: "/admin", label: "概览", icon: LayoutDashboard },
  { href: "/admin/orders", label: "订单管理", icon: Package },
  // 退款紧挨着订单：它们是同一件事的两个阶段（下单 → 售后），
  // 排在商品/优惠券前面，是因为「有没有待处理的退款」是每天都得看的
  { href: "/admin/refunds", label: "退款处理", icon: RotateCcw },
  { href: "/admin/products", label: "商品管理", icon: ShoppingBag },
  { href: "/admin/coupons", label: "优惠券", icon: TicketPercent },
  { href: "/admin/reviews", label: "评价管理", icon: MessageSquareQuote },
  { href: "/admin/size-guide", label: "尺码表", icon: Ruler },
] as const

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()

  if (!user) redirect("/login?next=/admin")

  if (user.role !== USER_ROLE.ADMIN) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="rounded-xl border border-dashed py-24 text-center">
          <p className="font-medium text-destructive">没有访问权限</p>
          <p className="mt-1 text-sm text-muted-foreground">
            当前账号 {user.email} 不是管理员。
          </p>
          <Link
            href="/products"
            className={cn(buttonVariants({ variant: "outline" }), "mt-4")}
          >
            返回商品列表
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      {/* ---------------- 后台顶栏 ---------------- */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex items-center gap-2">
          <ShoppingBag className="size-5 text-primary" />
          <span className="font-semibold">管理后台</span>
          <span className="text-sm text-muted-foreground">
            {user.name}（{user.email}）
          </span>
        </div>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "gap-1.5",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
          <Link
            href="/products"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-2")}
          >
            回到前台
          </Link>
        </nav>
      </div>

      {children}
    </div>
  )
}
