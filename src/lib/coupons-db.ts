import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { calcCouponDiscount, toCouponType, type CouponRule } from "@/lib/coupons"

// ============================================================================
// 优惠券（服务端 / 数据库侧）
//
// 【和 src/lib/coupons.ts 的分工】
//   coupons.ts     —— 怎么算、怎么显示（纯函数，浏览器里也能跑）
//   coupons-db.ts  —— 怎么查、怎么写（本文件，只在服务端跑）
// 这条线必须在，理由见 coupons.ts 开头的注释（客户端组件 import 到
// prisma 会让 next build 报 Can't resolve 'fs'）。
//
// 【这个文件里没有「下单时扣券」】
// 用券发生在下单事务内部，和扣库存、建订单是同一个原子操作，
// 所以它在 src/lib/orders.ts 里。这里只管「领券」和「查券」这两件
// 不带事务的事。
// ============================================================================

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 券 + 它的发放情况。
 *
 * 【为什么还要带 usedCount / totalLimit / perUserLimit】
 * 列表页要显示「已领 37/100」「每人限领 1 张」，前台领券按钮还要靠
 * usedCount < totalLimit 来判断「抢完了」。这些都是「券的状态」，
 * 不是「券的规则」—— 规则那部分在 CouponRule 里（纯计算用），
 * 这里在它基础上补上状态字段，避免每个页面各查一次。
 */
export type CouponView = CouponRule & {
  usedCount: number
  totalLimit: number
  perUserLimit: number
  createdAt: Date
}

/** 前台领券列表里的一项 */
export type ClaimableCoupon = {
  coupon: CouponView
  /** 这个用户已经领了几张（未登录时是 0） */
  claimedCount: number
  /** 还能不能领（未登录时是 true —— 点了会先被引导去登录） */
  canClaim: boolean
  /** 不能领的原因，能领时是 null */
  blockedReason: string | null
}

/** 「我的券」里的一项 —— 一张券的实例，不是券本身 */
export type MyCoupon = {
  userCouponId: string
  coupon: CouponView
  claimedAt: Date
  usedAt: Date | null
  orderId: string | null
}

/** 结算页可用券的一项：券 + 这笔订单能减多少 */
export type UsableCoupon = {
  userCouponId: string
  coupon: CouponView
  discountCents: number
}

/** 领券结果 */
export type ClaimResult = { ok: true } | { ok: false; error: string }

/**
 * 「算折扣和写文案」需要的那几个字段的 select。
 *
 * 【为什么单独抽出来】
 * 订单详情也要显示「用了哪张券」，于是订单查询里要 join 出券的规则字段。
 * 如果那边自己写一份 select，将来 CouponRule 加了字段（比如要支持
 * 「满减券 + 品类限定」），加券的人只会改这里，订单那边就悄悄少一个字段 ——
 * 而少一个字段的表现是「订单页的券文案显示得不对」，很难查。
 * 共用一份，缺字段会立刻在类型上暴露。
 */
export const COUPON_RULE_SELECT = {
  id: true,
  code: true,
  type: true,
  value: true,
  minSpend: true,
  maxDiscount: true,
  startAt: true,
  endAt: true,
  isActive: true,
} as const

type CouponRuleRow = {
  id: string
  code: string
  type: string
  value: number
  minSpend: number
  maxDiscount: number | null
  startAt: Date
  endAt: Date
  isActive: boolean
}

/**
 * 数据库里读出来的行 → CouponRule。
 *
 * 【为什么要有这么一层转换，而不是直接把 Prisma 的行当 CouponRule 用】
 * 两个原因：
 *   1. type 在库里是 String（SQLite 没有 enum），必须收窄成 CouponType。
 *      直接 as 断言的话，将来谁改了这个类型都不会有编译错误
 *   2. 「纯计算层需要哪些字段」这件事只在这里体现一次。以后 Coupon 表加了
 *      字段（比如 description），改这里一处就够，coupons.ts 和它的测试不用动
 */
export function toCouponRule(row: CouponRuleRow): CouponRule {
  return {
    id: row.id,
    code: row.code,
    type: toCouponType(row.type),
    value: row.value,
    minSpend: row.minSpend,
    maxDiscount: row.maxDiscount,
    startAt: row.startAt,
    endAt: row.endAt,
    isActive: row.isActive,
  }
}

/** 券的规则 + 发放情况（后台列表、领券列表用） */
function toCouponView(row: CouponRuleRow & {
  usedCount: number
  totalLimit: number
  perUserLimit: number
  createdAt: Date
}): CouponView {
  return {
    ...toCouponRule(row),
    usedCount: row.usedCount,
    totalLimit: row.totalLimit,
    perUserLimit: row.perUserLimit,
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------------------
// 前台：领券
// ---------------------------------------------------------------------------

/**
 * 现在能领的券有哪些。
 *
 * 【为什么这里不按金额过滤】
 * 「能不能用」是下单那一刻的事（要拿购物车金额去比门槛），
 * 而「能不能领」只取决于券本身。如果把券按当前金额筛掉，
 * 用户把商品从购物车删了又加回来，券会忽隐忽现；
 * 而先领进兜里、结算时再判断门槛，才符合直觉 ——
 * 现实里的券也是这样：先抢到，再决定用来买什么。
 */
export async function getClaimableCoupons(
  userId: string | null,
  now: Date = new Date(),
): Promise<ClaimableCoupon[]> {
  const rows = await prisma.coupon.findMany({
    where: {
      isActive: true,
      startAt: { lte: now },
      endAt: { gte: now },
    },
    // 先到期的排前面（快过期的要优先用掉），同一天到期的按创建时间
    orderBy: [{ endAt: "asc" }, { createdAt: "asc" }],
  })

  // 【为什么用 JS 过滤 usedCount < totalLimit，而不是写在 where 里】
  // 这是「同一行的两个列比大小」，Prisma 的 where 表达不了
  // （理由和下单时扣券槽位那处一样，见 src/lib/orders.ts 的注释）。
  // 区别在于：那里必须**原子**地判断+扣减，所以非用原生 SQL 不可；
  // 这里只是「列出来给用户看」，读的时候稍微旧一点没有后果 ——
  // 真被抢完了，点领取那一刻会被原子地拦住。
  const open = rows.filter((row) => row.usedCount < row.totalLimit)

  const counts = userId ? await countClaimsByCoupon(userId) : new Map<string, number>()

  return open.map((row) => {
    const coupon = toCouponView(row)
    const claimedCount = counts.get(coupon.id) ?? 0
    // 未登录时不拦：让他点，点完引导去登录。
    // 灰着按钮不解释的话，用户会以为这张券本身有问题
    const blockedReason = userId
      ? claimedCount >= coupon.perUserLimit
        ? `每人限领 ${coupon.perUserLimit} 张，你已领完`
        : null
      : null

    return {
      coupon,
      claimedCount,
      canClaim: blockedReason === null,
      blockedReason,
    }
  })
}

/** 这个人每张券各领了几张 —— 领券列表和「我的券」都要用 */
async function countClaimsByCoupon(userId: string): Promise<Map<string, number>> {
  const grouped = await prisma.userCoupon.groupBy({
    by: ["couponId"],
    where: { userId },
    _count: { _all: true },
  })

  return new Map(grouped.map((row) => [row.couponId, row._count._all]))
}

/**
 * 领取一张券。
 *
 * 【为什么要用原生 SQL 而不是 prisma.userCoupon.create()】
 * 「每人限领 N 张」的判断和插入必须是**一步**，否则并发的两次点击会像这样：
 *   A: 数一下 → 0 张（没超限）
 *   B: 数一下 → 0 张（也没超限）
 *   A: 插入
 *   B: 插入            ← 结果领了 2 张，而限领是 1
 * 这是典型的「先查后写」竞态。
 *
 * 【但「写成一条 INSERT ... SELECT」并不足以解决它 —— 这里踩过坑】
 * 曾经的写法是：
 *     INSERT INTO "user_coupons" ... SELECT ...
 *     WHERE (SELECT COUNT(*) FROM "user_coupons" WHERE ...) < 限领数
 * 当时的理由是「数」和「插」在同一个语句里，中间没有缝。**这个理由是错的。**
 *
 * PostgreSQL 默认隔离级别是 READ COMMITTED，而它的语义是：**每条语句开始
 * 执行时取一次自己的快照**。两个并发的 INSERT ... SELECT 各算各的 COUNT ——
 * 都从自己的快照里读到 0，都判定没超限，都插入。这里的 COUNT 只是一次普通
 * 的读，**不持有任何锁**，所以两条语句谁也不用等谁，这个缝一直都在。
 *
 * 【对照：为什么 UPDATE ... WHERE 就没有这个问题】
 *     UPDATE "coupons" SET "usedCount" = "usedCount" + 1 WHERE "usedCount" < 100
 * 这条是安全的：UPDATE 锁住目标行之后，会拿**最新提交的版本重算一遍 WHERE**
 * （PostgreSQL 里叫 EvalPlanQual），算不过就不改。所以「同一个语句」不等于
 * 「同一份快照」—— UPDATE 会重算，INSERT ... SELECT 不会。本文件别处的券
 * 核销、以及 orders.ts 的扣库存，能直接靠条件更新保证并发安全就是因为这个。
 *
 * 【所以串行化得另外给】见下面 pg_advisory_xact_lock 那一段。
 *
 * 【为什么 id 和 createdAt 要自己传】
 * $executeRaw 是绕过 Prisma 的原生 SQL —— @default(cuid()) 和
 * createdAt 的默认值都是 Prisma 层的行为，原生 SQL 拿不到。
 * 这张表的 createdAt 还有个 SQLite 层的 DEFAULT CURRENT_TIMESTAMP 兜底，
 * 但那个默认值只精确到秒，和别处（Prisma 写入）的毫秒精度不一样。
 * 统一自己传，时间戳格式就和全表一致了。
 *
 * 【affected 为 0 是什么意思】
 * 条件不成立，什么都没插。可能是超了每人限领 —— 因为查券信息在前、
 * 插入在后，这中间券也可能刚好被停用/过期，所以不能只报「超限」，
 * 得把两种可能都说了。
 */
export async function claimCoupon(
  userId: string,
  couponId: string,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const row = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: { isActive: true, startAt: true, endAt: true, usedCount: true, totalLimit: true, perUserLimit: true },
  })

  if (!row) return { ok: false, error: "券不存在" }
  if (!row.isActive) return { ok: false, error: "这张券已停用" }
  if (now < row.startAt) return { ok: false, error: "这张券还没开始发放" }
  if (now > row.endAt) return { ok: false, error: "这张券已过期" }
  if (row.usedCount >= row.totalLimit) return { ok: false, error: "这张券已被抢完" }

  const id = crypto.randomUUID()

  const affected = await prisma.$transaction(async (tx) => {
    // 1. 先取锁，再数、再插。顺序不能反 —— 反了等于没锁。
    //
    //    锁的粒度**正好就是业务约束的粒度**：同一个人领同一张券串行，
    //    不同的人领同一张券、同一个人领不同的券，互不阻塞。
    //
    //    必须在事务里取：`_xact_` 后缀的锁只在事务内有意义，事务一结束
    //    （提交或抛错回滚都一样）自动释放，不需要手动 unlock，异常路径
    //    也不会漏掉一把锁。在事务外调它等于没加锁。
    //
    //    【已知的缺陷：hashtext 会碰撞】
    //    两个不同的 (userId, couponId) 有可能算出同一对整数，于是两个
    //    本来互不相干的领券操作被串行化。这是**性能损失，不是正确性问题**
    //    （顶多多等一会儿，不会多领）。练手项目接受这个代价。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${couponId}))`

    // 2. 拿到锁之后执行原来的「数 + 插」。此刻同一个 (userId, couponId)
    //    上不可能再有另一个请求夹在这两步中间
    //
    // 【列名为什么都带双引号 —— PostgreSQL 迁移时踩出来的】
    // PostgreSQL 会把不加引号的标识符一律折叠成小写，而建表时列名是
    // 带引号的 "userId" / "couponId" / "createdAt"（大小写敏感）。
    // 裸写会直接报「字段 "userid" 不存在」（SQLSTATE 42703）——
    // SQLite 不区分大小写，所以这份 SQL 从 SQLite 搬过来时看着完全正常。
    // 表名 user_coupons 本身是小写，加引号只是为了保持一致的写法。
    return tx.$executeRaw`
      INSERT INTO "user_coupons" ("id", "userId", "couponId", "createdAt")
      SELECT ${id}, ${userId}, ${couponId}, ${now.toISOString()}
      WHERE (
        SELECT COUNT(*) FROM "user_coupons"
        WHERE "userId" = ${userId} AND "couponId" = ${couponId}
      ) < ${row.perUserLimit}
    `
  })

  if (affected === 0) {
    return { ok: false, error: `每人限领 ${row.perUserLimit} 张，你已经领过了` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 前台：我的券
// ---------------------------------------------------------------------------

/**
 * 我的全部券（未使用 + 已使用），按领券时间倒序。
 *
 * 【为什么「已过期」不在这里筛】
 * 「过期」是**当前时间**的函数，不是数据里的一个状态 —— 同一张券，
 * 今天看是「未使用」，明天看就是「已过期」，后天它还可能被重新启用
 * （endAt 被管理员改了）。所以库里不存「过期」这个状态，页面拿
 * 这份原始数据 + 当前时间去分 tab。这样也不会出现
 * 「状态字段忘了更新」的经典问题。
 */
export async function getMyCoupons(userId: string): Promise<MyCoupon[]> {
  const rows = await prisma.userCoupon.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      usedAt: true,
      orderId: true,
      coupon: true,
    },
  })

  return rows.map((row) => ({
    userCouponId: row.id,
    coupon: toCouponView(row.coupon),
    claimedAt: row.createdAt,
    usedAt: row.usedAt,
    orderId: row.orderId,
  }))
}

// ---------------------------------------------------------------------------
// 前台：结算页可用券
// ---------------------------------------------------------------------------

/**
 * 这笔订单能用的券（已经算好了各自能减多少）。
 *
 * 【为什么把「算折扣」也放进这个查询函数】
 * 因为筛选和计算用的是同一份数据。如果只返回「符合条件的券」，
 * 调用方还得自己再算一遍折扣 —— 那就有两个地方各自判断「什么算可用」。
 * 这里一次算完，页面直接拿去渲染。
 *
 * 注意：**这只是给用户看的预览**。真正下单时服务端会在事务里
 * 用同一套纯函数重算一遍（见 src/lib/orders.ts），永远不会信任
 * 浏览器传回来的金额。
 */
export async function getUsableCoupons(
  userId: string,
  amountCents: number,
  now: Date = new Date(),
): Promise<UsableCoupon[]> {
  const rows = await prisma.userCoupon.findMany({
    where: {
      userId,
      usedAt: null, // 没用过的才算「未使用」
      orderId: null, // 双保险：核销过但 usedAt 没写上的脏数据不该被再选一次
      coupon: {
        isActive: true,
        startAt: { lte: now },
        endAt: { gte: now },
        minSpend: { lte: amountCents },
      },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, coupon: true },
  })

  return rows.map((row) => {
    const coupon = toCouponView(row.coupon)
    return {
      userCouponId: row.id,
      coupon,
      // 【这里为什么直接用 coupons.ts 里的那个函数，而不是就地写一遍公式】
      // 因为「页面预览的折扣」和「下单时真正扣的折扣」必须是同一个数。
      // 各写一遍的话，哪天有人改了四舍五入的方向，页面显示减 100、
      // 实际扣 99.99，而且不会有任何测试发现 —— 这正是需求里那句
      // 「差一分钱用户会投诉」要防的事
      discountCents: calcCouponDiscount(coupon, amountCents),
    }
  })
}

/**
 * 下单时按 id 取一张属于**这个人**的券。
 *
 * 【为什么要带 userId】
 * 这是整个下单流程里唯一一次「由客户端指定资源」的地方（userCouponId
 * 是浏览器传上来的）。只按 id 查的话，用户 A 拿到用户 B 的券 id
 * 就能用别人的券 —— 越权。带上 userId 之后，查不到就是查不到，
 * 不需要在业务逻辑里再判一次「这券是不是你的」。
 */
export async function getOwnedCoupon(
  userId: string,
  userCouponId: string,
): Promise<{ userCouponId: string; coupon: CouponView } | null> {
  const row = await prisma.userCoupon.findFirst({
    where: { id: userCouponId, userId },
    select: { id: true, coupon: true },
  })
  if (!row) return null
  return { userCouponId: row.id, coupon: toCouponView(row.coupon) }
}

// ---------------------------------------------------------------------------
// 后台：券的管理
// ---------------------------------------------------------------------------

/** 后台列表里的一行：券 + 已被用掉多少 */
export type AdminCouponRow = CouponView & {
  /** 还没被用掉的份数，列表里直接显示，省得管理员自己减 */
  remaining: number
}

/**
 * 后台券列表（新建的排前面）。
 *
 * 【为什么不分页】
 * 和收藏是同一个理由：券是运营手工配的，数量以「几十张」计，
 * 不会像订单那样无限增长。真到了需要分页的规模再说。
 */
export async function listCoupons(): Promise<AdminCouponRow[]> {
  const rows = await prisma.coupon.findMany({
    orderBy: { createdAt: "desc" },
  })

  return rows.map((row) => {
    const coupon = toCouponView(row)
    return { ...coupon, remaining: Math.max(0, coupon.totalLimit - coupon.usedCount) }
  })
}

/** 编辑页要的那一张券 */
export async function getCouponById(id: string): Promise<CouponView | null> {
  const row = await prisma.coupon.findUnique({ where: { id } })
  return row ? toCouponView(row) : null
}

/** 新建/编辑共用的入参（已经过了 couponSchema 校验） */
export type CouponInput = {
  code: string
  type: "FIXED" | "PERCENT"
  value: number
  minSpend: number
  maxDiscount: number | null
  startAt: Date
  endAt: Date
  totalLimit: number
  perUserLimit: number
  isActive: boolean
}

export type CouponWriteResult = { ok: true; id: string } | { ok: false; error: string }

export async function createCoupon(input: CouponInput): Promise<CouponWriteResult> {
  try {
    const created = await prisma.coupon.create({
      data: input,
      select: { id: true },
    })
    return { ok: true, id: created.id }
  } catch (error) {
    return { ok: false, error: couponWriteError(error) }
  }
}

/**
 * 编辑一张券。
 *
 * 【为什么允许改 value / minSpend / 有效期】
 * 券是「还没发生的事」的规则，写着写着改条件是常态（预算给多了、
 * 活动提前结束）。改它不会影响已经用掉的历史订单 ——
 * 那些订单里的 discountAmount 是下单时冻结的快照，
 * 原价也能由订单项重新加出来（见 Order.totalAmount 的注释）。
 *
 * 【为什么不能在编辑里改 usedCount / totalLimit 的关系】
 * totalLimit 允许改（发得动就多发点），但已经用掉的份数不能超过总量 ——
 * 那是逻辑上不可能的状态。所以这里挡一道：新的 totalLimit 不能小于
 * 已用掉的份数。
 */
export async function updateCoupon(
  id: string,
  input: CouponInput,
): Promise<CouponWriteResult> {
  const existing = await prisma.coupon.findUnique({
    where: { id },
    select: { usedCount: true },
  })
  if (!existing) return { ok: false, error: "券不存在" }

  if (input.totalLimit < existing.usedCount) {
    return {
      ok: false,
      error: `这张券已经用掉 ${existing.usedCount} 张，发放总量不能改得比它更小`,
    }
  }

  try {
    await prisma.coupon.update({ where: { id }, data: input })
    return { ok: true, id }
  } catch (error) {
    return { ok: false, error: couponWriteError(error) }
  }
}

/**
 * 停用 / 启用一张券。
 *
 * 【为什么是「停用」而不是删除】
 * 删掉会让历史订单的 couponId 被置空（onDelete: SetNull），
 * 「这单用了哪张券」就永远查不到了。停用既挡住新单，又留住痕迹。
 * 所以后台只提供停用，不提供删除。
 */
export async function setCouponActive(
  id: string,
  isActive: boolean,
): Promise<CouponWriteResult> {
  const existing = await prisma.coupon.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!existing) return { ok: false, error: "券不存在" }

  await prisma.coupon.update({ where: { id }, data: { isActive } })
  return { ok: true, id }
}

/**
 * 把数据库的报错翻译成给管理员看的话。
 *
 * 【为什么偏偏处理 P2002】
 * 因为券码是唯一的，而「撞码」是管理员最容易遇到的一种失败
 * （复制上一张券改一改、或者活动名撞了）。默认报错是一长串
 * "Unique constraint failed on the fields: (`code`)" —— 管理员看不懂，
 * 也不知道该改哪儿。
 */
function couponWriteError(error: unknown): string {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return "这个券码已经被用过了，换一个吧"
  }
  console.error("[coupons-db] 写券失败:", error)
  return "保存失败，请稍后重试"
}
