import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, Heart } from "lucide-react"

import { ProductCard } from "@/components/product/product-card"
import { buttonVariants } from "@/components/ui/button"
import { getCurrentUser } from "@/lib/auth"
import { getFavorites } from "@/lib/favorites-db"
import { cn } from "@/lib/utils"

// ============================================================================
// 我的收藏 —— Server Component
//
// 【这个页面必须登录，而且是在这里拦，不是在导航里藏链接】
// 导航菜单里那个「我的收藏」只有登录后才显示，但那只是体验 ——
// 用户完全可以直接敲 /favorites。真正的门是下面这个 redirect。
// （和 /admin 一样：界面上的隐藏从来不算权限控制）
//
// 【为什么收藏页要登录，详情页却不用】
// 详情页是公开内容，登录与否只是决定心形按钮的初始状态；
// 这个页面整页都是「某个人的私有数据」，没登录根本不知道给谁看。
// ============================================================================

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "我的收藏 | 鞋店",
}

export default async function FavoritesPage() {
  const user = await getCurrentUser()
  // 带上 next，登录完直接落回收藏页，不用自己再点一次菜单
  if (!user) redirect("/login?next=/favorites")

  const { items, hiddenCount } = await getFavorites(user.id)

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6 space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">我的收藏</h1>
        <p className="text-muted-foreground">
          {items.length > 0 ? `共 ${items.length} 款鞋` : "还没有收藏的鞋款"}
          {/* 下架的商品被藏起来了，但得说一声 —— 否则用户会以为收藏丢了。
              收藏记录其实还在，商品重新上架它自己就回来了 */}
          {hiddenCount > 0 ? ` · 另有 ${hiddenCount} 款已下架` : ""}
        </p>
      </header>

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-12 text-center">
          <Heart className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">
            收藏夹是空的。看到喜欢的鞋，在详情页点一下「收藏」就会出现在这里。
          </p>
          <Link
            href="/products"
            className={cn(buttonVariants({ variant: "outline" }), "gap-1.5")}
          >
            去逛逛
            <ArrowRight className="size-4" />
          </Link>
        </div>
      ) : (
        // 网格布局和商品列表页保持一致 —— 收藏页就是「商品列表的一个子集」，
        // 换个排版只会让人以为这是另一种卡片
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  )
}
