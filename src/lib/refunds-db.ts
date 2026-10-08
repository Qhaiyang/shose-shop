import {
  canTransition,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  REFUND_STATUS,
  REFUNDABLE_STATUSES,
  type OrderStatus,
} from "@/lib/constants"
import {
  restoreCouponForOrder,
  restoreStockForOrder,
  type OrderSummary,
} from "@/lib/orders"
import { prisma } from "@/lib/prisma"
import {
  calcRefundAmount,
  toRefundView,
  type RefundView,
} from "@/lib/refunds"

// ============================================================================
// 退款：查库 + 改状态（服务端专用）
//
// 【为什么和 src/lib/refunds.ts 分开】
// 那个文件里的东西要在客户端组件里用（订单页要显示「预计退款 ¥799」），
// 只要它间接 import 了 @/lib/prisma，客户端 bundle 里就会拖进 node:fs，
// 构建直接报 "Can't resolve 'fs'"。所以：
//   refunds.ts    —— 纯函数，元角分换算、状态收窄、金额公式
//   refunds-db.ts —— 这个文件，碰数据库的都在这里
//
// 【整个模块的核心是「条件更新」】
// 退款是所有业务里并发最尖锐的地方：两个管理员同时点「批准」，
// 只能退一次钱。做法和下单扣库存完全一样 —— 把「现在是什么状态」
// 塞进 UPDATE 的 WHERE，让数据库来裁决：
//
//     UPDATE refund_requests SET status='REFUNDED' WHERE id=? AND status='PENDING'
//     UPDATE orders          SET status='REFUNDED' WHERE id=? AND status='REFUNDING'
//
// 影响行数 0 就是「有人先下手了」。**不要**写成
// 「先 findUnique 查状态、if 判断、再 update」—— 那个写法在并发下
// 会两个请求都读到 PENDING，然后退两次钱。
// ============================================================================

/** 退款操作的结果。和 shipOrder 那套 { ok } 形状保持一致，方便 action 直接透传 */
export type RefundResult =
  | { ok: true; refundId: string; refundAmount: number }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// 买家：申请退款
// ---------------------------------------------------------------------------

/**
 * 买家提交退款申请。
 *
 * 【为什么 userId 是必填参数，而不是「先从 orderId 查出订单再自己判断」】
 * 查询条件写成 `where: { id, userId }`，越权就变成了「查不到」，
 * 而不是「查到了但我不许你看」—— 后者只要有一处忘了判断就是漏洞。
 * 这条规矩在 getOrderDetail 的注释里写过，退款这里一模一样。
 *
 * 【金额为什么要快照一份】
 * 页面上要显示「预计退款 ¥799」，用户提交时就把这个数记下来，
 * 将来客服复盘能看出「他申请时看到的是多少」。但**批准时不用它**，
 * 见 approveRefund —— 真正退多少钱以批准那一刻的订单实付为准。
 */
export async function requestRefund(input: {
  orderId: string
  userId: string
  reason: string
  description: string | null
}): Promise<RefundResult> {
  const { orderId, userId, reason, description } = input

  return prisma.$transaction(async (tx) => {
    // ---- 1. 读出订单（带 userId 条件 = 越权直接查不到）----
    const order = await tx.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, status: true, totalAmount: true },
    })

    if (!order) return { ok: false, error: "订单不存在" }

    const status = order.status as OrderStatus

    // ---- 2. 状态白名单 ----
    // 待支付的订单该走「取消」而不是「退款」（钱还没收，退什么）；
    // 已经在退款中的订单不能重复申请；已取消/已退款是终态。
    if (!REFUNDABLE_STATUSES.includes(status)) {
      return {
        ok: false,
        error: `订单${ORDER_STATUS_LABEL[status] ?? "当前状态"}，不能申请退款`,
      }
    }

    // ---- 3. 抢占：把订单推进 REFUNDING ----
    // where 里的 status 是**刚读到的那个状态**，不是 REFUNDABLE_STATUSES。
    // 差别在于：如果这中间管理员刚好发了货（PAID → SHIPPED），
    // 用「in 三个状态」当条件仍然会命中，于是我们把 previousStatus
    // 记成了 PAID —— 万一以后被拒绝，订单会被退回一个它从没待过的状态，
    // 买家会看到「已支付」，而货其实已经在路上了。
    // 钉死成读到的那个值，这种情况直接 count = 0，让用户重试。
    const claimed = await tx.order.updateMany({
      where: { id: order.id, userId, status },
      data: { status: ORDER_STATUS.REFUNDING },
    })

    if (claimed.count === 0) {
      return { ok: false, error: "订单状态刚刚变了，请刷新后重试" }
    }

    // ---- 4. 记一次申请 ----
    // 【为什么这里可以直接 create，不用再防一遍重】
    // 因为「防重」已经由上面那条 updateMany 完成了：只有把订单从
    // 可退状态推进 REFUNDING 成功的那个请求，才会走到这一行。
    // 并发的第二个请求在 updateMany 就 count = 0 返回了。
    // 所以 orderId 才敢不加唯一约束（加了的话，被拒后重新申请就插不进去了）
    const refund = await tx.refundRequest.create({
      data: {
        orderId: order.id,
        userId,
        reason,
        description,
        status: REFUND_STATUS.PENDING,
        // 快照：这一刻的实付（= 内层函数算出来的数，不是原价）
        refundAmount: calcRefundAmount(order),
        previousStatus: status,
      },
      select: { id: true, refundAmount: true },
    })

    return { ok: true, refundId: refund.id, refundAmount: refund.refundAmount }
  })
}

// ---------------------------------------------------------------------------
// 买家：查这一单最近一次退款
// ---------------------------------------------------------------------------

/** 退款行的固定字段清单。三处查询共用，避免抄漏字段 */
export const REFUND_SELECT = {
  id: true,
  orderId: true,
  reason: true,
  description: true,
  status: true,
  refundAmount: true,
  adminNote: true,
  previousStatus: true,
  createdAt: true,
  processedAt: true,
} as const

/**
 * 查某个订单最近一次的退款申请。
 *
 * 【为什么要带 userId】
 * 和 getOrderDetail 同一个理由：不加条件就等于「知道订单 id 就能看别人
 * 的退款理由和金额」。这里的调用方（订单详情页）确实已经校验过归属，
 * 但那正是最危险的情况 —— 「反正上面查过了」这种想法一旦成立，
 * 迟早会有一个调用方不再查。把条件写死在查询里，谁调用都安全。
 *
 * 【为什么取的是最近一条而不是「未处理的那条」】
 * 页面要显示的东西有三种：处理中的申请、被拒的理由（用户好知道为什么
 * 被拒、能不能再申请）、已退款的信息。全都是「最近一条」能覆盖的。
 */
export async function getLatestRefundForOrder(
  orderId: string,
  userId: string,
): Promise<RefundView | null> {
  const row = await prisma.refundRequest.findFirst({
    where: { orderId, userId },
    orderBy: { createdAt: "desc" },
    select: REFUND_SELECT,
  })

  return row ? toRefundView(row) : null
}

// ---------------------------------------------------------------------------
// 管理员：列表 / 详情
// ---------------------------------------------------------------------------

/** 退款状态 → 是不是「等待管理员处理」。列表的两个 tab 就按它分 */
const PENDING_STATUSES: string[] = [REFUND_STATUS.PENDING]

export type RefundListItem = RefundView & {
  order: OrderSummary
  buyer: { id: string; name: string; email: string }
}

/**
 * 后台退款列表。
 *
 * 【为什么分页先不做】
 * 练手阶段退款单量不会大，一次查 100 条足够把界面和逻辑跑通。
 * 真做分页要引出另外几个问题（第几页、总数怎么算、翻页时数据变了怎么办），
 * 那些是「分页」这个题目的事，不是「退款」这个题目的事 ——
 * 混在一起做，两边都会做得半生不熟。
 * 但 limit 是显式传进来的，将来加「下一页」不用改这个函数的形状。
 */
export async function listRefundRequests(options: {
  /** "pending" 只看待处理，"processed" 只看已处理，不传则全部 */
  tab?: "pending" | "processed"
  limit?: number
}): Promise<RefundListItem[]> {
  const limit = options.limit ?? 100

  // 【为什么用 notIn 表达「已处理」而不是 in: [REFUNDED, REJECTED]】
  // 用 in 的话，将来加一个新状态（比如网关退款中的 PROCESSING）
  // 它会既不在「待处理」也不在「已处理」里 —— 后台两个 tab 都看不见它，
  // 一单钱卡在中间没人知道。写成「不是 PENDING 的都算已处理」，
  // 新状态至少会出现在列表里被人看到。
  const statusFilter =
    options.tab === "pending"
      ? { in: PENDING_STATUSES }
      : options.tab === "processed"
        ? { notIn: PENDING_STATUSES }
        : undefined

  const rows = await prisma.refundRequest.findMany({
    where: statusFilter ? { status: statusFilter } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      ...REFUND_SELECT,
      order: {
        select: {
          id: true,
          orderNo: true,
          status: true,
          totalAmount: true,
          createdAt: true,
          expiresAt: true,
          user: { select: { id: true, name: true, email: true } },
          items: {
            select: {
              quantity: true,
              sku: { select: { product: { select: { images: true } } } },
            },
          },
        },
      },
    },
  })

  return rows.map((row) => ({
    ...toRefundView(row),
    order: toOrderSummary(row.order),
    buyer: row.order.user,
  }))
}

/**
 * 退款申请详情（管理员视角）。
 *
 * 【为什么要单独一个函数，而不是「列表 + 按 id 从列表里找」】
 * 详情页是个可以直接输 URL 打开的页面，必须能按 id 独立查询。
 *
 * 【这里为什么没有 userId 条件】
 * 管理员本来就该看所有用户的退款单。权限由 requireAdmin() 在 action /
 * 页面层把关 —— 但那是**另一个**层次的事，别和「归属校验」混起来：
 * 买家那边的查询永远带 userId，管理员这边的查询永远不带。
 * 两种意图写成两个函数，看代码的人一眼就知道自己在写哪一种。
 */
export async function getRefundDetailForAdmin(
  refundId: string,
): Promise<(RefundView & { order: OrderSummary & { buyer: { id: string; name: string; email: string } } }) | null> {
  const row = await prisma.refundRequest.findUnique({
    where: { id: refundId },
    select: {
      ...REFUND_SELECT,
      order: {
        select: {
          id: true,
          orderNo: true,
          status: true,
          totalAmount: true,
          createdAt: true,
          expiresAt: true,
          user: { select: { id: true, name: true, email: true } },
          items: {
            select: {
              quantity: true,
              sku: { select: { product: { select: { images: true } } } },
            },
          },
        },
      },
    },
  })

  if (!row) return null

  const { user, ...order } = row.order
  return { ...toRefundView(row), order: { ...toOrderSummary(order), buyer: user } }
}

export type RefundOrderRow = {
  id: string
  orderNo: string
  status: string
  totalAmount: number
  createdAt: Date
  expiresAt: Date
  items: {
    quantity: number
    sku: { product: { images: string } } | null
  }[]
}

/** 订单摘要：列表里要显示的最小信息（单号、状态、金额、缩略图、件数） */
function toOrderSummary(order: RefundOrderRow): OrderSummary {
  let cover: string | null = null
  let totalQuantity = 0

  for (const item of order.items) {
    totalQuantity += item.quantity
    if (cover) continue
    // 第一件有图的商品拿来当缩略图。图片存的是 JSON 字符串数组
    // （SQLite 没有数组类型），解析失败就当作没图
    const raw = item.sku?.product.images
    if (!raw) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && typeof parsed[0] === "string") {
        cover = parsed[0]
      }
    } catch {
      // 脏数据：忽略，不要让它把整个后台列表搞崩
    }
  }

  const status = order.status as OrderStatus

  return {
    id: order.id,
    orderNo: order.orderNo,
    status,
    statusLabel: ORDER_STATUS_LABEL[status] ?? order.status,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    coverImage: cover,
    itemKindCount: order.items.length,
    totalQuantity,
  }
}

// ---------------------------------------------------------------------------
// 管理员：批准 / 拒绝
// ---------------------------------------------------------------------------

/**
 * 批准退款 —— 整个功能里唯一真正动钱的地方。
 *
 * 一个事务里做四件事，顺序有讲究：
 *   1. 抢占退款单（PENDING → REFUNDED）
 *   2. 抢占订单（REFUNDING → REFUNDED）
 *   3. 还库存
 *   4. 退优惠券
 *
 * 【为什么退款单要先抢】
 * 两个管理员同时点「批准」，抢的是同一张退款单。先抢退款单的人
 * 拿到 count = 1 继续走；后到的 count = 0，立刻返回「已被处理」，
 * 连订单都不去碰。这样第二个请求根本走不到「退钱」那一步 ——
 * 钱只可能退一次。
 *
 * 【为什么订单那一步也要单独抢，而不是「既然单抢到了就随便改」】
 * 退款单和订单是两个状态，理论上可能不一致（比如有人手工改过库）。
 * 订单如果不是 REFUNDING（说明它已经被别的东西改走了），
 * 这时候把订单写回 REFUNDED 就是在**覆盖**一个合法状态。
 * 所以订单也得用条件更新去抢，抢不到就整条回滚 ——
 * 退款单的 PENDING 状态跟着一起回去，管理员刷新后能重试。
 *
 * 【为什么用抛异常而不是 return { ok: false }】
 * 因为已经改过数据了（第 1 步），要撤销只有抛异常让事务回滚这一条路。
 * 返回错误对象 = 事务正常提交 = 退款单停在一个「已退款但订单没退」的
 * 状态上。这是 Prisma 事务回调的规矩，不是风格选择。
 */
export async function approveRefund(
  refundId: string,
  adminNote: string | null,
): Promise<RefundResult> {
  const now = new Date()

  try {
    return await prisma.$transaction(async (tx) => {
      // ---- 1. 抢占退款单 ----
      const claimed = await tx.refundRequest.updateMany({
        where: { id: refundId, status: REFUND_STATUS.PENDING },
        data: {
          status: REFUND_STATUS.REFUNDED,
          adminNote,
          processedAt: now,
        },
      })

      if (claimed.count === 0) {
        return { ok: false, error: "这条退款申请已经被处理过了" }
      }

      // 抢占成功之后才读，读到的就是「这一条确实是待处理的」那条。
      // 放在抢占之前读也不影响正确性（抢不到就返回了），
      // 但读完立刻用同一个事务里的写操作，心里更踏实
      const refund = await tx.refundRequest.findUniqueOrThrow({
        where: { id: refundId },
        select: { orderId: true, refundAmount: true },
      })

      const order = await tx.order.findUniqueOrThrow({
        where: { id: refund.orderId },
        select: { id: true, status: true, totalAmount: true },
      })

      // ---- 2. 抢占订单 ----
      const orderClaimed = await tx.order.updateMany({
        where: { id: order.id, status: ORDER_STATUS.REFUNDING },
        data: { status: ORDER_STATUS.REFUNDED, refundedAt: now },
      })

      if (orderClaimed.count === 0) {
        // 抛异常 = 回滚，第 1 步的抢占一起撤销
        throw new RefundConflictError(
          `订单当前是${ORDER_STATUS_LABEL[order.status as OrderStatus] ?? order.status}，不能退款`,
        )
      }

      // ---- 3 & 4. 还库存 / 退券 ----
      //
      // 【这两步为什么无条件执行，不像取消订单那样先问一句「该不该」】
      // 见 orders.ts 里 restoreStockForOrder 的注释：退款成立 = 这笔交易
      // 整个作废，钱退了、货是平台的、券也该还给买家。不存在
      // 「已发货就不还库存」这种例外 —— 那正是退款和取消的区别。
      //
      // 【生产环境这里要改】
      // 真实系统里，库存应该在**仓库确认收到实物**之后才加回来，
      // 而且要区分「可再售」和「待质检」。现在一退款就入库，
      // 等于假设每双退回来的鞋都是完好的 —— 练手阶段先这么做，
      // 但要知道这是个简化。
      await restoreStockForOrder(tx, order.id)
      await restoreCouponForOrder(tx, order.id)

      // ---- 5. 以订单的实付为准，把金额对齐 ----
      // 申请时快照的 refundAmount 是给用户看的「预计退款」；
      // 真正退多少钱，以批准这一刻订单上的实付为准。
      // 正常情况下两者必然相等（totalAmount 下单后就不再变），
      // 不相等说明数据被动过 —— 这时候听订单的，并且记一条日志
      const amount = calcRefundAmount(order)

      if (amount !== refund.refundAmount) {
        console.warn(
          `[refund] 退款金额快照(${refund.refundAmount})与订单实付(${amount})不一致，以订单为准 refund=${refundId}`,
        )
        await tx.refundRequest.update({
          where: { id: refundId },
          data: { refundAmount: amount },
        })
      }

      return { ok: true, refundId, refundAmount: amount }
    })
  } catch (error) {
    if (error instanceof RefundConflictError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
}

/** 事务里用来「带着一句人话回滚」的信号。只在本文件内部用 */
class RefundConflictError extends Error {}

/**
 * 拒绝退款 —— 把订单放回申请前的状态。
 *
 * 【为什么「放回去」不是「改成某个固定的状态」】
 * 退款可以从三个状态进来（PAID / SHIPPED / COMPLETED）。一个已经发货的
 * 订单被拒后退回 PAID，管理员界面上就会重新出现「发货」按钮 ——
 * 等于让同一件货发两次。所以退回哪个状态必须看 RefundRequest.previousStatus，
 * 那是申请时一起记下来的。
 *
 * 【这里也要抢两次吗】
 * 要，而且是同一个理由：管理员 A 点拒绝、管理员 B 点批准，
 * 两件事不能都成。抢退款单那一步（PENDING → REJECTED）就把这个解决了，
 * 谁先谁赢。
 *
 * 【为什么不还库存、不退券】
 * 拒绝 = 这笔交易照旧。库存从来没还过（还库存只发生在批准时），
 * 券也还挂在订单上（买家收到货之后那张券仍然是「已使用」）。
 * 什么都没动，所以什么都不用补偿 —— 这也是把「补偿」全部集中在
 * 批准那一条路径上的好处：要错也只错一个地方。
 */
export async function rejectRefund(
  refundId: string,
  adminNote: string,
): Promise<RefundResult> {
  const now = new Date()

  try {
    return await prisma.$transaction(async (tx) => {
      // 抢之前先读，是为了拿到 previousStatus。读和抢之间隔着的那一小段
      // 不需要担心：抢的 WHERE 里带着 status = PENDING，抢输了直接返回
      const refund = await tx.refundRequest.findUnique({
        where: { id: refundId },
        select: { orderId: true, previousStatus: true, refundAmount: true },
      })

      if (!refund) return { ok: false, error: "退款申请不存在" }

      const claimed = await tx.refundRequest.updateMany({
        where: { id: refundId, status: REFUND_STATUS.PENDING },
        data: { status: REFUND_STATUS.REJECTED, adminNote, processedAt: now },
      })

      if (claimed.count === 0) {
        return { ok: false, error: "这条退款申请已经被处理过了" }
      }

      const previous = refund.previousStatus as OrderStatus

      // 兜底断言：确认状态机里有「REFUNDING → 申请前的状态」这条边。
      // 真正的守门人是下面 SQL 的 WHERE，这里只是防止有人改了
      // ORDER_STATUS_TRANSITIONS 却忘了这边
      if (!canTransition(ORDER_STATUS.REFUNDING, previous)) {
        throw new RefundConflictError("订单原始状态异常，请联系技术处理")
      }

      const restored = await tx.order.updateMany({
        where: { id: refund.orderId, status: ORDER_STATUS.REFUNDING },
        data: { status: previous },
      })

      if (restored.count === 0) {
        throw new RefundConflictError("订单状态已变化，请刷新后重试")
      }

      return {
        ok: true,
        refundId,
        refundAmount: refund.refundAmount,
      }
    })
  } catch (error) {
    if (error instanceof RefundConflictError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
}
