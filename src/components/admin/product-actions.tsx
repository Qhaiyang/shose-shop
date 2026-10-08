"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Eye, EyeOff, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  deleteProductAction,
  setProductActiveAction,
} from "@/app/actions/admin"
import { Button } from "@/components/ui/button"

// ============================================================================
// 商品的上下架 / 删除按钮
//
// 【为什么上下架压根不需要二次确认，删除却要连问两次】
// 判断标准始终是「点错了有什么代价」：
//   - 上下架是**可逆**的，点错了再点一次就回来了，代价接近零
//   - 删除是**不可逆**的，而且一旦删掉，即使订单里的快照还在，
//     也再也没法追溯买家当初买的是哪个规格
// 所以下架用普通按钮，删除用 confirm + 按钮本身的红色 + 文案里的「彻底删除」。
//
// 【服务端仍然会拦】
// 前端这些限制都只是体验。真正管事的是 actions/admin.ts 里
// requireAdmin()，以及 deleteProduct 内部「被订单引用就拒绝」的检查 ——
// 就算有人在控制台里直接调 action，也一样删不掉卖过的商品。
// ============================================================================

export function ProductActiveToggle({
  productId,
  isActive,
  /** "button" 用在列表行里，"full" 用在详情页，文案更完整 */
  variant = "button",
}: {
  productId: string
  isActive: boolean
  variant?: "button" | "full"
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function toggle() {
    startTransition(async () => {
      const result = await setProductActiveAction(productId, !isActive)

      if (!result.ok) {
        toast.error("操作失败", { description: result.error })
        return
      }

      toast.success(isActive ? "已下架" : "已上架", {
        description: isActive
          ? "前台的列表和详情里都看不到了，已有订单不受影响"
          : "现在可以在前台买到了",
      })
      router.refresh()
    })
  }

  const label = isActive ? "下架" : "上架"

  return (
    <Button
      variant="outline"
      size={variant === "full" ? "default" : "sm"}
      onClick={toggle}
      disabled={pending}
      className="gap-1.5"
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : isActive ? (
        <EyeOff className="size-4" />
      ) : (
        <Eye className="size-4" />
      )}
      {label}
    </Button>
  )
}

export function DeleteProductButton({
  productId,
  productName,
  /** 删完跳去哪。传了就 push，不传就只 refresh（详情页删完必须跳走） */
  redirectTo,
  size = "sm",
}: {
  productId: string
  productName: string
  redirectTo?: string
  size?: "sm" | "default"
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function remove() {
    // 第一问：确认要删
    const first = window.confirm(
      `确定要彻底删除《${productName}》吗？\n\n` +
        `删除后无法恢复。如果只是暂时不想卖，用「下架」就够了。`,
    )
    if (!first) return

    // 第二问：逼操作者想一秒钟。删商品是后台里唯一不可逆的操作
    const second = window.confirm(
      `再确认一次：删除《${productName}》。\n\n被订单引用过的商品服务端会拒绝删除。`,
    )
    if (!second) return

    startTransition(async () => {
      const result = await deleteProductAction(productId)

      if (!result.ok) {
        toast.error("删除失败", { description: result.error })
        return
      }

      toast.success("商品已删除")
      // 详情页删掉的商品之后不能再访问，必须离开这一页；
      // 列表页原地刷新即可
      if (redirectTo) router.push(redirectTo)
      else router.refresh()
    })
  }

  return (
    <Button
      variant="destructive"
      size={size === "default" ? "default" : "sm"}
      onClick={remove}
      disabled={pending}
      className="gap-1.5"
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Trash2 className="size-4" />
      )}
      彻底删除
    </Button>
  )
}
