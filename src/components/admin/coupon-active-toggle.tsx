"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Power } from "lucide-react"
import { toast } from "sonner"

import { setCouponActiveAction } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"

// ============================================================================
// 「停用 / 启用」优惠券按钮（客户端，管理员用）
//
// 【为什么只有停用，没有删除】
// 删除会让历史订单的 couponId 被置空（onDelete: SetNull），
// 「这单用了哪张券」就永远查不到了。停用能表达「不发了」，
// 又留住了痕迹 —— 券的账是要能倒查的，这和评价的软删除同理。
//
// 【为什么传「我要它变成什么」而不是「切换一下」】
// 和 setFavorite 一样：请求发出去到执行完之间，别的标签页可能已经改过了。
// 传目标状态，重复点击和过期页面都不会翻到反面
// （见 src/lib/favorites-db.ts 里 setFavorite 的注释）。
//
// 【前端 disabled 只是体验，真正的门在 setCouponActiveAction 的 requireAdmin()】
// ============================================================================

export function CouponActiveToggle({
  couponId,
  isActive,
  code,
}: {
  couponId: string
  isActive: boolean
  /** 只用于提示语，不是权限凭证 */
  code: string
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleToggle() {
    startTransition(async () => {
      const result = await setCouponActiveAction(couponId, !isActive)

      if (!result.ok) {
        toast.error("操作失败", { description: result.error })
        // 失败也刷新：多半是这张券已经被别人删了/改了，
        // 页面上那份数据已经旧了，重查一遍比让管理员对着旧数据再点一次强
        router.refresh()
        return
      }

      toast.success(isActive ? `已停用 ${code}` : `已启用 ${code}`, {
        description: isActive
          ? "前台不再出现，但历史订单里还看得到这张券"
          : "前台的商品页和购物车页会重新出现领取入口",
      })
      router.refresh()
    })
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={handleToggle}
      disabled={pending}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Power className="size-4" />
      )}
      {pending ? "处理中…" : isActive ? "停用" : "启用"}
    </Button>
  )
}
