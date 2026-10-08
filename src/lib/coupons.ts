// ============================================================================
// 优惠券 —— 纯计算部分
//
// 【为什么单独一个文件，不和 coupons-db.ts 放一起】
// 和 src/lib/favorites.ts / favorites-db.ts 是同一条分界线：
//   coupons.ts     → 只有数学和文案，不 import prisma，客户端组件能直接用
//   coupons-db.ts  → 查库/写库，import prisma，只能在服务端
// 不是洁癖：结算页要在**浏览器里**实时算「选中这张券能减多少」，
// 那个组件是 "use client"。只要它（哪怕间接）import 到 prisma，
// next build 就会报 Can't resolve 'fs' —— 这个坑在第 4 步踩过一次了。
//
// 【这个文件里全是「钱的算术」，所以每条规则都要能对着数字验算】
// PERCENT 用 Math.round 而不是 Math.floor：899 元的鞋打 9 折是 359.1 元，
// 向下取整会变成 359.09，用户少付了一分钱平台亏，反过来向下取整折扣
// 就成了「多收用户一分钱」—— 那才是会被投诉的那个方向。
// round 是四舍五入，误差最大 0.5 分，且不偏向任何一方。
// ============================================================================

import {
  COUPON_TYPE,
  couponTypeSchema,
  type CouponType,
} from "@/lib/constants"
import { formatPriceShort, formatYuan } from "@/lib/format"

/**
 * 一条券的规则 —— 计算和展示都只需要这几个字段。
 *
 * 【为什么不直接用 Prisma 生成的 Coupon 类型】
 * 生成的类型里还有 usedCount / createdAt / updatedAt 这些和计算无关的东西。
 * 用一个「瘦」类型当参数，好处有两个：
 *   1. 单元的算法测试构造数据时不用把十几个字段都填上
 *   2. 哪天 Coupon 表加了字段，这个函数和它的测试都不用动
 */
export type CouponRule = {
  id: string
  code: string
  type: CouponType
  /** FIXED 是减免的分；PERCENT 是要减掉的百分点（10 = 9 折） */
  value: number
  /** 门槛（分），0 表示无门槛。比较的是**订单商品原价合计**，不含优惠 */
  minSpend: number
  /** 封顶（分），只有 PERCENT 才有 */
  maxDiscount: number | null
  startAt: Date
  endAt: Date
  isActive: boolean
}

/** 计算时真正用到的字段（少到可以只写这三个就调函数） */
export type CouponMath = Pick<CouponRule, "type" | "value" | "maxDiscount">

// ---------------------------------------------------------------------------
// 折扣计算
// ---------------------------------------------------------------------------

/**
 * 算出这张券能减多少钱（分）。
 *
 * 【注意这是「不带任何校验」的纯算术】
 * 它不看有效期、不看门槛、不看停没停用 —— 那些是 couponUnusableReason
 * 的事。分开是为了让两条规则各自可测：这里只需要证明「899 减 50」，
 * 不需要在测试里先造一个日期没问题的券。
 *
 * 【为什么结果一定要夹在 [0, amount] 里】
 * FIXED 券有可能比订单还贵（满 10 减 100 的券买 5 块钱的东西）。
 * 不夹的话 discount = 10000 > amount = 500，实付变成 -50 元 ——
 * 负数金额会一路污染到报表、支付、对账。夹住之后语义是「免单」：
 * 最多减到 0，平台不欠用户钱。
 */
export function calcCouponDiscount(
  coupon: CouponMath,
  amountCents: number,
): number {
  // 订单金额不可能是负数，但函数是 public 的，兜一层不亏
  if (amountCents <= 0) return 0

  let discount: number

  if (coupon.type === COUPON_TYPE.PERCENT) {
    // PERCENT：value 是「减掉的百分比」，10 表示减 10%。
    // 先乘后除（amount * value / 100）而不是先算小数（amount * (value/100)）：
    // value/100 在 value 取不到整十的时候是个无限小数（比如 15/100 = 0.15
    // 在二进制里就是循环的），乘回去会带出零点几分的误差。
    const proportional = Math.round((amountCents * coupon.value) / 100)
    // maxDiscount 为 null = 不封顶。用 Infinity 而不是「跳过这步」，
    // 是为了让封顶和夹取只有一条路径 —— 分支越多越容易漏
    discount = Math.min(proportional, coupon.maxDiscount ?? Number.POSITIVE_INFINITY)
  } else {
    // FIXED：value 直接就是减免的分
    discount = coupon.value
  }

  return Math.max(0, Math.min(discount, amountCents))
}

// ---------------------------------------------------------------------------
// 可用性判断
// ---------------------------------------------------------------------------

/** 当前时间是不是落在券的有效期内（含首尾） */
export function isCouponInWindow(
  coupon: Pick<CouponRule, "startAt" | "endAt">,
  now: Date,
): boolean {
  return now >= coupon.startAt && now <= coupon.endAt
}

/** 金额够不够用这张券（只看门槛，不看有效期） */
export function isMinSpendMet(
  coupon: Pick<CouponRule, "minSpend">,
  amountCents: number,
): boolean {
  return amountCents >= coupon.minSpend
}

/**
 * 这张券现在为什么用不了？能用返回 null。
 *
 * 【为什么返回「原因」而不是一个 boolean】
 * 三个页面都要用，但需要的粒度不同：
 *   - 结算页：只要 isUsable，不能用的干脆不列出来
 *   - 我的券：要显示「已过期」「还差 ¥120 可用」—— 光把券灰掉，
 *     用户会以为是网站坏了，必须说明白
 *   - 下单事务：拿到原因直接当报错文案抛出去
 * 如果只返回 boolean，这三个地方就得各写一遍判断，而且迟早写歪
 * （比如结算页忘了判 minSpend，用户选中了又在下单时被拒）
 *
 * 【判断顺序是有讲究的】
 * 先判券本身（停用/过期），再判这笔订单（金额够不够）。
 * 一张「已停用且金额不够」的券，对用户来说正确的原因是「已停用」——
 * 告诉他「再买 200 元就能用」是骗人的，他凑够钱这张券照样用不了。
 */
export function couponUnusableReason(
  coupon: CouponRule,
  amountCents: number,
  now: Date,
): string | null {
  if (!coupon.isActive) return "已停用"
  if (now < coupon.startAt) return "还没开始"
  if (now > coupon.endAt) return "已过期"
  if (amountCents < coupon.minSpend) {
    return `还差 ${formatYuan(coupon.minSpend - amountCents)} 元可用`
  }
  return null
}

/**
 * 「这张券用在这笔订单上」的完整答案：能减多少 / 为什么不能。
 *
 * 【为什么要有这么一个「校验 + 计算」的函数，而不是两处分别调】
 * 因为**下单时必须重新算一遍**。结算页算出来的折扣是给用户看的预览，
 * 它经过浏览器、可以被改；服务端拿到 userCouponId 之后必须自己
 * 按库里的券和库里的购物车重算。如果这两处用的是两份不同的代码，
 * 迟早会出现「页面显示减 100、实际减了 50」，而且极难发现。
 * 共用这一个函数，页面和服务端就是同一个口径。
 */
export type CouponResolution =
  | { ok: true; discountCents: number }
  | { ok: false; reason: string }

export function resolveCouponDiscount(
  coupon: CouponRule,
  amountCents: number,
  now: Date,
): CouponResolution {
  const reason = couponUnusableReason(coupon, amountCents, now)
  if (reason) return { ok: false, reason }
  return { ok: true, discountCents: calcCouponDiscount(coupon, amountCents) }
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * PERCENT 的 value → 中文折扣说法。
 * 10 → "9"，15 → "8.5"，1 → "9.9"，99 → "0.1"
 *
 * 【为什么是 (100 - value) / 10】
 * value 是「减掉的百分点」，折扣率 = (100 - value)%。
 * 中文的「折」是「十分之几」，所以要再除以 10：
 *   减 10% → 折扣率 90% → 9 折
 *   减 15% → 折扣率 85% → 8.5 折
 * 最后把没用的零去掉（9.0 折读起来很怪），但不能用 toFixed(1) 之后再切
 * —— 那只是把 "9.0" 变成 "9"，遇到 8.25 折这种就全错了。
 * 这里用 Number() 归一：Number("9.0") 就是 9，Number("8.5") 还是 8.5。
 */
export function percentDiscountLabel(value: number): string {
  return String(Number(((100 - value) / 10).toFixed(1)))
}

/**
 * 券的一行式描述，用在列表、订单详情、下拉选项里。
 *   FIXED + 有门槛  → "满 800 减 100"
 *   FIXED 无门槛    → "立减 100"
 *   PERCENT 有封顶  → "9 折，最多减 50"
 *   PERCENT 无封顶  → "9 折"
 *
 * 【为什么门槛写成「满 X 减 Y」而不是「满 X 可用」】
 * 用户扫一眼券的时候，最想知道的是「能省多少」。门槛是条件，
 * 减多少是收益 —— 收益要放在最后，因为那是视线停留的位置。
 */
export function couponLabel(coupon: CouponRule): string {
  if (coupon.type === COUPON_TYPE.PERCENT) {
    const base = `${percentDiscountLabel(coupon.value)} 折`
    return coupon.maxDiscount === null
      ? base
      : `${base}，最多减 ${formatYuan(coupon.maxDiscount)}`
  }

  const amount = formatYuan(coupon.value)
  return coupon.minSpend > 0
    ? `满 ${formatYuan(coupon.minSpend)} 减 ${amount}`
    : `立减 ${amount}`
}

// ---------------------------------------------------------------------------
// 「我的券」的状态
// ---------------------------------------------------------------------------

/**
 * 一张已领到手的券，此刻处在什么状态。
 *
 * 【为什么这个状态不存进数据库】
 * 它是**当前时间**的函数：同一张券，今天看是「未使用」，明天看就是
 * 「已过期」，而后天管理员把 endAt 一延长，它又变回「未使用」——
 * 数据一个字节都没变。存成字段就得有个定时任务去刷它，一旦哪次没跑到，
 * 页面上就会出现「已经过期却显示未使用」的券。不如每次现算。
 * （usedAt 是唯一的例外：那是「什么时候用的」这个事实，必须存。）
 *
 * 【为什么判断顺序是 used → disabled → expired】
 * 已经用掉的券，哪怕后来这张券被停用、或者过了有效期，用户心里它都是
 * 「我用过的那张券」。把 used 放最前面，历史订单里用过的券就永远待在
 * 「已使用」那一栏，不会因为运营改了配置而跑到「已过期」去。
 */
export const MY_COUPON_STATUS = {
  UNUSED: "unused",
  USED: "used",
  EXPIRED: "expired",
  /** 券被管理员停用了 —— 和过期一样用不了，但原因不同，界面上要分开说 */
  DISABLED: "disabled",
} as const

export type MyCouponStatus =
  (typeof MY_COUPON_STATUS)[keyof typeof MY_COUPON_STATUS]

export function myCouponStatus(
  coupon: Pick<CouponRule, "isActive" | "endAt">,
  usedAt: Date | null,
  now: Date,
): MyCouponStatus {
  if (usedAt !== null) return MY_COUPON_STATUS.USED
  if (!coupon.isActive) return MY_COUPON_STATUS.DISABLED
  if (now > coupon.endAt) return MY_COUPON_STATUS.EXPIRED
  return MY_COUPON_STATUS.UNUSED
}

/**
 * 券面上的「大字」—— 领券卡片左边那一块最显眼的地方。
 *   FIXED 100 元  → "¥100"
 *   PERCENT 减 10 → "9 折"
 *
 * 【为什么折扣券不写「9 折」以外的形式】
 * 「减 10%」和「9 折」是同一个意思，但用户扫券的时候看的是大字，
 * 「9 折」比「减 10%」短、也不用做心理换算。门槛和封顶这些附加条件
 * 放在小字里（couponThresholdText + couponLabel），大字只留最核心的信息。
 */
export function couponFaceValue(coupon: CouponRule): string {
  return coupon.type === COUPON_TYPE.PERCENT
    ? `${percentDiscountLabel(coupon.value)} 折`
    : formatPriceShort(coupon.value)
}

/**
 * 券的使用门槛文案：「满 800 元可用」/「无门槛」。
 *
 * 【为什么和 couponLabel 里的「满 800 减 100」重复了一个数字】
 * 两者出现的场景不同：couponLabel 是列表里的一行摘要（门槛+收益一起说），
 * 这里是卡片上大字底下那行条件 —— 大字已经把收益说完了（¥100），
 * 这里只需要补条件。硬把 couponLabel 塞进卡片会出现
 * 「¥100 / 满 800 减 100」这种把同一个信息说两遍的排版。
 */
export function couponThresholdText(coupon: CouponRule): string {
  return coupon.minSpend > 0
    ? `满 ${formatYuan(coupon.minSpend)} 元可用`
    : "无门槛"
}

/**
 * 券码的规范形式：去空格 + 转大写。
 *
 * 【为什么大小写不敏感】
 * 券码是给人念、给人抄的（"save10" 和 "SAVE10" 当然该是同一张券）。
 *
 * 【为什么归一化只写这一个函数，而不是入库转大写、查询再 toUpperCase()】
 * 两处各写一遍就等于这条规则有两个定义。这里被 couponCodeSchema
 * （写库前）和将来的按码查询共用 —— 规则只有一份，就不会出现
 * 「存进去是大写、查的时候忘了转，于是查不到」这种经典 bug。
 */
export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase()
}

/**
 * 从数据库读出来的 type 是 String（SQLite 没有 enum），收窄成 CouponType。
 * 和 orders 那边处理 status 一样：数据只经由后台表单写入、写入前过了 zod，
 * 所以这里直接断言；真出现脏数据，会让下面的计算走到 FIXED 分支
 * （不是 PERCENT 就当满减券），不会抛异常把订单页面整个搞崩。
 */
export function toCouponType(raw: string): CouponType {
  const parsed = couponTypeSchema.safeParse(raw)
  return parsed.success ? parsed.data : COUPON_TYPE.FIXED
}
