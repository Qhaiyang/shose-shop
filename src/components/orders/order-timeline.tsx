import type { OrderDetail } from "@/lib/orders"

// ============================================================================
// 订单时间轴
//
// 【为什么用「有值就显示」这种方式】
// 这些时间字段里，绝大多数在不同阶段都是 null：
//   刚下单     → 只有 createdAt 和 expiresAt
//   已支付     → 多了 paidAt
//   已发货     → 多了 shippedAt
//   已完成     → 多了 completedAt
//   已取消     → 多了 cancelledAt
//   已退款     → 多了 refundedAt
//
// 每个都写一遍 if 太啰嗦，所以下面用一个数组描述：
// 「哪个字段、显示什么名字、什么时候该出现」。
// 加新的时间字段时只要往这个数组里加一项。
//
// 【退款为什么能塞进这张表】
// 「退款处理中」这个状态本身没有时间戳 —— 它开始于买家点提交的那一刻，
// 而那件事的细节（谁、为什么、什么时候）在退款卡片里，比在时间轴里
// 多一行「申请退款时间」有用得多。时间轴只留「已退款」这一个
// 真正终结了订单的时刻，避免同一件事在两个地方各说一半。
//
// 【为什么不是「画一条带节点的进度条」】
// 那需要知道当前状态、把状态映射到第几个节点、还要处理取消分支
// （取消可能发生在支付前后，节点位置不一样）。视觉上更好看，
// 但读代码的人要先看懂那套映射规则才能改。学习项目里
// 「字段名 + 时间」的清单更直白，也更容易验证。
// ============================================================================

export function OrderTimeline({ order }: { order: OrderDetail }) {
  const entries: { label: string; value: Date | null }[] = [
    { label: "下单时间", value: order.createdAt },
    { label: "支付截止", value: order.expiresAt },
    { label: "支付时间", value: order.paidAt },
    { label: "发货时间", value: order.shippedAt },
    { label: "完成时间", value: order.completedAt },
    { label: "取消时间", value: order.cancelledAt },
    { label: "退款时间", value: order.refundedAt },
  ]

  /*
    【时间为什么要用 toLocaleString 而不是自己拼】
    数据库存的是 UTC，Node 和浏览器会按当前时区渲染。
    自己拼字符串很容易漏掉时区换算，导致东八区用户看到的时间差 8 小时。

    【为什么显示绝对时间而不是「还剩 X 分钟」】
    倒计时要在渲染时读当前时间（Date.now()），而 ESLint 的
    react-hooks/purity 禁止在渲染期间调用不纯函数。想做成会走的倒计时，
    得拆客户端组件 + useSyncExternalStore。见 orders/[id]/page.tsx 的注释。
  */
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-xl border p-4 text-sm">
      {entries
        .filter((entry) => entry.value !== null)
        .map((entry) => (
          <div key={entry.label}>
            <dt className="text-muted-foreground">{entry.label}</dt>
            <dd className="tabular-nums">
              {entry.value!.toLocaleString("zh-CN")}
            </dd>
          </div>
        ))}
    </dl>
  )
}
