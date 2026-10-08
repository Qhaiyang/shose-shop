"use client"

import Link from "next/link"
import {
  Heart,
  LayoutDashboard,
  LogOut,
  Package,
  TicketPercent,
  User as UserIcon,
} from "lucide-react"

import { logoutAction } from "@/app/actions/auth"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { USER_ROLE } from "@/lib/constants"
import { cn } from "@/lib/utils"
import type { SessionUser } from "@/lib/auth"

// ============================================================================
// 顶部导航右侧的登录态区域
//
// 【为什么这一块是客户端组件，而 header 其余部分是服务端组件】
// 下拉菜单需要打开/关闭的交互状态，只能在客户端跑。
// 但登录态本身是服务端算出来的（cookie 带 httpOnly，JS 读不到），
// 所以由 layout.tsx 这个服务端组件把 user 当 props 传进来。
//
// 这就是 httpOnly cookie 方案的典型分工：
//   服务端决定「你是谁」 → props 往下传 → 客户端只负责渲染和交互
// ============================================================================

type HeaderAuthProps = {
  user: SessionUser | null
}

export function HeaderAuth({ user }: HeaderAuthProps) {
  // ---- 未登录：并排放登录和注册 ----
  if (!user) {
    return (
      <div className="flex items-center gap-1.5">
        <Link
          href="/login"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
        >
          登录
        </Link>
        <Link href="/register" className={cn(buttonVariants({ size: "sm" }))}>
          注册
        </Link>
      </div>
    )
  }

  // ---- 已登录：昵称下拉菜单 ----
  const isAdmin = user.role === USER_ROLE.ADMIN

  return (
    <DropdownMenu>
      {/*
        【关于 render 属性】
        shadcn v4 底层是 base-ui，没有 asChild，改用 render={<元素/>} 来
        「把菜单触发器的行为和属性合并到你给的元素上」。
        Button 渲染出来就是原生 <button>，满足 base-ui 的 nativeButton 断言。
        （第 4 步的 CartBadge 就是因为塞了 <a> 进去才报错的。）
      */}
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className="gap-1.5" />}
      >
        <UserIcon className="size-4" />
        <span className="max-w-20 truncate">{user.name}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-48">
        {/*
          【必须套一层 DropdownMenuGroup】
          DropdownMenuLabel 底层是 base-ui 的 Menu.GroupLabel，而 GroupLabel
          会去读上层 Menu.Group 的 context。直接放在 Content 里、不套 Group 的话，
          base-ui 会抛「MenuGroupContext is missing」，整个页面直接白屏。
          （Radix 版本的 shadcn 允许这么用，base-ui 版本不允许，是移植后的行为差异。）
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-normal">
            {user.email}
          </DropdownMenuLabel>

          <DropdownMenuItem render={<Link href="/orders" />}>
            <Package />
            我的订单
          </DropdownMenuItem>

          <DropdownMenuItem render={<Link href="/favorites" />}>
            <Heart />
            我的收藏
          </DropdownMenuItem>

          <DropdownMenuItem render={<Link href="/my-coupons" />}>
            <TicketPercent />
            我的券
          </DropdownMenuItem>

          {/* 只有管理员才看得到后台入口。注意这只是「界面上不显示」，
              真正的权限校验必须在服务端页面和 Server Action 里再做一次 ——
              用户完全可以直接敲 /admin 这个地址 */}
          {isAdmin && (
            <DropdownMenuItem render={<Link href="/admin" />}>
              <LayoutDashboard />
              管理后台
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/*
          【退出为什么要用 <form> 而不是 onClick + fetch】
          Server Action 最自然的调用方式就是挂在 form 的 action 上。
          用 form 提交还能顺带拿到「同源」这个保护：
          浏览器对跨站表单提交的 cookie 有 SameSite=Lax 限制。
        */}
        <form action={logoutAction}>
          {/*
            【nativeButton 是干什么的】
            base-ui 的 Menu.Item 默认 nativeButton={false}，因为它本来是渲染
            一个 <div>（配上 role="menuitem"）。上面那三个「我的订单 / 我的收藏 /
            管理后台」渲染的是 <a>，正合这个默认值；而这一项渲染的是**真的
            <button>**（它要触发 form 提交，不能是别的标签），标签和默认值对不上，
            开发环境下控制台会报：
              "A component that acts as a button expected a non-<button> because
               the `nativeButton` prop is false..."
            这个警告不是小事 —— 它说的是 base-ui 会往一个真按钮上再叠一层
            role / aria-disabled 之类的非原生属性，两者可能打架。
            显式声明 nativeButton 就是回答它：「这确实是个原生按钮，
            别给我加那套非原生属性，保持浏览器原生行为」（表单提交照旧）
          */}
          <DropdownMenuItem
            nativeButton
            variant="destructive"
            render={<button type="submit" className="w-full" />}
          >
            <LogOut />
            退出登录
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
