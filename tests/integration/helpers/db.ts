import { prisma } from "@/lib/prisma"
import { ORDER_TIMEOUT_MINUTES, ORDER_STATUS, type OrderStatus } from "@/lib/constants"

// ============================================================================
// 集成测试的数据库工具
//
// 每个用例开始前调 resetDb() 把库清空，再用下面这些 makeXxx 造出这个用例
// 需要的那几行数据。**不用 seed.ts** —— 种子数据是给开发时看的（3 款鞋、
// 48 个 SKU），带着它写断言就得先在脑子里记住那 48 行是什么。
// 每个用例自己造两三个 SKU，断言才好写，也看得懂。
// ============================================================================

/**
 * 【安全检查，最重要的一道】
 *
 * resetDb() 会把所有业务表清空。如果 DATABASE_URL 因为任何原因指向了
 * shopdev，这一下就把开发数据全清了 —— 包括你手工下了半天用来调试的订单。
 * 这种事故没有任何提示，等你发现时数据已经没了。
 *
 * 所以每次破坏性操作之前，都先问数据库自己「你现在连的到底是哪个库」，
 * 不是 shoptest 就直接抛错。
 *
 * 【为什么不是查 process.env.DATABASE_URL】
 * 因为环境变量是**意图**，current_database() 是**事实**。
 * 环境变量可能被 .env、被 vitest 的 env 选项、被 shell 覆盖过好几轮，
 * 而 current_database() 是连接建立之后由 PostgreSQL 回报的：
 * 它说连的是哪个库，那就是哪个库，没有解释空间。
 *
 * 【从 SQLite 换过来时这条为什么必须重写】
 * 原来读的是 PRAGMA database_list 报出来的**文件路径**，
 * 换库之后那个语句在 PostgreSQL 上直接是语法错误 —— 而更糟的写法是
 * 「换个写法但保留 .endsWith('test.db') 这种判断」：
 * 库名里根本没有 .db 后缀，判断会永远为真、永远抛错，
 * 或者被人顺手改成恒等条件而彻底失去保护。
 * 所以这里比的是**库名**，和上面 DATABASES 清单里的写法保持一致。
 */
export async function assertTestDatabase(): Promise<string> {
  const rows = await prisma.$queryRaw<{ db: string }[]>`
    SELECT current_database() AS db
  `

  const db = rows[0]?.db ?? ""

  if (db !== "shoptest") {
    throw new Error(
      `拒绝在非测试库上执行破坏性操作！\n` +
        `  PostgreSQL 报告的当前库：${db || "(未知)"}\n` +
        `  期望的是 shoptest。\n` +
        `  请检查 vitest.integration.config.mts 的 test.env.DATABASE_URL。`,
    )
  }

  return db
}

/**
 * 清空所有业务表。
 *
 * 【删除顺序有讲究】
 * 先删「引用别人的」子表，再删「被引用的」主表。
 * 虽然 schema 里配了 onDelete: Cascade，数据库其实会替我们处理，
 * 但显式写出来有两个好处：
 *   1. 不依赖 schema 上的级联配置 —— 哪天有人把它改成 Restrict，
 *      这里不会突然开始报外键错误
 *   2. 「哪张表依赖哪张表」在测试里直接看得见
 */
export async function resetDb(): Promise<void> {
  await assertTestDatabase()

  // 评价放在最前面：它同时引用订单项、商品和用户，
  // 是这三张表的「下游」，必须第一个清掉
  await prisma.review.deleteMany()
  // 退款申请也是订单和用户的下游。放在 order 之前，理由和下面
  // userCoupon 那段一样：虽然配了 Cascade，真删起来不会报错，
  // 但显式排在前面，就没有「靠级联擦干净」这种看不见的行为
  await prisma.refundRequest.deleteMany()
  // 领券记录（user_coupons）要排在订单**之前**：它带着一个可空的 orderId，
  // 是被订单引用的那一侧的反向 —— 先删订单的话，这条记录会先被
  // onDelete: SetNull 置空（不报错，但测试之间就串数据了）。
  // 排在 order / user / coupon 三张主表前面，顺序上最保险
  await prisma.userCoupon.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  // 收藏引用商品和用户（比商品早清）
  await prisma.favorite.deleteMany()
  await prisma.cartItem.deleteMany()
  // 券本身。订单已经清完了，此刻已经没有引用它的行
  await prisma.coupon.deleteMany()
  await prisma.sku.deleteMany()
  await prisma.product.deleteMany()
  await prisma.user.deleteMany()
  await prisma.sizeGuide.deleteMany()
}

// ---------------------------------------------------------------------------
// 造数据
//
// 每个工厂函数都自动生成唯一的值（邮箱、货号），
// 这样同一个用例里造三个用户也不会撞唯一约束
// ---------------------------------------------------------------------------

let seq = 0
/** 每次调用返回一个递增的序号，用来拼出唯一值 */
function nextId(): number {
  seq += 1
  return seq
}

/** 用例之间把序号重置掉，让失败信息里的数字可复现 */
export function resetSeq(): void {
  seq = 0
}

export async function makeUser(overrides?: {
  role?: string
  email?: string
  name?: string
}) {
  const n = nextId()
  return prisma.user.create({
    data: {
      email: overrides?.email ?? `user${n}@test.dev`,
      // 测试里不需要真的 bcrypt（慢，一次 ~100ms）。
      // 需要验证密码的地方单独测 src/lib/password.ts
      password: "$2a$10$notarealhashnotarealhashnotarealhashnotarealhashno",
      name: overrides?.name ?? `测试用户${n}`,
      role: overrides?.role ?? "USER",
    },
  })
}

export async function makeAdmin() {
  return makeUser({ role: "ADMIN" })
}

export async function makeProduct(overrides?: {
  name?: string
  description?: string
  images?: string[]
  isActive?: boolean
  category?: string
}) {
  const n = nextId()
  return prisma.product.create({
    data: {
      name: overrides?.name ?? `测试鞋款 ${n}`,
      description: overrides?.description ?? "集成测试用的商品",
      category: overrides?.category ?? "跑步鞋",
      images: JSON.stringify(overrides?.images ?? [`/shoes/test-${n}.svg`]),
      isActive: overrides?.isActive ?? true,
    },
  })
}

export async function makeSku(
  productId: string,
  overrides?: { price?: number; stock?: number; size?: string; color?: string },
) {
  const n = nextId()
  return prisma.sku.create({
    data: {
      productId,
      size: overrides?.size ?? "42",
      color: overrides?.color ?? "黑色",
      price: overrides?.price ?? 89900,
      stock: overrides?.stock ?? 10,
      skuCode: `TEST-${n}`,
    },
  })
}

/** 一次性造好「一个用户 + 一款商品 + 一个 SKU」，大部分用例只需要这个 */
export async function makeShop(options?: {
  price?: number
  stock?: number
  userId?: string
}) {
  const user = options?.userId
    ? { id: options.userId }
    : await makeUser()

  const product = await makeProduct()
  const sku = await makeSku(product.id, {
    price: options?.price,
    stock: options?.stock,
  })

  return { userId: user.id, product, sku }
}

export async function addToCart(userId: string, skuId: string, quantity: number) {
  return prisma.cartItem.create({ data: { userId, skuId, quantity } })
}

/**
 * 造一张优惠券。
 *
 * 【默认值为什么是「满 0 减 100、有效期前后各一天、限量 100、每人 1 张」】
 * 这样默认造出来的券**一定能用**：没有门槛、还没过期、还有名额。
 * 想测哪种「不能用」的情况，就在那个用例里显式覆盖对应的字段 ——
 * 一个用例只考察一件事，断言里也不会混进别的失败原因。
 */
export async function makeCoupon(overrides?: {
  code?: string
  type?: "FIXED" | "PERCENT"
  /** FIXED 是减免的分；PERCENT 是减掉的百分点（10 = 9 折） */
  value?: number
  minSpend?: number
  maxDiscount?: number | null
  startAt?: Date
  endAt?: Date
  totalLimit?: number
  usedCount?: number
  perUserLimit?: number
  isActive?: boolean
}) {
  const n = nextId()
  const DAY_MS = 24 * 60 * 60 * 1000
  const now = Date.now()

  return prisma.coupon.create({
    data: {
      code: overrides?.code ?? `TESTCOUPON${n}`,
      type: overrides?.type ?? "FIXED",
      value: overrides?.value ?? 10000,
      minSpend: overrides?.minSpend ?? 0,
      maxDiscount: overrides?.maxDiscount ?? null,
      startAt: overrides?.startAt ?? new Date(now - DAY_MS),
      endAt: overrides?.endAt ?? new Date(now + DAY_MS),
      totalLimit: overrides?.totalLimit ?? 100,
      usedCount: overrides?.usedCount ?? 0,
      perUserLimit: overrides?.perUserLimit ?? 1,
      isActive: overrides?.isActive ?? true,
    },
  })
}

/** 直接往 user_coupons 里插一张券（不走 claimCoupon 的限领判断）*/
export async function giveCoupon(userId: string, couponId: string) {
  return prisma.userCoupon.create({ data: { userId, couponId } })
}

/** 某个人领了几张这张券 */
export async function claimCountOf(userId: string, couponId: string): Promise<number> {
  return prisma.userCoupon.count({ where: { userId, couponId } })
}

/** 这张券被核销了几次（读库里的 usedCount，不是数 user_coupons）*/
export async function usedCountOf(couponId: string): Promise<number> {
  const coupon = await prisma.coupon.findUniqueOrThrow({
    where: { id: couponId },
    select: { usedCount: true },
  })
  return coupon.usedCount
}

/**
 * 直接造一张订单（不走下单流程）。
 *
 * 【为什么要绕过 createOrderFromCart】
 * 测状态机的用例关心的是「PAID 的订单能不能发货」，
 * 拉上购物车、扣库存、算总价只会让测试变慢、断言变乱。
 * 直接指定 status 造出想要的状态，一个用例只考察一件事。
 *
 * 下单流程本身在 checkout.test.ts 里单独测。
 */
export async function makeOrder(options: {
  userId: string
  status?: OrderStatus
  /** 不传则取「现在 + ORDER_TIMEOUT_MINUTES」，和真实下单一致 */
  expiresAt?: Date
  totalAmount?: number
  skuId?: string | null
  quantity?: number
  /**
   * 下单时间。不传就是「现在」。
   *
   * 【为什么测「今天」的用例必须能指定它】
   * 自然日的边界是本地时间零点。要造一笔「昨天下的单」，
   * 如果只能传「现在」，那就得让测试真的等到明天再跑 —— 显然不行。
   * 能显式指定时间，才能把「昨天 23:59」和「今天 00:01」这种
   * 卡在边界上的用例写得又快又准。
   */
  createdAt?: Date
  /** 付款时间。不传就是 null（未付款） */
  paidAt?: Date | null
}) {
  const status = options.status ?? ORDER_STATUS.PENDING_PAYMENT
  const now = new Date()
  const n = nextId()

  return prisma.order.create({
    data: {
      orderNo: `SO-TEST-${String(n).padStart(6, "0")}`,
      userId: options.userId,
      status,
      totalAmount: options.totalAmount ?? 89900,
      address: "北京市朝阳区测试路 1 号",
      phone: "13800138000",
      expiresAt:
        options.expiresAt ??
        new Date(now.getTime() + ORDER_TIMEOUT_MINUTES * 60 * 1000),
      // 【为什么这两个要写成 ...(x ? {k} : {}) 而不是 createdAt: undefined】
      // Prisma 会把显式的 undefined 当成「没提供」，看起来没问题。
      // 但 createdAt 上有 @default(now())，一旦真的把 undefined 传进去，
      // 在某些驱动上会被当成「显式设为 NULL」而不是「用默认值」。
      // 用展开语法条件插入，字段根本不出现在 data 里，最稳
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.paidAt ? { paidAt: options.paidAt } : {}),
      // 只有需要关联 SKU（比如测还库存）时才建订单项。
      // skuId 传 null 表示这是一张「商品已被删除」的历史订单
      ...(options.skuId
        ? {
            items: {
              create: {
                skuId: options.skuId,
                productName: "测试鞋款",
                size: "42",
                color: "黑色",
                price: options.totalAmount ?? 89900,
                quantity: options.quantity ?? 1,
                skuCode: "TEST-SNAPSHOT",
              },
            },
          }
        : {}),
    },
  })
}

/**
 * 取某张订单的第一个订单项。
 *
 * 测评价时要的是订单项的 id（createReview 的第一个参数），而 makeOrder
 * 只返回订单本身。与其让每个用例都写一遍 findFirst，不如收在这里。
 */
export async function firstItemOf(orderId: string) {
  return prisma.orderItem.findFirstOrThrow({ where: { orderId } })
}

/**
 * 直接造一条退款申请（不走 requestRefund）。
 *
 * 【为什么和 makeOrder 一样要绕过业务函数】
 * 测「批准退款会回滚库存」的用例，需要的是**一条已经存在的待处理申请**，
 * 而不是「怎么申请」。走 requestRefund 的话，用例就得先把订单推到
 * REFUNDING，再读回 refundId —— 中间任何一步出错，失败信息都会指向
 * 申请的流程而不是批准的流程，排查起来要绕一圈。
 *
 * 【默认值为什么是 PAID / PENDING】
 * 最常见的场景：买家在「已支付」的订单上提交了一条还没处理的申请。
 * 想测别的组合（比如已发货的订单、已经被拒过的记录）就在用例里覆盖 ——
 * 一个用例只考察一件事。
 */
export async function makeRefund(options: {
  orderId: string
  userId: string
  status?: string
  reason?: string
  description?: string | null
  refundAmount?: number
  adminNote?: string | null
  previousStatus?: OrderStatus
  processedAt?: Date | null
}) {
  return prisma.refundRequest.create({
    data: {
      orderId: options.orderId,
      userId: options.userId,
      status: options.status ?? "PENDING",
      reason: options.reason ?? "SIZE",
      description: options.description ?? null,
      refundAmount: options.refundAmount ?? 89900,
      adminNote: options.adminNote ?? null,
      previousStatus: options.previousStatus ?? ORDER_STATUS.PAID,
      // 和 makeOrder 里那两个字段同样的处理：用展开语法条件插入，
      // 让字段在不需要时**根本不出现**，而不是显式传 undefined
      ...(options.processedAt ? { processedAt: options.processedAt } : {}),
    },
  })
}

/** 读某条退款申请当前的状态 */
export async function refundStatusOf(refundId: string): Promise<string> {
  const refund = await prisma.refundRequest.findUniqueOrThrow({
    where: { id: refundId },
    select: { status: true },
  })
  return refund.status
}

/** 读某张订单的当前状态 */
export async function statusOf(orderId: string): Promise<string> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true },
  })
  return order.status
}

/** 读某个 SKU 的当前库存 */
export async function stockOf(skuId: string): Promise<number> {
  const sku = await prisma.sku.findUniqueOrThrow({
    where: { id: skuId },
    select: { stock: true },
  })
  return sku.stock
}

/** 造一个「已经过期」的时间点。留 1 秒余量，避免和边界擦肩 */
export function expiredAt(secondsAgo = 60): Date {
  return new Date(Date.now() - secondsAgo * 1000)
}

/** 造一个「还没过期」的时间点 */
export function futureAt(secondsAhead = 600): Date {
  return new Date(Date.now() + secondsAhead * 1000)
}

export { prisma }
