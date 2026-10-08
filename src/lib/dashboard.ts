// ============================================================================
// 后台首页的数据看板
//
// 【这一页为什么必须让数据库算】
// 最容易写出来的版本是这样的：
//
//     const orders = await prisma.order.findMany()
//     const todayCount = orders.filter(o => 是今天).length
//
// 开发时有几十条订单，这么写毫无问题。上线后订单到十万条，
// 这一行就会把十万行数据从数据库读出来、在 Node 里建十万个对象、再数一遍。
// 后台首页会变成整个站点最慢的一页 —— 而它还是管理员每天打开的第一页。
//
// 正确做法是把「筛选 / 计数 / 求和」下推给数据库，它只回一个数字：
//     count()     →  SELECT COUNT(*)
//     groupBy()   →  SELECT status, COUNT(*) ... GROUP BY status
//     aggregate() →  SELECT SUM(total_amount) ...
//
// 本文件里的**每一条**查询都遵守这一条，没有任何一次
// 「先全取回来再在 JS 里循环」。这是看板类代码唯一值得记住的事。
//
// 【为什么用 groupBy 而不是查 5 次 count】
// 「能在一条 SQL 里做完的，就别发 N 条」。这里 5 次 count 也就多几毫秒，
// 但换个场景（比如「按天统计最近 30 天的成交额」）就是 30 条 vs 1 条。
// 习惯是从小地方养成的，等真需要的时候再改就已经来不及了。
// ============================================================================

import {
  LOW_STOCK_THRESHOLD,
  ORDER_STATUS,
  ORDER_STATUS_VALUES,
  type OrderStatus,
} from "@/lib/constants"
import { todayRange } from "@/lib/dates"
import { prisma } from "@/lib/prisma"
// 趋势相关的纯逻辑（补零对齐、区间、日期口径）都在 sales-trend.ts 里 ——
// 那些函数不碰数据库，单独放是为了单元测试能直接 import 它们，
// 而不必把 prisma 一起拖进来（原因写在那个文件顶部）
import {
  buildSalesTrend,
  localTimeZone,
  trendRange,
  type SalesTrendPoint,
} from "@/lib/sales-trend"

export { SALES_TREND_DAYS, type SalesTrendPoint } from "@/lib/sales-trend"

export type AdminDashboard = {
  /** 全站各状态订单数。首页那排状态卡片直接用它 */
  statusStats: Record<OrderStatus, number>
  /** 全站订单总数 */
  totalOrders: number

  /** 今天下的单（按 createdAt 算），不分状态 */
  todayOrderCount: number
  /** 今天付款的订单笔数 */
  todayPaidOrderCount: number
  /**
   * 今天的销售额，**单位：分**。
   *
   * 按 paidAt（到账时间）算，且不含已取消的订单。
   * 页面渲染时才用 formatPrice 转成元 —— 和全站其他地方一样，
   * 业务计算全程用分，避免浮点误差。
   */
  todayRevenue: number

  /** 待发货：状态是 PAID 的订单数 */
  pendingShipmentCount: number

  /** 库存低于阈值的 SKU 数 */
  lowStockSkuCount: number
  /** 这些 SKU 分布在多少款商品里 */
  lowStockProductCount: number

  /** 近 7 天（含今天）每天的销售额，最旧一天在最前 */
  salesTrend: SalesTrendPoint[]
}

/**
 * groupBy 查出来的原始行 → 一张「五个状态都有值」的表。
 *
 * 【为什么要补齐空缺的状态】
 * groupBy 只返回**存在**的分组。全站一笔已完成订单都没有时，
 * 结果里就没有 COMPLETED 这一行。页面直接取 stats.COMPLETED 会拿到
 * undefined，渲染出来就是个空白 —— 而这个空白在管理员眼里
 * 和「0」是两回事（他会以为是坏了）。
 * 所以先把五个状态全填 0，再把查出来的覆盖上去。
 */
function toStatusRecord(
  rows: { status: string; _count: { _all: number } }[],
): Record<OrderStatus, number> {
  const record = Object.fromEntries(
    ORDER_STATUS_VALUES.map((status) => [status, 0]),
  ) as Record<OrderStatus, number>

  for (const row of rows) {
    // SQLite 没有 enum，库里可能存着非法状态（手工插的数据、改过的老数据）。
    // 静默忽略比让整个后台首页崩掉好 —— 一行脏数据不该拖垮一个页面
    if (!(row.status in record)) continue
    record[row.status as OrderStatus] = row._count._all
  }

  return record
}

export async function getAdminDashboard(): Promise<AdminDashboard> {
  // 【为什么 now / range 只算一次】
  // 所有查询要用同一个「现在」和同一个区间。各算各的话，如果正好卡在
  // 零点那一瞬间，①用的是今天、②用的是明天，两个数字就来自不同的日子。
  const now = new Date()
  const range = todayRange(now)
  const trend = trendRange(now)

  // 五条查询互不依赖，用 Promise.all 一起发出去。
  //
  // 【为什么不硬拼成一条大 SQL】
  // 它们查的是不同的表（orders / skus）、不同的分组维度。
  // 硬拼会得到一堆需要在 JS 里再拆开的笛卡尔积结果，反而更难读也更慢。
  // 并发发五条，总耗时约等于最慢的那一条。
  const [allByStatus, todayByStatus, revenue, lowStockByProduct, trendRows] =
    await Promise.all([
      // ① 全站各状态订单数 —— 给首页那排状态卡片用
      prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),

      // ② 今天下的单，按状态分组。
      //    本来写个 count() 就够了，这里用 groupBy 是因为它顺带回答了
      //    「今天这 7 单里有几单已经付款了」—— 同一个查询多给一个信息
      prisma.order.groupBy({
        by: ["status"],
        where: { createdAt: range },
        _count: { _all: true },
      }),

      // ③ 今天的销售额
      //
      //    【为什么按 paidAt 而不是 createdAt】
      //    「销售额」的意思是钱到账了，而钱到账的时刻是 paidAt。
      //    按 createdAt 算的话，今天下午下单、明天才付款的那笔，
      //    今天就被计入营收了 —— 那叫「今日下单额」，不叫销售额。
      //    做日报表时这两个数经常对不上，原因多半就在这里。
      //
      //    【为什么排除 CANCELLED】
      //    paidAt 非空的订单里会混进「付过款又取消」的（等于退款）。
      //    钱已经退回去了就不该算营收。当前代码里还没有
      //    「已付款后取消」的入口，但状态机允许 PAID → CANCELLED，
      //    所以这里先把口子堵上 —— 等哪天加了退款功能，
      //    这个数字不会突然开始虚高。
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        _count: { _all: true },
        where: {
          status: { not: ORDER_STATUS.CANCELLED },
          paidAt: range,
        },
      }),

      // ④ 低库存：**按商品分组**
      //
      //    直接 count({ where: { stock: { lt: 5 } } }) 也能拿到 SKU 数量。
      //    分组之后，把每组的 _count 加起来还是 SKU 数，
      //    而**组数**恰好是「涉及多少款商品」——
      //    一条查询多给一个信息，页面上就能写
      //    「12 个规格库存告急，分布在 4 款商品里」。
      prisma.sku.groupBy({
        by: ["productId"],
        where: { stock: { lt: LOW_STOCK_THRESHOLD } },
        _count: { _all: true },
      }),

      // ⑤ 近 7 天销售额，按天聚合
      //
      //    【为什么这里用了 $queryRaw，而不是 Prisma 的 groupBy】
      //    Prisma 的 groupBy 只能按「现成的字段」分组，而这里要按
      //    「paidAt 落在哪一天」分组 —— 一天不是一个字段。
      //    所以只能用原生 SQL 把时间戳切成天，这一条就把 7 天的销售额
      //    按天加好了，没有把行拉回 JS 再数。
      //
      //    【为什么排除 CANCELLED】
      //    和今日销售额同一口径：付过款又取消的单等于退款，不该算营收。
      //
      //    【这一段是从 SQLite 迁过来的，说明白两边的区别】
      //    原来写的是 strftime('%Y-%m-%d', paidAt, 'localtime')。
      //    'localtime' 是 SQLite 专有的修饰符，PostgreSQL 里不存在 ——
      //    原样搬过来会直接是「函数 strftime 不存在」的语法错误。
      //
      //    PostgreSQL 要在 SQL 里得到本地时间，必须**把时区名显式传进去**：
      //        paidAt AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'
      //    为什么是连着两个 AT TIME ZONE，这里值得说清楚，
      //    因为它是整条 SQL 里最容易写错、且错了也看不出来的地方：
      //
      //      1. 列 paidAt 的类型是 timestamp **without** time zone，
      //         里面存的是 UTC 的墙上时间（Prisma 的行为）。
      //         但 PostgreSQL 并不知道这件事 —— 它只看到一个「没有时区
      //         概念的时间戳」。
      //      2. 第一个 AT TIME ZONE 'UTC' 是在告诉它：
      //         「这个时间戳是 UTC 的」，于是得到一个真正的
      //         timestamptz（带时区的绝对时刻）。
      //      3. 第二个 AT TIME ZONE 把那个绝对时刻换算成目标时区的
      //         墙上时间，得到本地时间戳。
      //         只写第一个的话，切出来的还是 UTC 的天 ——
      //         于是折线上的「今天」在 UTC+8 的白天会整体错一天。
      //
      //    时区名来自 localTimeZone()（JS 运行时的时区），而不是写死
      //    'Asia/Shanghai'：这样 SQL 和 buildSalesTrend 里的
      //    toLocalDayKey 用的是**同一个来源**的时区，不再依赖
      //    「SQLite 的 localtime 恰好等于 JS 的 local」这种巧合。
      //
      //    【为什么列名都加了双引号 —— 这条是迁移时踩出来的】
      //    PostgreSQL 会把**不加引号**的标识符统统折叠成小写。
      //    而 Prisma 建表时列名是带引号的 "paidAt"（大小写敏感）——
      //    于是裸写 paidAt 会被当成 paidat，报
      //    「字段 "paidat" 不存在」（SQLSTATE 42703）。
      //
      //    SQLite 的标识符不区分大小写，所以原来的 SQL 裸写是没问题的 ——
      //    这也是为什么这个问题只在换库之后才出现，而且**不是所有查询都会报**：
      //    只有引用了「驼峰命名的列」的那些才会。
      //    以后往这里加原生 SQL，凡是 Prisma 生成的列名，一律加双引号。
      //    （表名 orders 是小写，加不加都一样，但加了更一致）
      //
      // 注意：PostgreSQL 的 SUM(integer) 返回 bigint，驱动可能把它
      // 反序列化成 JS 的 BigInt，也可能是字符串（取决于 bigint 类型解析器），
      // 所以下面用 Number() 收口 —— 它对两种形状都成立
      prisma.$queryRaw<{ day: string; revenue: bigint | string | null }[]>`
        SELECT to_char("paidAt" AT TIME ZONE 'UTC' AT TIME ZONE ${localTimeZone()}, 'YYYY-MM-DD') AS day,
               SUM("totalAmount") AS revenue
        FROM "orders"
        WHERE "status" != ${ORDER_STATUS.CANCELLED}
          AND "paidAt" >= ${trend.gte}
          AND "paidAt" < ${trend.lt}
        GROUP BY day
        ORDER BY day ASC
      `,
    ])

  const statusStats = toStatusRecord(allByStatus)
  const todayStats = toStatusRecord(todayByStatus)

  return {
    statusStats,
    totalOrders: ORDER_STATUS_VALUES.reduce(
      (sum, status) => sum + statusStats[status],
      0,
    ),

    todayOrderCount: ORDER_STATUS_VALUES.reduce(
      (sum, status) => sum + todayStats[status],
      0,
    ),
    todayPaidOrderCount: revenue._count._all,
    // _sum 全是 null 时会返回 null（今天一笔都没付），兜底成 0
    todayRevenue: revenue._sum.totalAmount ?? 0,

    // 待发货就是「已支付」那一格，不用再查一次
    pendingShipmentCount: statusStats[ORDER_STATUS.PAID],

    lowStockSkuCount: lowStockByProduct.reduce(
      (sum, row) => sum + row._count._all,
      0,
    ),
    lowStockProductCount: lowStockByProduct.length,

    // _sum 可能为 null 的日子（没有订单）SQL 不会返回那一行，
    // 交给 buildSalesTrend 补成连续的 7 天、缺的补 0
    salesTrend: buildSalesTrend(
      trendRows.map((r) => ({ day: r.day, revenue: Number(r.revenue ?? 0) })),
      now,
    ),
  }
}
