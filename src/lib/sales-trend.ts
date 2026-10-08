// ============================================================================
// 近 7 天销售额趋势 —— **纯逻辑，不碰数据库**
//
// 【为什么单独一个文件，而不是留在 dashboard.ts 里】
// 这些函数本来是 dashboard.ts 的一部分，但它们一行数据库代码都不需要：
// 输入是「SQL 按天聚合出来的行」，输出是「补齐的 7 个点」。
//
// 问题出在 dashboard.ts 顶部有 `import { prisma } from "@/lib/prisma"`。
// 纯函数住在那个文件里，单元测试为了拿到它就不得不把 prisma 一起拖进来 ——
// 于是「测一个补零的循环」变成「起一个数据库客户端」。
// 这和 src/lib/refunds.ts（纯）对 refunds-db.ts（数据库）是同一个分法，
// 理由也一样：**纯逻辑必须能脱离 prisma 被 import**。
//
// 什么时候会真的咬人：prisma.ts 现在会在 DATABASE_URL 没配时直接抛错
// （宁可明确报错，也不要静默连到某个默认地址）。单元测试环境里没有那个
// 变量，于是整个测试文件在 import 阶段就炸了。分开之后，
// 这个文件不 import prisma，测试也就不会碰到那件事。
//
// 【和 SQL 的接口】
// 调用方（dashboard.ts）负责那条 SQL，并且必须让 SQL 输出的 day 字符串
// 和这里的 toLocalDayKey 是**同一种形状**（本地时区的 YYYY-MM-DD）。
// 两边一旦用了不同的时区口径，表现是折线上的点整体错一天 ——
// 而它只在「刚过零点」那几个小时里错，平时看都是对的。
// 所以这里把口径写死在 §toLocalDayKey 的注释里。
// ============================================================================

import { startOfDay, startOfTomorrow } from "@/lib/dates"

/** 趋势图显示的天数（含今天） */
export const SALES_TREND_DAYS = 7

export type SalesTrendPoint = {
  /** 这一天的自然日零点（本地时区），图表按它画 X 轴刻度 */
  date: Date
  /** 当天销售额，单位：分。没卖出去的天是 0 */
  revenue: number
}

/**
 * 「近 7 天」的半开区间：[今天零点往前推 6 天, 明天零点)。
 * 左闭右开和 todayRange 同一个道理：每一天的每一毫秒都恰好落在一个区间里。
 */
export function trendRange(now: Date): { gte: Date; lt: Date } {
  const start = startOfDay(now)
  start.setDate(start.getDate() - (SALES_TREND_DAYS - 1))
  return { gte: start, lt: startOfTomorrow(now) }
}

/**
 * 本地日期的 "YYYY-MM-DD"。
 *
 * 【这是和 SQL 对齐的那个口径，动它要连着 SQL 一起动】
 * 用本地 getFullYear/getMonth/getDate 拼，而不是 toISOString() ——
 * 后者按 UTC 切，而页面上「今天」是按服务器本地时间算的（见 todayRange）。
 * 两边口径不一致，折线上的「今天」就会错位。
 *
 * 换成 PostgreSQL 之前，SQL 那边是 strftime(..., 'localtime')，
 * 靠 SQLite 自己把时间戳转成本地时间再切。PostgreSQL 没有这个修饰符，
 * 现在的写法是显式把时区名传进去（见 dashboard.ts 里那条 SQL 的注释）——
 * 传的正是 JS 这边的时区名，所以两边口径从此是**同一个来源**，
 * 不再是「SQLite 的 localtime 恰好等于 JS 的 local」这种巧合。
 */
export function toLocalDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/**
 * 把 groupBy 查出来的（只含有销售额的那几天）补成完整的 7 天。
 *
 * 【为什么需要这一步】
 * SQL 的 GROUP BY 不会返回「销售额为 0」的日子 —— 没有行就没有组。
 * 而折线图需要连续的 7 个点：中间缺了某天，线就会从 3 号直接跳到 5 号，
 * 看起来像「那两天没有数据」而不是「那两天卖了 0 元」。
 * 所以这里按日期对齐，缺的天补 0，保证永远返回 SALES_TREND_DAYS 个点。
 *
 * 这个函数不碰数据库，纯输入 → 纯输出，所以能直接写单元测试。
 */
export function buildSalesTrend(
  rows: { day: string; revenue: number }[],
  now: Date = new Date(),
): SalesTrendPoint[] {
  const { gte } = trendRange(now)
  const byDay = new Map(rows.map((r) => [r.day, r.revenue]))

  const points: SalesTrendPoint[] = []
  for (let i = 0; i < SALES_TREND_DAYS; i++) {
    const date = new Date(gte)
    date.setDate(gte.getDate() + i)
    points.push({ date, revenue: byDay.get(toLocalDayKey(date)) ?? 0 })
  }
  return points
}

/**
 * 当前服务器进程所在时区的 IANA 名字（比如 "Asia/Shanghai"）。
 *
 * 【为什么要把它传进 SQL】
 * PostgreSQL 没有 SQLite 的 'localtime' 修饰符，要在 SQL 里得到一个
 * 「本地时间」的时间戳，必须明确告诉它「按哪个时区的口径算」。
 * 这个值取自 JS 运行时，和 toLocalDayKey / todayRange 用的是同一个时区 ——
 * 这是保证 SQL 和 JS 口径一致的关键，而不是各自假设一个。
 *
 * 取不到时的兜底是 "UTC"：那个情况下两边可能错一天，
 * 但至少不会因为一个 undefined 让整页 500。
 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
