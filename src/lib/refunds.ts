import {
  REFUND_REASON,
  REFUND_REASON_LABEL,
  REFUND_REASON_VALUES,
  REFUND_STATUS,
  REFUND_STATUS_LABEL,
  REFUND_STATUS_VALUES,
  type RefundReason,
  type RefundStatus,
} from "@/lib/constants"

// ============================================================================
// 退款的纯逻辑
//
// 【为什么这个文件里没有一句 Prisma】
// 和 src/lib/coupons.ts 是同一个理由（见那里的注释）：这些函数要在
// **客户端组件里**用（订单详情页要显示「预计退款 ¥799」、要把原因键
// 翻成中文）。只要这个文件间接 import 了 @/lib/prisma，客户端 bundle
// 里就会拖进 node:fs，构建直接报 "Can't resolve 'fs'"。
//
// 所以规矩是：
//   - 算数、映射、判断 → 这里（纯函数，浏览器也能跑）
//   - 查库、改状态、事务 → src/lib/refunds-db.ts（只有服务端会 import）
// ============================================================================

/**
 * 退款金额 = 这笔订单的**实付**金额。
 *
 * 【为什么单独抽一个函数，而不是直接写 order.totalAmount】
 * 因为这个公式看起来「太平凡了」，平凡到将来有人会觉得可以直接手写，
 * 然后写成 `order.totalAmount - order.discountAmount` ——
 * 一个非常自然、非常错的直觉：看到「实付」和「优惠」两个字段，
 * 很自然会以为 totalAmount 是原价。
 *
 * 但本项目里 Order.totalAmount 存的**就是实付**（原价 - 优惠），
 * 见 schema.prisma 里那段长注释。再减一次 discountAmount
 * 就变成「花了 799 却退 699」，而且这个 bug 在没用券的订单上
 * 完全看不出来 —— 只有用了券的那几单会少退钱，最难发现的那一类。
 *
 * 抽成函数是为了让 tests/unit/refund.test.ts 能钉住这个数：
 * 899 − 100 = 799，不是 899，也不是 699。
 *
 * 【为什么不退原价（899）】
 * 平台只收到了 799。退 899 等于每笔退款倒贴一张券的面额，
 * 那不是「大方」，是账对不上。券是平台给的优惠，退款要把优惠一起退掉。
 * （至于券本身要不要还 —— 要，见 refunds-db.ts 里的回滚逻辑。）
 */
export function calcRefundAmount(order: { totalAmount: number }): number {
  return order.totalAmount
}

/**
 * 从数据库读出来的 String 收窄成 RefundReason。
 *
 * 兜底成 OTHER 而不是抛异常：SQLite 没有 enum，理论上有脏数据的可能。
 * 为了一个角标文案让整个订单页崩掉不划算 —— 显示成「其他」，
 * 至少页面是能看的。（和 toCouponType 的取舍一致。）
 */
export function toRefundReason(value: string): RefundReason {
  return REFUND_REASON_VALUES.includes(value as RefundReason)
    ? (value as RefundReason)
    : REFUND_REASON.OTHER
}

/** 原因键 → 中文。未知值走兜底，不会渲染出 undefined */
export function refundReasonLabel(value: string): string {
  return REFUND_REASON_LABEL[toRefundReason(value)]
}

/** 从数据库读出来的 String 收窄成 RefundStatus */
export function toRefundStatus(value: string): RefundStatus {
  return REFUND_STATUS_VALUES.includes(value as RefundStatus)
    ? (value as RefundStatus)
    : REFUND_STATUS.PENDING
}

/** 退款状态 → 中文 */
export function refundStatusLabel(value: string): string {
  return REFUND_STATUS_LABEL[toRefundStatus(value)]
}

/**
 * 这次退款申请还在等管理员吗？
 *
 * 【为什么单独写一个函数而不是到处写 status === "PENDING"】
 * 因为「待处理」这个判断散落在三个地方：买家看到「退款处理中」的提示、
 * 买家能不能再次申请、后台列表归到哪个 tab。三处各写一遍字符串比较，
 * 将来加个中间态（比如网关退款中的 PROCESSING）就会漏掉一处，
 * 表现是「后台看得见、买家页面显示空白」这种半死不活的状态。
 */
export function isRefundPending(status: string): boolean {
  return toRefundStatus(status) === REFUND_STATUS.PENDING
}

/** 退款已完成（钱退回去了）吗 */
export function isRefundDone(status: string): boolean {
  return toRefundStatus(status) === REFUND_STATUS.REFUNDED
}

// ---------------------------------------------------------------------------
// 给页面看的形状
// ---------------------------------------------------------------------------

/**
 * 一次退款申请，转成页面直接能用的形状。
 *
 * 【为什么要有 reasonLabel / statusLabel 这两个「多余」的字段】
 * 因为组件里写 `REFUND_REASON_LABEL[toRefundReason(row.reason)]` 这种
 * 嵌套调用，抄第二遍的时候很容易漏掉里面那层收窄 —— 表现出来就是
 * 数据库里冒出一个脏值时页面显示 undefined。在这里转换一次，
 * 组件只管渲染。
 */
export type RefundView = {
  id: string
  orderId: string
  reason: RefundReason
  reasonLabel: string
  description: string | null
  status: RefundStatus
  statusLabel: string
  /** 退款金额（分）。批准之后看这个数就是实际退回去的钱 */
  refundAmount: number
  adminNote: string | null
  previousStatus: string
  createdAt: Date
  processedAt: Date | null
}

/** 退款行的原始形状。字段和 RefundRequest 模型一一对应 */
export type RefundRow = {
  id: string
  orderId: string
  reason: string
  description: string | null
  status: string
  refundAmount: number
  adminNote: string | null
  previousStatus: string
  createdAt: Date
  processedAt: Date | null
}

export function toRefundView(row: RefundRow): RefundView {
  return {
    id: row.id,
    orderId: row.orderId,
    reason: toRefundReason(row.reason),
    reasonLabel: refundReasonLabel(row.reason),
    description: row.description,
    status: toRefundStatus(row.status),
    statusLabel: refundStatusLabel(row.status),
    refundAmount: row.refundAmount,
    adminNote: row.adminNote,
    previousStatus: row.previousStatus,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  }
}
