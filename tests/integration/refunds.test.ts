import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS, REFUND_STATUS } from "@/lib/constants"
import { claimCoupon } from "@/lib/coupons-db"
import { confirmReceipt, createOrderFromCart, payOrder, shipOrder } from "@/lib/orders"
import {
  approveRefund,
  getLatestRefundForOrder,
  listRefundRequests,
  rejectRefund,
  requestRefund,
} from "@/lib/refunds-db"
import {
  addToCart,
  giveCoupon,
  makeCoupon,
  makeOrder,
  makeRefund,
  makeShop,
  makeUser,
  prisma,
  refundStatusOf,
  resetDb,
  resetSeq,
  statusOf,
  stockOf,
  usedCountOf,
} from "./helpers/db"

// ============================================================================
// 退款：申请 / 批准 / 拒绝，以及它们对库存、优惠券、订单状态的影响
//
// 【为什么这一组非打真库不可】
// 退款是这个项目里唯一「动了钱还要回头改别的东西」的功能：
//   1. 两个管理员同时点批准，只能退一次 —— 靠的是
//      UPDATE refund_requests SET status='REFUNDED' WHERE status='PENDING'
//      的影响行数。mock 里没有 SQL，测不出来
//   2. 批准之后要同时改订单状态、还库存、退券，而且必须在一个事务里
//   3. 「退款金额 = 实付」这个数来自订单，不是表单
// 这三个都是数据库层面的性质，单测覆盖不到（那边只测公式）。
//
// 【断言为什么统统用「分」】
// 全站金额都是 Int 分。需求里那句「退款 799 不是 899」在这里应该
// 逐字写成 79900 / 89900
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

const ADDRESS = "北京市朝阳区测试路 1 号"
const PHONE = "13800138000"

/** 需求里那张「满 800 减 100」的券 */
const SAVE100 = { value: 10000, minSpend: 80000 }

/**
 * 造一个「买了鞋、付了钱」的真实订单（走完整下单流程）。
 *
 * 【为什么退款要用真实下单流程，而不是 makeOrder 直接造】
 * 因为「退款金额 = 实付」这个断言的**全部意义**就在于订单上的
 * totalAmount 是券算完之后的结果。用 makeOrder 手工指定 totalAmount，
 * 就等于把这个数自己填进去再断言它是自己填的数 —— 什么都没验证。
 * 走 createOrderFromCart 才能证明：券确实被算进去了，退款拿到的
 * 是那个算完的数。
 */
async function paidOrderWithCoupon(options?: { withCoupon?: boolean }) {
  const shop = await makeShop({ price: 89900, stock: 10 })
  await addToCart(shop.userId, shop.sku.id, 1)

  let couponId: string | null = null
  let userCouponId: string | null = null

  if (options?.withCoupon !== false) {
    const coupon = await makeCoupon({ code: "SAVE100", ...SAVE100 })
    couponId = coupon.id
    await giveCoupon(shop.userId, coupon.id)
    const held = await prisma.userCoupon.findFirstOrThrow({
      where: { userId: shop.userId, couponId: coupon.id },
    })
    userCouponId = held.id
  }

  const created = await createOrderFromCart(shop.userId, {
    address: ADDRESS,
    phone: PHONE,
    note: null,
    userCouponId,
  })

  if (!created.ok) throw new Error(`造订单失败：${created.error}`)

  await payOrder(created.orderId, shop.userId)

  return { ...shop, orderId: created.orderId, couponId, userCouponId }
}

// ---------------------------------------------------------------------------
// 申请
// ---------------------------------------------------------------------------
describe("申请退款", () => {
  it("验收口径：用了 100 元券的订单，申请退款记的是实付 799，不是原价 899", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()

    const result = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: "42 码偏大",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 899 的鞋用满 800 减 100 → 实付 799 → 退 799
    expect(result.refundAmount).toBe(79900)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.totalAmount).toBe(79900) // 订单上存的本来就是实付
    expect(order.discountAmount).toBe(10000)

    const refund = await prisma.refundRequest.findFirstOrThrow({
      where: { orderId },
    })
    expect(refund.refundAmount).toBe(79900)
    expect(refund.previousStatus).toBe(ORDER_STATUS.PAID)
    expect(refund.status).toBe(REFUND_STATUS.PENDING)
  })

  it("申请后订单进入 REFUNDING", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()

    await requestRefund({ orderId, userId, reason: "REGRET", description: null })

    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDING)
  })

  it("没用券的订单，退款金额就是原价（两者本来就相等）", async () => {
    const { userId, orderId } = await paidOrderWithCoupon({ withCoupon: false })

    const result = await requestRefund({
      orderId,
      userId,
      reason: "QUALITY",
      description: null,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.refundAmount).toBe(89900)
  })

  it("已发货的订单也能申请退款（SHIPPED → REFUNDING）", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    await shipOrder(orderId)

    const result = await requestRefund({
      orderId,
      userId,
      reason: "REGRET",
      description: "还没收到就不想要了",
    })

    expect(result.ok).toBe(true)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDING)

    const refund = await prisma.refundRequest.findFirstOrThrow({ where: { orderId } })
    expect(refund.previousStatus).toBe(ORDER_STATUS.SHIPPED)
  })

  it("已完成的订单也能申请退款（COMPLETED → REFUNDING）", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    await shipOrder(orderId)
    await confirmReceipt(orderId, userId)

    const result = await requestRefund({
      orderId,
      userId,
      reason: "QUALITY",
      description: "穿了两次开胶了",
    })

    expect(result.ok).toBe(true)

    const refund = await prisma.refundRequest.findFirstOrThrow({ where: { orderId } })
    expect(refund.previousStatus).toBe(ORDER_STATUS.COMPLETED)
  })

  it("待支付的订单不能申请退款（该走取消）", async () => {
    const shop = await makeShop()
    const order = await makeOrder({
      userId: shop.userId,
      status: ORDER_STATUS.PENDING_PAYMENT,
    })

    const result = await requestRefund({
      orderId: order.id,
      userId: shop.userId,
      reason: "REGRET",
      description: null,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("待支付")
    // 状态一点没动
    expect(await statusOf(order.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
    expect(await prisma.refundRequest.count()).toBe(0)
  })

  it("已取消的订单不能申请退款", async () => {
    const shop = await makeShop()
    const order = await makeOrder({
      userId: shop.userId,
      status: ORDER_STATUS.CANCELLED,
    })

    const result = await requestRefund({
      orderId: order.id,
      userId: shop.userId,
      reason: "REGRET",
      description: null,
    })

    expect(result.ok).toBe(false)
    expect(await prisma.refundRequest.count()).toBe(0)
  })

  it("退款处理中不能重复申请", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()

    const first = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    expect(first.ok).toBe(true)

    const second = await requestRefund({
      orderId,
      userId,
      reason: "QUALITY",
      description: null,
    })

    expect(second.ok).toBe(false)
    // 只留了一条记录，而且状态没被第二次申请动过
    expect(await prisma.refundRequest.count({ where: { orderId } })).toBe(1)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDING)
  })

  it("不能替别人的订单申请退款", async () => {
    const { orderId } = await paidOrderWithCoupon()
    const stranger = await makeUser()

    const result = await requestRefund({
      orderId,
      userId: stranger.id,
      reason: "REGRET",
      description: null,
    })

    // 【为什么错误文案是「订单不存在」而不是「这不是你的订单」】
    // 说「不是你的」等于承认「这个 id 是有效的」——
    // 攻击者可以拿它来枚举订单号。不区分两者，就什么都探测不到
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("订单不存在")
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.PAID)
    expect(await prisma.refundRequest.count()).toBe(0)
  })

  it("并发申请同一张订单，只留一条申请", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()

    // 用户手抖点了两下 / 两个标签页各点了一次
    const results = await Promise.all([
      requestRefund({ orderId, userId, reason: "SIZE", description: "第一次" }),
      requestRefund({ orderId, userId, reason: "QUALITY", description: "第二次" }),
      requestRefund({ orderId, userId, reason: "OTHER", description: "第三次" }),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await prisma.refundRequest.count({ where: { orderId } })).toBe(1)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDING)
  })

  it("查最近一次申请时也带归属校验", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    await requestRefund({ orderId, userId, reason: "SIZE", description: null })

    expect(await getLatestRefundForOrder(orderId, userId)).not.toBeNull()

    const stranger = await makeUser()
    expect(await getLatestRefundForOrder(orderId, stranger.id)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 批准
// ---------------------------------------------------------------------------
describe("批准退款", () => {
  it("验收口径：899 的鞋用 100 的券，批准后实际退 799", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    const result = await approveRefund(applied.refundId, null)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.refundAmount).toBe(79900)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe(ORDER_STATUS.REFUNDED)
    expect(order.refundedAt).toBeInstanceOf(Date)
  })

  it("库存 +1、券回到未使用、usedCount -1", async () => {
    const { userId, orderId, sku, couponId, userCouponId } =
      await paidOrderWithCoupon()

    // 下单时：库存 10 → 9，券被核销
    expect(await stockOf(sku.id)).toBe(9)
    expect(await usedCountOf(couponId!)).toBe(1)

    const applied = await requestRefund({
      orderId,
      userId,
      reason: "REGRET",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")
    await approveRefund(applied.refundId, null)

    // 退款后：库存回来了，券也回来了
    expect(await stockOf(sku.id)).toBe(10)
    expect(await usedCountOf(couponId!)).toBe(0)

    const held = await prisma.userCoupon.findUniqueOrThrow({
      where: { id: userCouponId! },
    })
    expect(held.usedAt).toBeNull()
    expect(held.orderId).toBeNull()
  })

  it("已发货的订单退款后，库存照样加回来（这点和取消订单相反）", async () => {
    // 【这条是本组最有价值的断言】
    // 取消订单时 shouldRestoreStock(SHIPPED) 是 false —— 货在路上，不动库存。
    // 但退款不一样：钱都退了，货是平台的，库存必须回来。
    // 同一个状态、两个相反的结论，正是第 7 步把闸门从函数里挪到调用点的原因
    const { userId, orderId, sku } = await paidOrderWithCoupon()
    await shipOrder(orderId)
    expect(await stockOf(sku.id)).toBe(9)

    const applied = await requestRefund({
      orderId,
      userId,
      reason: "REGRET",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")
    await approveRefund(applied.refundId, null)

    expect(await stockOf(sku.id)).toBe(10)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDED)
  })

  it("并发批准同一单，只成功一次", async () => {
    const { userId, orderId, sku, couponId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    // 两个管理员同时点了「批准」
    const [a, b] = await Promise.all([
      approveRefund(applied.refundId, null),
      approveRefund(applied.refundId, null),
    ])

    expect([a, b].filter((r) => r.ok)).toHaveLength(1)

    // 【为什么最要紧的是这几条断言，而不是上面那条】
    // 「只成功一次」如果只靠返回值判断，写法错的时候（比如先查后改）
    // 可能两个都返回成功，也可能一个成功但钱退了两遍。
    // 这几条看的是**副作用发生了多少次**：库存只能回一次（10 而不是 11），
    // usedCount 只能减一次（0 而不是 -1）
    expect(await stockOf(sku.id)).toBe(10)
    expect(await usedCountOf(couponId!)).toBe(0)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDED)
  })

  it("批准金额以订单实付为准，不信申请时的快照", async () => {
    const { orderId, userId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    // 手工把快照改成一个很离谱的数（模拟数据被改过）
    await prisma.refundRequest.update({
      where: { id: applied.refundId },
      data: { refundAmount: 1 },
    })

    const result = await approveRefund(applied.refundId, null)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.refundAmount).toBe(79900)

    // 记录也被对齐了 —— 后台看到的退款金额和实际退的钱必须一致
    const refund = await prisma.refundRequest.findUniqueOrThrow({
      where: { id: applied.refundId },
    })
    expect(refund.refundAmount).toBe(79900)
  })

  it("订单不在 REFUNDING 时批准会被拒绝", async () => {
    const { orderId, userId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    // 模拟「数据前后不一致」：订单被别的东西改走了，退款单还停在待处理
    await prisma.order.update({
      where: { id: orderId },
      data: { status: ORDER_STATUS.SHIPPED },
    })

    const result = await approveRefund(applied.refundId, null)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("已发货")
    // 整条事务回滚：退款单的抢占也得撤销，否则它会永远卡在「已退款」
    // 但订单没退的状态上，谁也修不回来
    expect(await refundStatusOf(applied.refundId)).toBe(REFUND_STATUS.PENDING)
  })

  it("已经被处理过的退款单不能再批准", async () => {
    const { orderId, userId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    await approveRefund(applied.refundId, null)
    const second = await approveRefund(applied.refundId, null)

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toContain("已经被处理过")
  })

  it("随机 id 批准返回失败，而不是抛异常", async () => {
    const result = await approveRefund("not-a-real-id", null)
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 拒绝
// ---------------------------------------------------------------------------
describe("拒绝退款", () => {
  it("验收口径：拒绝后订单回到申请前的状态，买家能看到理由", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDING)

    const result = await rejectRefund(applied.refundId, "鞋子已穿过，影响二次销售")
    expect(result.ok).toBe(true)

    // 订单回到 PAID —— 管理员界面上「发货」按钮又会回来
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.PAID)

    const refund = await prisma.refundRequest.findUniqueOrThrow({
      where: { id: applied.refundId },
    })
    expect(refund.status).toBe(REFUND_STATUS.REJECTED)
    expect(refund.adminNote).toBe("鞋子已穿过，影响二次销售")
    expect(refund.processedAt).toBeInstanceOf(Date)

    // 买家看得到
    const view = await getLatestRefundForOrder(orderId, userId)
    expect(view?.statusLabel).toBe("已拒绝")
    expect(view?.adminNote).toBe("鞋子已穿过，影响二次销售")
  })

  it("不会碰库存和优惠券（这笔交易照旧）", async () => {
    const { userId, orderId, sku, couponId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    await rejectRefund(applied.refundId, "不符合条件")

    // 库存和券都保持「这笔交易已经发生」的样子 —— 什么都没补偿，
    // 因为拒绝等于什么都没发生过
    expect(await stockOf(sku.id)).toBe(9)
    expect(await usedCountOf(couponId!)).toBe(1)
  })

  it("已发货的订单被拒后退回「已发货」，不是「已支付」", async () => {
    // 【为什么这条必须单独写】退回固定状态（比如一律退回 PAID）的实现
    // 也能让上面那条验收用例通过，但会让一个已经发出的包裹在后台
    // 重新出现「发货」按钮 —— 同一件货发两次
    const { userId, orderId } = await paidOrderWithCoupon()
    await shipOrder(orderId)

    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    await rejectRefund(applied.refundId, "图片不足以证明质量问题")

    expect(await statusOf(orderId)).toBe(ORDER_STATUS.SHIPPED)
  })

  it("已完成的订单被拒后退回「已完成」", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    await shipOrder(orderId)
    await confirmReceipt(orderId, userId)

    const applied = await requestRefund({
      orderId,
      userId,
      reason: "QUALITY",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    await rejectRefund(applied.refundId, "超过 7 天无理由期限")

    expect(await statusOf(orderId)).toBe(ORDER_STATUS.COMPLETED)
  })

  it("被拒之后买家可以再次申请，历史留两条", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()

    const first = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: "第一次",
    })
    if (!first.ok) throw new Error("第一次申请失败")
    await rejectRefund(first.refundId, "资料不足")

    // 订单回到了 PAID，所以还能再申请 —— 这正是 orderId 不加唯一约束的原因
    const second = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: "补了照片",
    })
    expect(second.ok).toBe(true)
    expect(second.ok && second.refundId).not.toBe(first.refundId)

    // 两条历史，最近一条是新的待处理
    const history = await prisma.refundRequest.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    })
    expect(history).toHaveLength(2)
    expect(history[0].status).toBe(REFUND_STATUS.REJECTED)
    expect(history[1].status).toBe(REFUND_STATUS.PENDING)

    // 列表/详情页显示的是最近一条（待处理），不是被拒的那条
    const view = await getLatestRefundForOrder(orderId, userId)
    expect(view?.status).toBe(REFUND_STATUS.PENDING)
    expect(view?.description).toBe("补了照片")
  })

  it("并发拒绝同一单，只成功一次", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    const [a, b] = await Promise.all([
      rejectRefund(applied.refundId, "理由 A"),
      rejectRefund(applied.refundId, "理由 B"),
    ])

    expect([a, b].filter((r) => r.ok)).toHaveLength(1)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.PAID)
  })

  it("一边批准一边拒绝，只有一边能成", async () => {
    const { userId, orderId, sku, couponId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")

    const [approved, rejected] = await Promise.all([
      approveRefund(applied.refundId, null),
      rejectRefund(applied.refundId, "不同意"),
    ])

    expect([approved, rejected].filter((r) => r.ok)).toHaveLength(1)

    // 【这条断言的意思是「世界没有处于半拉子状态」】
    // 不管谁赢了，结果都必须是自洽的：要么退成了（订单 REFUNDED、
    // 库存回来、券回来），要么没退成（订单回 PAID、库存和券不动）。
    // 最怕的是「订单 REFUNDED 但库存没回来」这种中间态
    const status = await statusOf(orderId)
    const stock = await stockOf(sku.id)
    const used = await usedCountOf(couponId!)

    if (status === ORDER_STATUS.REFUNDED) {
      expect(stock).toBe(10)
      expect(used).toBe(0)
    } else {
      expect(status).toBe(ORDER_STATUS.PAID)
      expect(stock).toBe(9)
      expect(used).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 退款之后：其他动作都该被挡住
// ---------------------------------------------------------------------------
describe("退款后的订单不能再走别的流程", () => {
  it("退款中的订单不能发货（WHERE 条件自动拦下）", async () => {
    // 【这是既有设计的红利】shipOrder 的 updateMany 里带着
    // status = 'PAID'，REFUNDING 的订单天然不匹配 ——
    // 加退款这个功能时，发货那条路一行代码都没动
    const { userId, orderId } = await paidOrderWithCoupon()
    await requestRefund({ orderId, userId, reason: "SIZE", description: null })

    const result = await shipOrder(orderId)

    expect(result.ok).toBe(false)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDING)
  })

  it("已退款的订单不能发货、也不能确认收货", async () => {
    const { userId, orderId } = await paidOrderWithCoupon()
    const applied = await requestRefund({
      orderId,
      userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")
    await approveRefund(applied.refundId, null)

    expect((await shipOrder(orderId)).ok).toBe(false)
    expect((await confirmReceipt(orderId, userId)).ok).toBe(false)
    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDED)
  })

  it("退款流程不会被超时扫描误伤", async () => {
    // 【为什么要专门测这个】cancelExpiredOrders 只扫 PENDING_PAYMENT，
    // 而退款是从 PAID 起步的。万一哪天有人把那条件放宽，
    // 一笔正在退款的订单会被当成「超时未支付」取消掉 ——
    // 券和库存被退两次，而且订单变成 CANCELLED，退款流程彻底断掉
    const { userId, orderId } = await paidOrderWithCoupon()
    await requestRefund({ orderId, userId, reason: "SIZE", description: null })

    const { cancelExpiredOrders } = await import("@/lib/orders")
    await cancelExpiredOrders({ userId })

    expect(await statusOf(orderId)).toBe(ORDER_STATUS.REFUNDING)
  })
})

// ---------------------------------------------------------------------------
// 后台列表
// ---------------------------------------------------------------------------
describe("后台退款列表", () => {
  it("按 tab 分开待处理和已处理", async () => {
    const shop = await makeShop()
    const admin = await makeUser()

    // 三张订单，分别造出三种退款单（直接造，不走申请流程 ——
    // 这里考察的是列表的筛选，不是申请）
    const pendingOrder = await makeOrder({ userId: shop.userId })
    const refundedOrder = await makeOrder({ userId: shop.userId })
    const rejectedOrder = await makeOrder({ userId: shop.userId })

    await makeRefund({
      orderId: pendingOrder.id,
      userId: shop.userId,
      status: REFUND_STATUS.PENDING,
    })
    await makeRefund({
      orderId: refundedOrder.id,
      userId: shop.userId,
      status: REFUND_STATUS.REFUNDED,
    })
    await makeRefund({
      orderId: rejectedOrder.id,
      userId: shop.userId,
      status: REFUND_STATUS.REJECTED,
    })

    const pending = await listRefundRequests({ tab: "pending" })
    const processed = await listRefundRequests({ tab: "processed" })

    expect(pending).toHaveLength(1)
    expect(pending[0].orderId).toBe(pendingOrder.id)

    expect(processed).toHaveLength(2)
    expect(processed.map((r) => r.status).sort()).toEqual([
      REFUND_STATUS.REFUNDED,
      REFUND_STATUS.REJECTED,
    ])

    // 带上买家和订单信息，页面不用再查
    expect(pending[0].buyer.id).toBe(shop.userId)
    expect(pending[0].order.orderNo).toBeTruthy()

    expect(admin.id).toBeTruthy() // 列表本身不校验权限，权限在 action 层
  })

  it("不传 tab 时返回全部", async () => {
    const shop = await makeShop()
    const order = await makeOrder({ userId: shop.userId })
    await makeRefund({ orderId: order.id, userId: shop.userId })

    expect(await listRefundRequests({})).toHaveLength(1)
  })

  it("按提交时间倒序", async () => {
    const shop = await makeShop()
    const older = await makeOrder({ userId: shop.userId })
    const newer = await makeOrder({ userId: shop.userId })

    const first = await makeRefund({ orderId: older.id, userId: shop.userId })
    const second = await makeRefund({ orderId: newer.id, userId: shop.userId })

    const rows = await listRefundRequests({ tab: "pending" })

    // 最新的排在最前面，管理员一打开看到的就是刚提交的那些
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id])
  })
})

// ---------------------------------------------------------------------------
// 领券 / 用券链路和退款的衔接
// ---------------------------------------------------------------------------
describe("券的完整生命周期", () => {
  it("领券 → 用券 → 退款 → 券回到未使用，可以再用一次", async () => {
    const shop = await makeShop({ price: 89900, stock: 10 })
    const coupon = await makeCoupon({ code: "SAVE100", ...SAVE100 })
    await giveCoupon(shop.userId, coupon.id)

    const held = await prisma.userCoupon.findFirstOrThrow({
      where: { userId: shop.userId, couponId: coupon.id },
    })

    // ---- 第一次用 ----
    await addToCart(shop.userId, shop.sku.id, 1)
    const first = await createOrderFromCart(shop.userId, {
      address: ADDRESS,
      phone: PHONE,
      note: null,
      userCouponId: held.id,
    })
    if (!first.ok) throw new Error(first.error)
    await payOrder(first.orderId, shop.userId)

    expect(await usedCountOf(coupon.id)).toBe(1)

    // ---- 退款 ----
    const applied = await requestRefund({
      orderId: first.orderId,
      userId: shop.userId,
      reason: "SIZE",
      description: null,
    })
    if (!applied.ok) throw new Error("申请失败")
    await approveRefund(applied.refundId, null)

    expect(await usedCountOf(coupon.id)).toBe(0)

    // ---- 再用一次：这张券确实回到了「未使用」，不是只减了个计数 ----
    await addToCart(shop.userId, shop.sku.id, 1)
    const second = await createOrderFromCart(shop.userId, {
      address: ADDRESS,
      phone: PHONE,
      note: null,
      userCouponId: held.id,
    })

    expect(second.ok).toBe(true)
    if (second.ok) {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: second.orderId },
      })
      // 又减了 100，说明券是真的能用了
      expect(order.totalAmount).toBe(79900)
    }
    expect(await usedCountOf(coupon.id)).toBe(1)
  })

  it("领券接口本身不受影响（回归）", async () => {
    // 第 7 步动了 constants.ts 里一大片东西，顺手确认券的链路没被碰坏
    const user = await makeUser()
    const coupon = await makeCoupon({ perUserLimit: 1 })

    expect((await claimCoupon(user.id, coupon.id)).ok).toBe(true)
    expect((await claimCoupon(user.id, coupon.id)).ok).toBe(false)
  })
})
