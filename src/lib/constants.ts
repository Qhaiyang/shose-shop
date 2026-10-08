import { z } from "zod"

// ============================================================================
// 业务枚举
//
// 【为什么要有这个文件】
// SQLite 不支持 enum，所以 schema.prisma 里 status/role 都是普通 String。
// 数据库层面拦不住脏数据 —— 你可以往 status 里塞 "FOO" 它也照存不误。
// 所以约束必须在应用层补上，这就是本文件的职责。
//
// 换 PostgreSQL 之后，可以把这些改成 Prisma enum，但 TS 层的联合类型
// 依然有用（编译期就能发现拼写错误，不用等运行时）。
// ============================================================================

// ---------------------------------------------------------------------------
// 订单状态机
//
//   PENDING_PAYMENT ──支付──> PAID ──发货──> SHIPPED ──确认收货──> COMPLETED
//          │                   │              │              │
//          │                   └──────────────┴──────────────┘
//          │                        申请退款 ↓
//          │                    REFUNDING ──批准──> REFUNDED
//          │                        └──拒绝──> 回到申请前的那个状态
//          └──超时15分钟 / 用户取消──> CANCELLED
//
// 合法流转：
//   PENDING_PAYMENT → PAID      支付
//   PENDING_PAYMENT → CANCELLED 超时或主动取消，需要回滚库存
//   PAID            → SHIPPED   管理员发货
//   PAID            → CANCELLED 已支付后取消，同样要回滚库存和券
//   SHIPPED         → COMPLETED 用户确认收货
//   PAID/SHIPPED/COMPLETED → REFUNDING 买家申请退款
//   REFUNDING       → REFUNDED  管理员批准
//   REFUNDING       → PAID/SHIPPED/COMPLETED 管理员拒绝，退回申请前的状态
//
// CANCELLED 和 REFUNDED 是终态，不能再往外流转。
// （REFUNDING → 三个状态那条「回退边」是拒绝退款专用的，见下方注释）
// ---------------------------------------------------------------------------

export const ORDER_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAID: "PAID",
  SHIPPED: "SHIPPED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  REFUNDING: "REFUNDING",
  REFUNDED: "REFUNDED",
} as const

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS]

export const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS) as [
  OrderStatus,
  ...OrderStatus[],
]

/** 给用户看的中文标签 */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "待支付",
  PAID: "已支付",
  SHIPPED: "已发货",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REFUNDING: "退款处理中",
  REFUNDED: "已退款",
}

/**
 * 状态机白名单：当前状态 → 允许流转到的状态。
 * 所有改状态的代码都必须先查这张表，不要直接赋值。
 *
 * 【REFUNDING 为什么能退回三个状态】
 * 这不是「正常流转」，而是「拒绝退款」这个动作在撤销上一次流转 ——
 * 申请退款把订单从 PAID/SHIPPED/COMPLETED 推进了 REFUNDING，
 * 管理员说「不行」的时候，这个动作等于没发生过，订单得回到原样。
 * 退回哪个由 RefundRequest.previousStatus 决定，不是随便挑一个。
 * 这条回头路只有 rejectRefund 会走，其他任何地方都不许用。
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["SHIPPED", "CANCELLED", "REFUNDING"],
  SHIPPED: ["COMPLETED", "REFUNDING"],
  COMPLETED: ["REFUNDING"], // 不再是终态：收了货也能退
  CANCELLED: [], // 终态
  REFUNDING: ["REFUNDED", "PAID", "SHIPPED", "COMPLETED"], // 前一个批准，后三个是拒绝回退
  REFUNDED: [], // 终态
}

/** 允许申请退款的订单状态（白名单的另一种读法，页面和 action 共用一份） */
export const REFUNDABLE_STATUSES: OrderStatus[] = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.COMPLETED,
]

/** 这个状态下买家能不能点「申请退款」 */
export function isRefundable(status: OrderStatus): boolean {
  return REFUNDABLE_STATUSES.includes(status)
}

/** 判断一次状态流转是否合法 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * 库存回滚规则：只有「库存已经扣过、且尚未真正卖出」的状态才需要回滚。
 * - PENDING_PAYMENT / PAID 取消 → 要回滚（下单时扣了库存）
 * - SHIPPED / COMPLETED 取消 → 不回滚（货已经在路上了，属于售后问题，不是库存问题）
 */
export function shouldRestoreStock(status: OrderStatus): boolean {
  return status === ORDER_STATUS.PENDING_PAYMENT || status === ORDER_STATUS.PAID
}

/**
 * 这个状态下，买家还能不能改订单备注？
 *
 * 【为什么发货之后就锁住】
 * 备注是给打包的人看的（「请工作日送」「不要放快递柜」）。货一发出去，
 * 面单和包裹都定下来了，这时候再怎么改备注都影响不了现实 ——
 * 允许改只会制造一份和实际不符的记录，客服照着订单去查反而会更迷惑。
 *
 * 【为什么待支付也算可改】
 * 订单还没付款，改个备注不影响任何已经发生的事。
 *
 * 注意这是个**纯函数**，不查库。真正改备注时，这个判断会被翻译成
 * SQL 的 WHERE 条件（见 src/lib/orders.ts 的 updateOrderNote）——
 * 因为「读到的状态」和「写入时的状态」之间可能隔着一次发货。
 */
export function isNoteEditable(status: OrderStatus): boolean {
  return status === ORDER_STATUS.PENDING_PAYMENT || status === ORDER_STATUS.PAID
}

// ---------------------------------------------------------------------------
// 优惠券
//
// 【为什么要单独一个 shouldRestoreCoupon，而不复用 shouldRestoreStock】
// 两者现在的取值恰好一样（PENDING_PAYMENT / PAID 为真），但**理由不同**：
//   - 库存：货没发出去，占的库存要还给别人
//   - 券：钱没收到（或刚收到又要退），这张券得让买家下次能再用
// 现在合在一起确实能跑，可一旦业务变了就会悄悄分叉 ——
// 比如将来加了「发货后 7 天无理由退货」，库存不回来（货要退回仓库质检），
// 但券是平台自己发的，退单了理应还给用户。到那天两个函数各改各的，
// 如果今天把它们写成同一个，改一处就会连带改错另一处。
// ---------------------------------------------------------------------------
export const COUPON_TYPE = {
  FIXED: "FIXED",
  PERCENT: "PERCENT",
} as const

export type CouponType = (typeof COUPON_TYPE)[keyof typeof COUPON_TYPE]

export const COUPON_TYPE_VALUES = Object.values(COUPON_TYPE) as [
  CouponType,
  ...CouponType[],
]

/** 给用户/管理员看的中文标签 */
export const COUPON_TYPE_LABEL: Record<CouponType, string> = {
  FIXED: "满减券",
  PERCENT: "折扣券",
}

/** 从数据库读出来的 String 要显式收窄，理由同 orderStatusSchema */
export const couponTypeSchema = z.enum(COUPON_TYPE_VALUES)

/**
 * PERCENT 券的 value 上限（99 = 最多打 1 折）。
 *
 * 【为什么不允许 100】
 * value 是「减掉的百分比」，100 意味着减 100%，也就是白送。
 * 白送不该由一张优惠券来表达 —— 那是 0 元购活动，走的是另一套流程
 * （要限购、要防刷、要备案）。卡在 99 还能保证订单金额是正数，
 * 「实付 0 元」这种订单在支付/对账/发票环节全是特例。
 */
export const COUPON_MAX_PERCENT = 99

/** 券码长度上限：够长到不易猜，又短到能念给人听 */
export const COUPON_CODE_MAX_LENGTH = 32

/** 券码长度下限：太短的码（比如 "A1"）别人随手就猜到了 */
export const COUPON_CODE_MIN_LENGTH = 4

/** 一张券最多被领多少张（perUserLimit 的上限） */
export const COUPON_MAX_PER_USER_LIMIT = 99

/** 一张券的发放总量上限，防手滑多打一位数 */
export const COUPON_MAX_TOTAL_LIMIT = 1_000_000

/**
 * 订单取消时，这张券要不要退回给用户？
 * 规则和库存一致（见上方注释解释为什么不共用一个函数）：
 * - PENDING_PAYMENT / PAID 取消 → 退回（还没发货，取消等于这笔交易没发生）
 * - SHIPPED / COMPLETED 取消 → 不退（货都发了，属于售后，券不该吐出来）
 */
export function shouldRestoreCoupon(status: OrderStatus): boolean {
  return status === ORDER_STATUS.PENDING_PAYMENT || status === ORDER_STATUS.PAID
}

// ---------------------------------------------------------------------------
// 退款
//
// 【为什么退款申请要单独一套状态，而不是复用订单状态】
// 订单状态说的是「这笔交易走到哪了」，退款状态说的是「这次售后诉求批没批」。
// 一单可能申请两次（第一次被拒），所以「批没批」是**申请**的属性，
// 不是订单的属性 —— 把它塞进订单状态，第二次申请就没地方表达「又被拒了」。
//
// 【为什么要有 APPROVED 这个没人写的状态】
// 见 schema.prisma 里 RefundRequest.status 的注释：现在批准即到账，
// 直接写 REFUNDED；APPROVED 是为将来接真实支付网关（批准 → 等回调）留的位置。
// 留着它比将来加一个状态迁移成本低得多，但**不要**在代码里伪造这个中间态。
// ---------------------------------------------------------------------------
export const REFUND_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  REFUNDED: "REFUNDED",
} as const

export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS]

export const REFUND_STATUS_VALUES = Object.values(REFUND_STATUS) as [
  RefundStatus,
  ...RefundStatus[],
]

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = {
  PENDING: "待处理",
  APPROVED: "已批准",
  REJECTED: "已拒绝",
  REFUNDED: "已退款",
}

/**
 * 退款原因。存的是英文键，页面显示中文。
 *
 * 【为什么不让用户自己写原因，而是给下拉框】
 * 一是原因要能被统计（「这个月退款原因里质量问题占多少」是选品和质检的
 * 输入，自由文本统计不出来）；二是下拉框能挡住空白提交。
 * 「其他」配上补充说明，自由表达的空间也还在。
 */
export const REFUND_REASON = {
  SIZE: "SIZE",
  QUALITY: "QUALITY",
  REGRET: "REGRET",
  OTHER: "OTHER",
} as const

export type RefundReason = (typeof REFUND_REASON)[keyof typeof REFUND_REASON]

export const REFUND_REASON_VALUES = Object.values(REFUND_REASON) as [
  RefundReason,
  ...RefundReason[],
]

export const REFUND_REASON_LABEL: Record<RefundReason, string> = {
  SIZE: "尺码不合适",
  QUALITY: "质量问题",
  REGRET: "不想要了",
  OTHER: "其他",
}

/** 退款说明的长度上限。理由同 ORDER_NOTE_MAX_LENGTH：短文本不会把界面撑坏 */
export const REFUND_DESCRIPTION_MAX_LENGTH = 200

/**
 * 管理员拒绝理由的长度上限。
 *
 * 【为什么拒绝理由给得比买家说明还短】
 * 买家是在描述一个主观感受，管理员是在给一个**结论**。
 * 而且这段话会原样显示给买家看，写长了反而容易夹带不该说的话
 * （内部备注、责任推诿）。短一点逼着写清楚。
 */
export const REFUND_ADMIN_NOTE_MAX_LENGTH = 100

// ---------------------------------------------------------------------------
// 用户角色
// ---------------------------------------------------------------------------
export const USER_ROLE = {
  USER: "USER",
  ADMIN: "ADMIN",
} as const

export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE]

// ---------------------------------------------------------------------------
// 运行时可校验的 Schema（zod）
//
// 从数据库读出来的 String 是「不可信」的 —— SQLite 没有 enum，
// 字段声明成 String 就意味着任何字符串都能存进去。
// 需要收窄成 OrderStatus 的地方（比如从 URL 读 ?status=）
// 一律用 orderStatusSchema.safeParse 显式校验，绝不假设它一定合法。
// ---------------------------------------------------------------------------
export const orderStatusSchema = z.enum(ORDER_STATUS_VALUES)

// ---------------------------------------------------------------------------
// 业务参数
// ---------------------------------------------------------------------------

/** 订单未支付自动取消的时限（分钟），从环境变量读，默认 15 */
export const ORDER_TIMEOUT_MINUTES = Number(
  process.env.ORDER_TIMEOUT_MINUTES ?? 15,
)

/**
 * 库存低于这个数就算「低库存」。
 *
 * 【为什么抽成常量，而不是在用到的两处各写一个 5】
 * 后台首页要显示「低于 5 件」这句话，商品列表的查询里也要用同一个 5。
 * 写成两处的话，哪天改成 3、只改了查询忘了文案 ——
 * 管理员就会对着「低于 5 件」的标题，看到一个按 3 算出来的数字，
 * 然后开始怀疑数据是不是错了。
 *
 * 顺带一提，这类「阈值」在真实系统里通常应该是可配置的
 * （写进配置表或环境变量）：不同品类的合理库存水位差很多，
 * 卖鞋的「低库存」和卖螺丝的完全是两个量级。
 */
export const LOW_STOCK_THRESHOLD = 5

/**
 * 单个 SKU 的价格上限（分）。999999.00 元。
 *
 * 【为什么需要一个「上限」这种看起来很多余的东西】
 * 价格字段是个 Int，本身能存到二十多亿。但真正危险的不是技术上限，
 * 是**手滑**：少打一个小数点，899.00 就变成了 89900.00。
 * 批量改价会把这种手滑一次放大到几十个 SKU 上，
 * 所以宁可有个明显高得离谱、但至少拦得住误操作的上限。
 */
export const MAX_PRICE_CENTS = 99_999_900

/** 调库存时单次增减的绝对值上限，和单个 SKU 调库存保持一致 */
export const MAX_STOCK_DELTA = 999_999

/** 一次批量操作最多勾选多少款商品 */
export const BULK_MAX_PRODUCTS = 100

/** 前台商品搜索关键词的长度上限，和后台上限一致，超出部分直接截断 */
export const PRODUCT_SEARCH_MAX_LENGTH = 40

/** 分类名的长度上限。分类来自 ?category=，同样要防「粘贴错东西」塞进来几万字 */
export const CATEGORY_MAX_LENGTH = 30

/**
 * 订单备注的长度上限。
 *
 * 【为什么给得这么小（100 字），而不是像商品描述那样给 2000】
 * 备注是给打包/配送的人扫一眼的，不是让买家写小作文的地方。
 * 上限卡在 100 还有一层好处：这一行要打进面单、也要在后台列表里显示，
 * 短文本怎么排版都不会把界面撑坏。
 */
export const ORDER_NOTE_MAX_LENGTH = 100

/**
 * 一次批量操作最多影响多少个 SKU。
 *
 * 【为什么商品数之外还要单独限 SKU 数】
 * 「100 款商品」听起来很安全，但如果每款有 20 个颜色尺码，
 * 那就是 2000 条 UPDATE 塞在同一个事务里 —— SQLite 是单写入者，
 * 这期间所有下单请求都在排队。限住 SKU 数才是真正限住了工作量
 */
export const BULK_MAX_SKUS = 500
