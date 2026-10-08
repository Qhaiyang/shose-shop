"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { deleteReviewAction } from "@/app/actions/admin"
import { Button } from "@/components/ui/button"

// ============================================================================
// 「下架评价」按钮（客户端，管理员用）
//
// 【为什么按钮文字是「下架」而不是「删除」】
// 它做的确实是软删除（isDeleted = true），行还在数据库里。
// 写成「删除」会让管理员以为数据没了，从而在误删之后不敢确定
// 能不能恢复；写「下架」才和实际行为一致 —— 前台不显示了，记录还在。
//
// 【和发货按钮一模一样的取舍】
// 没有表单字段、失败弹 toast 就够，所以用 useTransition 而不是
// useActionState。前端 disabled 只是体验，真正的门在
// deleteReviewAction 的 requireAdmin() 里。
// ============================================================================

export function DeleteReviewButton({
  reviewId,
  productId,
}: {
  reviewId: string
  /** 只用来作废商品详情页的缓存，不是权限凭证 */
  productId: string
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteReviewAction(reviewId, productId)

      if (!result.ok) {
        toast.error("下架失败", { description: result.error })
        router.refresh()
        return
      }

      toast.success("已下架", { description: "前台不再显示这条评价，记录仍保留" })
      router.refresh()
    })
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={handleDelete}
      disabled={pending}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Trash2 className="size-4" />
      )}
      {pending ? "处理中…" : "下架"}
    </Button>
  )
}
