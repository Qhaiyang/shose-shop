import { describe, expect, it } from "vitest"

import {
  REFUND_REASON,
  REFUND_REASON_LABEL,
  REFUND_STATUS,
  REFUND_STATUS_LABEL,
} from "@/lib/constants"
import {
  calcRefundAmount,
  isRefundDone,
  isRefundPending,
  refundReasonLabel,
  toRefundReason,
  toRefundStatus,
  toRefundView,
  type RefundRow,
} from "@/lib/refunds"

// ============================================================================
// 退款的纯逻辑 —— src/lib/refunds.ts
//
// 【这一组测试存在的唯一理由：把「退多少钱」钉死】
// 退款金额的公式只有一行（就是返回实付），错的可能性看起来很低 ——
// 但它的错法极其隐蔽：
//
//     写对了：799 → 退 79900
//     写成 totalAmount - discountAmount → 退 69900（少退一张券的钱）
//     写成 itemsTotal（原价）          → 退 89900（多退一张券的钱）
//
// 这三个数在**没用券的订单上完全一样**（原价 = 实付 = 无优惠）。
// 也就是说，随手拿个不带券的订单测一下，三种写法都是绿的。
// 只有把「用了券」的那组数字摆出来，才能把它们区分开 ——
// 所以下面全部用需求验收口径里的真实数字。
// ============================================================================

/**
 * 造一笔订单。
 *
 * 默认值就是验收口径里那双鞋：899 元的鞋，用满 800 减 100 的券，实付 799。
 * itemsTotal 不是 Order 上的字段（它是从订单项现加出来的），
 * 这里写出来只是为了让「原价 / 优惠 / 实付」三个数在测试里同时可见 ——
 * 因为把它们搞混正是这组测试要防的事。
 */
function makeOrder(overrides: Partial<{
  totalAmount: number
  discountAmount: number
  itemsTotal: number
}> = {}) {
  return {
    totalAmount: 79900, // 实付
    discountAmount: 10000, // 券减掉的
    itemsTotal: 89900, // 原价
    ...overrides,
  }
}

describe("calcRefundAmount —— 退多少钱", () => {
  it("验收口径：899 的鞋用 100 的券，退 799", () => {
    expect(calcRefundAmount(makeOrder())).toBe(79900)
  })

  it("不是原价：不能退 899", () => {
    // 退原价 = 每笔退款倒贴一张券的面额，账对不上。
    // 这条和上一条一起，把「totalAmount 到底是原价还是实付」钉死 ——
    // 这是本项目里最容易搞反的一处（见 schema.prisma 里的长注释）
    expect(calcRefundAmount(makeOrder())).not.toBe(89900)
  })

  it("不再减一次优惠：不能退 699", () => {
    // 最常见的错误写法：totalAmount - discountAmount。
    // 看起来非常合理 —— 「实付减去优惠」，但本项目的 totalAmount
    // 已经是减完的了，再减一次就是重复扣
    const order = makeOrder()
    expect(calcRefundAmount(order)).not.toBe(
      order.totalAmount - order.discountAmount,
    )
  })

  it("没用券的订单退的就是实付，等于原价", () => {
    const order = makeOrder({
      itemsTotal: 39900,
      discountAmount: 0,
      totalAmount: 39900,
    })
    expect(calcRefundAmount(order)).toBe(39900)
  })

  it("折扣券的场景同样只看实付", () => {
    // 899 的鞋用「9 折最多减 50」→ 减 5000 → 实付 84900
    const order = makeOrder({
      itemsTotal: 89900,
      discountAmount: 5000,
      totalAmount: 84900,
    })
    expect(calcRefundAmount(order)).toBe(84900)
  })

  it("0 元订单退 0（不会算出负数）", () => {
    // 理论上不该存在（券的折扣上限保证实付 > 0），但真出现了
    // 也不能算出一个负数的退款额
    expect(calcRefundAmount({ totalAmount: 0 })).toBe(0)
  })

  it("不需要订单的其他字段 —— 只认 totalAmount", () => {
    // 【为什么要写这条】这个函数将来很可能被人「顺手」加上别的字段
    // （比如扣手续费、扣运费）。真加了要有测试提醒你改这里 ——
    // 当前的设计是：退多少只看实付，一分不多一分不少
    expect(calcRefundAmount({ totalAmount: 12345 })).toBe(12345)
  })
})

// ---------------------------------------------------------------------------
// 收窄 / 文案
// ---------------------------------------------------------------------------

describe("退款原因", () => {
  it("合法的原因原样收窄", () => {
    expect(toRefundReason(REFUND_REASON.SIZE)).toBe(REFUND_REASON.SIZE)
    expect(toRefundReason(REFUND_REASON.QUALITY)).toBe(REFUND_REASON.QUALITY)
  })

  it("每个原因都有中文标签", () => {
    // 漏一个的话，下拉框里会出现一个空白选项
    for (const reason of Object.values(REFUND_REASON)) {
      expect(REFUND_REASON_LABEL[reason]).toBeTruthy()
    }
    expect(refundReasonLabel(REFUND_REASON.SIZE)).toBe("尺码不合适")
  })

  it("脏数据兜底成「其他」，而不是抛异常", () => {
    // 和 toCouponType 同一个取舍：SQLite 没有 enum，为一条角标文案
    // 让整个订单页崩掉不划算
    const dirty: string = "WHATEVER"
    expect(toRefundReason(dirty)).toBe(REFUND_REASON.OTHER)
    expect(refundReasonLabel(dirty)).toBe("其他")
  })
})

describe("退款状态", () => {
  it("合法的状态原样收窄", () => {
    expect(toRefundStatus(REFUND_STATUS.PENDING)).toBe(REFUND_STATUS.PENDING)
    expect(toRefundStatus(REFUND_STATUS.REFUNDED)).toBe(REFUND_STATUS.REFUNDED)
  })

  it("每个状态都有中文标签", () => {
    for (const status of Object.values(REFUND_STATUS)) {
      expect(REFUND_STATUS_LABEL[status]).toBeTruthy()
    }
  })

  it("脏数据兜底成 PENDING —— 宁可让人重新处理一遍，也不能显示成已退款", () => {
    // 【兜底值为什么选 PENDING 而不是别的】
    // 兜底值会被渲染到**管理员的待办列表**里。兜成 REFUNDED 的话，
    // 一条脏数据的退款申请会从待办里消失，钱可能永远不退 ——
    // 而兜成 PENDING 最坏的结果是管理员多点一次，点下去会被
    // WHERE status='PENDING' 拦住，不会有实际损失。安全的默认值
    // 应该偏向「多做一次也无害」的那一边
    const dirty: string = "WHATEVER"
    expect(toRefundStatus(dirty)).toBe(REFUND_STATUS.PENDING)
  })

  it("isRefundPending / isRefundDone 互斥，且覆盖四个状态", () => {
    const rows = [
      [REFUND_STATUS.PENDING, true, false],
      [REFUND_STATUS.APPROVED, false, false], // 中间态：既不是待处理，也还没退完
      [REFUND_STATUS.REJECTED, false, false],
      [REFUND_STATUS.REFUNDED, false, true],
    ] as const

    for (const [status, pending, done] of rows) {
      expect(isRefundPending(status)).toBe(pending)
      expect(isRefundDone(status)).toBe(done)
    }
  })
})

// ---------------------------------------------------------------------------
// 行 → 视图
// ---------------------------------------------------------------------------

describe("toRefundView", () => {
  const row: RefundRow = {
    id: "refund_1",
    orderId: "order_1",
    reason: "SIZE",
    description: "42 码偏大",
    status: "PENDING",
    refundAmount: 79900,
    adminNote: null,
    previousStatus: "PAID",
    createdAt: new Date("2026-10-08T10:00:00Z"),
    processedAt: null,
  }

  it("带上中文标签，页面不用再做收窄", () => {
    const view = toRefundView(row)

    expect(view.reasonLabel).toBe("尺码不合适")
    expect(view.statusLabel).toBe("待处理")
    expect(view.refundAmount).toBe(79900)
  })

  it("原始字段原样透传（包括 null）", () => {
    const view = toRefundView(row)

    expect(view.description).toBe("42 码偏大")
    expect(view.adminNote).toBeNull()
    expect(view.processedAt).toBeNull()
    expect(view.previousStatus).toBe("PAID")
  })

  it("脏数据也不会渲染出 undefined", () => {
    const view = toRefundView({
      ...row,
      reason: "??",
      status: "??",
    })

    expect(view.reasonLabel).toBe("其他")
    expect(view.statusLabel).toBe("待处理")
  })
})
