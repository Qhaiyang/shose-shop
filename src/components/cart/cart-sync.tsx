"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { mergeLocalCartAction } from "@/app/actions/cart"
import { useCartStore } from "@/lib/cart-store"

// ============================================================================
// 购物车同步器
//
// 这个组件不渲染任何 UI，只负责两件事，挂在根 layout 里全局生效：
//
//   1. 【水合】把 localStorage 里的购物车读进 zustand store。
//      因为 store 设了 skipHydration，必须有人在客户端主动触发一次。
//
//   2. 【合并】发现「已登录 + 本地购物车非空」时，把本地购物车合并进数据库，
//      成功后清空本地。
//
// 【为什么合并条件不是「刚登录的那一刻」】
// 检测"状态变化"很脆弱（刷新页面、开新标签页都会丢事件）。改成检测
// "当前状态"更可靠：只要满足「已登录 且 本地有货」，就合并。
// 合并成功后立刻清空本地，所以不会重复合并 —— 这个操作是幂等的。
// ============================================================================

type CartSyncProps = {
  /** 当前登录用户 id，未登录为 null。由服务端 layout 传入 */
  userId: string | null
}

export function CartSync({ userId }: CartSyncProps) {
  const items = useCartStore((state) => state.items)
  const hydrated = useCartStore((state) => state.hydrated)
  const router = useRouter()

  // 防止同一次会话里并发触发多次合并
  const mergingRef = useRef(false)

  // ---- 1. 水合 ----
  useEffect(() => {
    void useCartStore.persist.rehydrate()
  }, [])

  // ---- 2. 登录后合并 ----
  useEffect(() => {
    // 未登录、还没水合、本地没东西、正在合并中 —— 都跳过
    if (!userId || !hydrated || items.length === 0) return
    if (mergingRef.current) return

    mergingRef.current = true

    const lines = items.map((item) => ({
      skuId: item.skuId,
      quantity: item.quantity,
    }))

    void (async () => {
      try {
        const result = await mergeLocalCartAction(lines)

        if (!result.ok) {
          console.error("[cart] 合并失败:", result.error)
          return
        }

        // 合并成功才清空本地。顺序很重要：先确认数据库写成功，再清本地，
        // 否则中途失败就把用户的购物车弄丢了。
        useCartStore.getState().clear()

        toast.success("购物车已合并到账号", {
          description: `${lines.length} 种商品已累加到你账号的购物车`,
        })

        // 让服务端组件重新渲染（顶部角标要更新）
        router.refresh()
      } catch (error) {
        console.error("[cart] 合并时出错:", error)
      } finally {
        mergingRef.current = false
      }
    })()
  }, [userId, hydrated, items, router])

  return null
}
