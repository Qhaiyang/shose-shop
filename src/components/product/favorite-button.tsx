"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Heart } from "lucide-react"
import { toast } from "sonner"

import { setFavoriteAction } from "@/app/actions/favorite"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// ============================================================================
// 收藏按钮（详情页）
//
// 【为什么它是客户端组件】
// 点一下心形要立刻变红、再变灰，这是纯交互状态。
//
// 【为什么不用 useOptimistic】
// 那个 hook 是给「乐观结果依附在服务端数据上、随它一起被替换」的场景用的。
// 这里的心形状态只有一个布尔值，而且**没有**紧跟着 router.refresh() ——
// 一个 useState 就够，也更直白。
//
// 【和 review-button.tsx 的分工】
// 那个按钮提交完要 router.refresh()，因为订单行上「已评价」的位置、
// 另一件商品还在不在，都得重新问服务端；这里刷新反而会把本地的
// 心形状态盖回去，所以刻意不刷新。
// ============================================================================

type FavoriteButtonProps = {
  productId: string
  /** 服务端算好的初始状态（未登录时恒为 false） */
  initialFavorited: boolean
  isLoggedIn: boolean
}

export function FavoriteButton({
  productId,
  initialFavorited,
  isLoggedIn,
}: FavoriteButtonProps) {
  const router = useRouter()
  const [favorited, setFavorited] = useState(initialFavorited)
  const [pending, startTransition] = useTransition()

  function handleClick() {
    // ---- 未登录：不做本地猜测，直接带去登录页 ----
    // 【为什么不「先存本地、登录后再合并」】
    // 购物车那么做是因为不这么做就卖不出东西；收藏没这个压力，
    // 而且真要合并就得再来一套 localStorage 存储 + 合并逻辑 + 冲突处理。
    // 把「登录」这一步摆明，用户反而知道收藏是需要账号的
    if (!isLoggedIn) {
      toast.info("登录之后就能收藏了", {
        description: "收藏跟着账号走，换个设备也还在",
      })
      // 带上 next，登录完直接回到这款鞋，不用自己再找一遍
      router.push(`/login?next=/products/${productId}`)
      return
    }

    const next = !favorited

    // 【先改界面，再发请求】
    // 收藏是「点了就该有反应」的操作。等一次网络往返再变心形，
    // 用户会以为没点上、于是再点一下。乐观更新的代价很小：
    // 赌错了就在下面翻回来，只是一次 setState
    setFavorited(next)

    startTransition(async () => {
      const result = await setFavoriteAction(productId, next)

      if (!result.ok) {
        // 回滚到点击之前的样子，并说清楚为什么没成
        // （最常见的是「请先登录」—— cookie 过期了但页面还开着）
        setFavorited(!next)
        toast.error(result.error)
        return
      }

      // 以服务端返回的状态为准，而不是想当然地用 next。
      // 正常情况两者一致；有分歧时服务端才是对的
      setFavorited(result.favorited)

      toast.success(result.favorited ? "已加入收藏" : "已取消收藏", {
        description: result.favorited
          ? "在「我的收藏」里可以随时找到它"
          : "它已从收藏夹移除",
      })
    })
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className="w-full gap-2"
      onClick={handleClick}
      // pending 期间不禁用：请求还在路上时用户可能想改主意点回来。
      // 点了也没关系 —— 两次请求都是「设置成某个状态」，后来的覆盖先前的，
      // 不会出现「收藏了两遍」这种累积型错误
      aria-pressed={favorited}
      data-pending={pending || undefined}
    >
      <Heart
        // 实心 + 玫红 = 已收藏，空心灰 = 未收藏。
        // 只靠颜色区分对色觉障碍用户不友好，所以文案（收藏 / 已收藏）
        // 也跟着一起变 —— 形状和文字两重信号
        className={cn(
          "size-4 transition-colors",
          favorited ? "fill-rose-500 text-rose-500" : "text-muted-foreground",
        )}
      />
      {favorited ? "已收藏" : "收藏"}
    </Button>
  )
}
