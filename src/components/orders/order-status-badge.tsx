import { Badge } from "@/components/ui/badge"
import { ORDER_STATUS, type OrderStatus } from "@/lib/constants"
import { cn } from "@/lib/utils"

// ============================================================================
// 订单状态徽章
//
// 【为什么单独抽一个组件】
// 订单列表和订单详情都要显示状态，两处必须长得一样、颜色一样。
// 如果各写一份 Record，改配色时一定会漏掉一处 —— 这类「同一个东西在
// 两个地方各定义一遍」的重复，是 UI 不一致最主要的来源。
//
// 【为什么用 as const 的对象而不是 switch】
// 写法短，而且 TypeScript 能检查穷尽性：Record<OrderStatus, string>
// 要求每个状态都不能少，将来往 ORDER_STATUS 里加一个状态，
// 这里会立刻报编译错误，逼着你去补配色，而不是运行时显示成灰底。
//
// 这个好处在第 7 步（退款）真的兑现了：加了 REFUNDING / REFUNDED
// 之后，这里是编译报错找上门的第一个文件 —— 不用去翻哪里会显示状态。
// ============================================================================

const STATUS_VARIANT: Record<OrderStatus, string> = {
  [ORDER_STATUS.PENDING_PAYMENT]:
    "bg-amber-100 text-amber-800 hover:bg-amber-100",
  [ORDER_STATUS.PAID]: "bg-blue-100 text-blue-800 hover:bg-blue-100",
  [ORDER_STATUS.SHIPPED]: "bg-violet-100 text-violet-800 hover:bg-violet-100",
  [ORDER_STATUS.COMPLETED]:
    "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  [ORDER_STATUS.CANCELLED]: "bg-muted text-muted-foreground hover:bg-muted",
  // 退款中的用橙色：它是「有人在处理」的状态，需要被注意到，
  // 但又不像错误那样紧急。刻意和「待支付」的琥珀色分开 ——
  // 两者都在等一个动作，但等的人不一样（买家 vs 管理员）
  [ORDER_STATUS.REFUNDING]:
    "bg-orange-100 text-orange-800 hover:bg-orange-100",
  // 已退款用玫红：它是终态，而且是一件已经发生过、钱动过的事，
  // 不该像「已取消」那样用灰色一笔带过
  [ORDER_STATUS.REFUNDED]: "bg-rose-100 text-rose-800 hover:bg-rose-100",
}

export function OrderStatusBadge({
  status,
  label,
  className,
}: {
  status: OrderStatus
  /** 中文标签。传进来是为了和列表页的 OrderSummary 共用同一份数据，少查一次表 */
  label: string
  className?: string
}) {
  return (
    <Badge className={cn("border-0", STATUS_VARIANT[status], className)}>
      {label}
    </Badge>
  )
}
