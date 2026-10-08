"use client"

import Link from "next/link"
import { ShoppingCart } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCartStore } from "@/lib/cart-store"
import { cartCount } from "@/lib/cart-types"

// ============================================================================
// 顶部购物车入口 + 数量角标
//
// 【两套数据源】
//   未登录 → 读 localStorage 里的本地购物车
//   已登录 → 用服务端传来的数据库购物车数量
//
// 【为什么要区分 hydrated】
// 服务端渲染时读不到 localStorage，首屏 HTML 里本地购物车必然是 0。
// 如果客户端一上来就渲染出真实数量，React 会发现两边对不上并报
// hydration mismatch。所以水合完成前一律显示 0，完成后才显示真实值。
// ============================================================================

type CartBadgeProps = {
  /** 已登录时，服务端查出的数据库购物车件数 */
  dbCount: number
  isLoggedIn: boolean
}

export function CartBadge({ dbCount, isLoggedIn }: CartBadgeProps) {
  const localItems = useCartStore((state) => state.items)
  const hydrated = useCartStore((state) => state.hydrated)

  // 未登录时用本地数量；本地还没水合完就按 0 算（与服务端首屏一致）
  const count = isLoggedIn ? dbCount : hydrated ? cartCount(localItems) : 0

  return (
    // 【注意】这里不能用 <Button render={<Link/>}>：
    // shadcn v4 的 Button 底层是 base-ui，它默认 nativeButton=true，
    // 会断言渲染出来必须是原生 <button>，塞个 <a> 进去会在控制台报错。
    // 与其关掉这个断言，不如直接用 buttonVariants() 给 Link 套样式 ——
    // 语义上本来就该是链接（跳转页面），不是按钮。
    <Link
      href="/cart"
      className={cn(
        buttonVariants({ variant: "ghost", size: "sm" }),
        "relative gap-1.5",
      )}
    >
      <ShoppingCart className="size-4" />
      <span className="hidden sm:inline">购物车</span>

      {count > 0 && (
        <span
          className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground"
          aria-label={`购物车中有 ${count} 件商品`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  )
}
