import { describe, expect, it } from "vitest"

import { COUPON_TYPE } from "@/lib/constants"
import {
  calcCouponDiscount,
  couponFaceValue,
  couponLabel,
  couponThresholdText,
  couponUnusableReason,
  isCouponInWindow,
  isMinSpendMet,
  MY_COUPON_STATUS,
  myCouponStatus,
  normalizeCouponCode,
  percentDiscountLabel,
  resolveCouponDiscount,
  toCouponType,
  type CouponRule,
} from "@/lib/coupons"

// ============================================================================
// 优惠券的折扣计算与可用性判断 —— src/lib/coupons.ts
//
// 【为什么这一组要用「验收口径里的真实数字」来测，而不是随便编几个】
// 需求里给的两个例子就是这两条：
//     899 元的鞋，9 折最多减 50  → 实付 84900
//     399 元的鞋，9 折封顶未到  → 实付 35910
// 拿它们当测试用例，一是能证明公式对，二是这两个数字背后有真实含义
// （一个撞了封顶、一个没撞），随手编的 100 和 200 恰好会漏掉封顶那条路径。
//
// 【为什么折扣函数要单测到「分」】
// 差一分钱用户会投诉，这话不是修辞。金额是 Int 分，Math.round 和
// Math.floor 的差别在 399 元这种数上刚好会显形（39900 * 10% = 3990 整，
// 换 399.05 元就是 3990.5，向下取整少减半分钱）。所以边界值必须逐个钉死。
// ============================================================================

/**
 * 造一条券，只写这个用例关心的字段，其余给一套合理的默认值。
 *
 * 【默认有效期为什么给得这么宽（2020 ~ 2030）】
 * 因为绝大多数用例根本不关心时间，只想测「折扣怎么算」。
 * 默认值窄一点（比如「今天前后一天」）的话，这些用例就得跟着
 * 系统时间走 —— 而下面几个可用性用例又偏偏要用固定的 2026-10 当「现在」，
 * 于是「默认有效期」和「固定的现在」很容易对不上，测试就会莫名其妙地
 * 报「已过期」。给一个足够宽、覆盖测试里所有「现在」的窗口，
 * 时间相关的行为就只在专门测它的用例里被 override 出来。
 */
function makeCoupon(overrides: Partial<CouponRule> = {}): CouponRule {
  return {
    id: "coupon_test",
    code: "TEST",
    type: COUPON_TYPE.FIXED,
    value: 10000,
    minSpend: 0,
    maxDiscount: null,
    startAt: new Date("2020-01-01T00:00:00Z"),
    endAt: new Date("2030-01-01T00:00:00Z"),
    isActive: true,
    ...overrides,
  }
}

/** 需求里那张「9 折，最多减 50」的券 */
function nineOffCappedAt50(overrides: Partial<CouponRule> = {}): CouponRule {
  return makeCoupon({
    type: COUPON_TYPE.PERCENT,
    value: 10, // 10 = 减 10% = 9 折
    maxDiscount: 5000,
    minSpend: 0,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 折扣计算：FIXED
// ---------------------------------------------------------------------------
describe("calcCouponDiscount —— 满减券", () => {
  it("直接减去 value", () => {
    const coupon = makeCoupon({ value: 10000 }) // 减 100 元
    expect(calcCouponDiscount(coupon, 89900)).toBe(10000)
  })

  it("订单金额小于券面额时，最多减到 0，不会变成负数", () => {
    // 满 10 减 100 的券买 5 块钱的东西：不能减出 -50 元
    const coupon = makeCoupon({ value: 10000 })
    expect(calcCouponDiscount(coupon, 500)).toBe(500)
  })

  it("金额正好等于券面额 → 免单（减到 0）", () => {
    const coupon = makeCoupon({ value: 5000 })
    expect(calcCouponDiscount(coupon, 5000)).toBe(5000)
  })

  it("金额为 0 或负数 → 减 0", () => {
    const coupon = makeCoupon({ value: 10000 })
    expect(calcCouponDiscount(coupon, 0)).toBe(0)
    expect(calcCouponDiscount(coupon, -100)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 折扣计算：PERCENT
// ---------------------------------------------------------------------------
describe("calcCouponDiscount —— 折扣券", () => {
  it("验收口径：899 元的鞋，9 折最多减 50 → 减 5000（撞了封顶）", () => {
    // 89900 * 10% = 8990，封顶 5000，所以减 5000
    // 实付 = 89900 - 5000 = 84900
    expect(calcCouponDiscount(nineOffCappedAt50(), 89900)).toBe(5000)
  })

  it("验收口径：399 元的鞋，9 折 → 减 3990（没撞封顶）", () => {
    // 39900 * 10% = 3990 < 5000，所以按比例减
    // 实付 = 39900 - 3990 = 35910
    expect(calcCouponDiscount(nineOffCappedAt50(), 39900)).toBe(3990)
  })

  it("按比例算出来有零头时四舍五入，不是向下取整", () => {
    // 199.99 元的商品减 15%：19999 * 15 / 100 = 2999.85 → 3000
    // 用 Math.floor 会得到 2999，用户少减一分钱
    const coupon = makeCoupon({
      type: COUPON_TYPE.PERCENT,
      value: 15,
      maxDiscount: null,
    })
    expect(calcCouponDiscount(coupon, 19999)).toBe(3000)
  })

  it("maxDiscount 为 null 时不封顶", () => {
    const coupon = makeCoupon({
      type: COUPON_TYPE.PERCENT,
      value: 10,
      maxDiscount: null,
    })
    // 十万块的单子减一成 = 一万
    expect(calcCouponDiscount(coupon, 10_000_000)).toBe(1_000_000)
  })

  it("封顶值大于按比例算出来的值时，取小的那个", () => {
    const coupon = makeCoupon({
      type: COUPON_TYPE.PERCENT,
      value: 10,
      maxDiscount: 999_999,
    })
    expect(calcCouponDiscount(coupon, 10000)).toBe(1000)
  })

  it("比例算出来是 0（金额太小）→ 减 0，不是减 1", () => {
    // 1 分钱的订单减 10% = 0.1 分，四舍五入是 0
    const coupon = makeCoupon({
      type: COUPON_TYPE.PERCENT,
      value: 10,
      maxDiscount: null,
    })
    expect(calcCouponDiscount(coupon, 1)).toBe(0)
  })

  it("结果永远不超过订单金额", () => {
    // value 99（减 99%）+ 不封顶，理论上减 99%，不会超；但金额极其小的时候
    // 四舍五入有可能算出等于金额的数 —— 那也就是免单，不能更多
    const coupon = makeCoupon({
      type: COUPON_TYPE.PERCENT,
      value: 99,
      maxDiscount: null,
    })
    expect(calcCouponDiscount(coupon, 3)).toBeLessThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// 门槛 / 有效期
// ---------------------------------------------------------------------------
describe("isMinSpendMet / isCouponInWindow", () => {
  it("金额等于门槛算满足（「满 800」包含 800）", () => {
    const coupon = makeCoupon({ minSpend: 80000 })
    expect(isMinSpendMet(coupon, 80000)).toBe(true)
    expect(isMinSpendMet(coupon, 79999)).toBe(false)
  })

  it("有效期含首尾两天", () => {
    const start = new Date("2026-10-01T00:00:00Z")
    const end = new Date("2026-10-31T23:59:59.999Z")
    const coupon = makeCoupon({ startAt: start, endAt: end })

    expect(isCouponInWindow(coupon, start)).toBe(true)
    expect(isCouponInWindow(coupon, end)).toBe(true)
    expect(isCouponInWindow(coupon, new Date(start.getTime() - 1))).toBe(false)
    expect(isCouponInWindow(coupon, new Date(end.getTime() + 1))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 不可用原因
// ---------------------------------------------------------------------------
describe("couponUnusableReason", () => {
  const now = new Date("2026-10-15T12:00:00Z")

  it("能用时返回 null", () => {
    expect(couponUnusableReason(makeCoupon(), 10000, now)).toBeNull()
  })

  it("停用 → 已停用", () => {
    expect(
      couponUnusableReason(makeCoupon({ isActive: false }), 10000, now),
    ).toBe("已停用")
  })

  it("还没开始 → 还没开始", () => {
    const coupon = makeCoupon({
      startAt: new Date("2026-11-01T00:00:00Z"),
      endAt: new Date("2026-12-01T00:00:00Z"),
    })
    expect(couponUnusableReason(coupon, 10000, now)).toBe("还没开始")
  })

  it("过期 → 已过期", () => {
    const coupon = makeCoupon({
      startAt: new Date("2026-09-01T00:00:00Z"),
      endAt: new Date("2026-10-01T00:00:00Z"),
    })
    expect(couponUnusableReason(coupon, 10000, now)).toBe("已过期")
  })

  it("金额不够 → 说清楚还差多少", () => {
    const coupon = makeCoupon({ minSpend: 80000 })
    // 600 元的订单，门槛 800，差 200 元
    expect(couponUnusableReason(coupon, 60000, now)).toBe("还差 200 元可用")
  })

  it("「停用」优先于「金额不够」——不能骗用户去凑单", () => {
    // 一张停用且金额不够的券，正确原因是「已停用」。
    // 说「还差 200 元可用」的话，用户凑够钱会发现照样不能用
    const coupon = makeCoupon({ isActive: false, minSpend: 80000 })
    expect(couponUnusableReason(coupon, 100, now)).toBe("已停用")
  })

  it("「过期」优先于「金额不够」", () => {
    const coupon = makeCoupon({
      minSpend: 80000,
      endAt: new Date("2026-10-01T00:00:00Z"),
    })
    expect(couponUnusableReason(coupon, 100, now)).toBe("已过期")
  })
})

// ---------------------------------------------------------------------------
// resolveCouponDiscount：校验 + 计算的合体
// ---------------------------------------------------------------------------
describe("resolveCouponDiscount", () => {
  const now = new Date("2026-10-15T12:00:00Z")

  it("能用 → 直接给出折扣", () => {
    const result = resolveCouponDiscount(nineOffCappedAt50(), 89900, now)
    expect(result).toEqual({ ok: true, discountCents: 5000 })
  })

  it("不能用 → 带原因，且不给出折扣", () => {
    const coupon = makeCoupon({ minSpend: 80000 })
    const result = resolveCouponDiscount(coupon, 60000, now)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: "还差 200 元可用" })
  })

  it("和单独调用 calcCouponDiscount 的结果一致（页面预览和服务端重算同口径）", () => {
    const coupon = nineOffCappedAt50()
    const resolved = resolveCouponDiscount(coupon, 39900, now)
    expect(resolved).toEqual({
      ok: true,
      discountCents: calcCouponDiscount(coupon, 39900),
    })
  })
})

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------
describe("券的文案", () => {
  it("满减券：有门槛写「满 X 减 Y」", () => {
    const coupon = makeCoupon({ value: 10000, minSpend: 80000 })
    expect(couponLabel(coupon)).toBe("满 800 减 100")
  })

  it("满减券：无门槛写「立减 Y」", () => {
    const coupon = makeCoupon({ value: 3000, minSpend: 0 })
    expect(couponLabel(coupon)).toBe("立减 30")
  })

  it("满减券：金额带零头时保留两位小数", () => {
    const coupon = makeCoupon({ value: 1250, minSpend: 9900 })
    expect(couponLabel(coupon)).toBe("满 99 减 12.50")
  })

  it("折扣券：写「X 折，最多减 Y」", () => {
    expect(couponLabel(nineOffCappedAt50())).toBe("9 折，最多减 50")
  })

  it("折扣券：不封顶时不写封顶那句", () => {
    const coupon = makeCoupon({
      type: COUPON_TYPE.PERCENT,
      value: 10,
      maxDiscount: null,
    })
    expect(couponLabel(coupon)).toBe("9 折")
  })

  it("折扣百分比换算：9 折是 value 10，8.5 折是 value 15", () => {
    expect(percentDiscountLabel(10)).toBe("9")
    expect(percentDiscountLabel(15)).toBe("8.5")
    expect(percentDiscountLabel(1)).toBe("9.9")
    expect(percentDiscountLabel(50)).toBe("5")
    expect(percentDiscountLabel(99)).toBe("0.1")
  })
})

// ---------------------------------------------------------------------------
// 券面文案（领券卡片、我的券卡片共用）
// ---------------------------------------------------------------------------
describe("couponFaceValue / couponThresholdText", () => {
  it("满减券的大字是钱：¥100", () => {
    expect(couponFaceValue(makeCoupon({ value: 10000 }))).toBe("¥100")
  })

  it("满减券带零头时是 ¥12.50，不是 ¥12.5", () => {
    expect(couponFaceValue(makeCoupon({ value: 1250 }))).toBe("¥12.50")
  })

  it("折扣券的大字是折扣：9 折 / 8.5 折", () => {
    expect(couponFaceValue(nineOffCappedAt50())).toBe("9 折")
    expect(
      couponFaceValue(
        makeCoupon({ type: COUPON_TYPE.PERCENT, value: 15, maxDiscount: 5000 }),
      ),
    ).toBe("8.5 折")
  })

  it("门槛：有门槛写「满 X 元可用」，没门槛写「无门槛」", () => {
    expect(couponThresholdText(makeCoupon({ minSpend: 80000 }))).toBe("满 800 元可用")
    expect(couponThresholdText(makeCoupon({ minSpend: 0 }))).toBe("无门槛")
  })
})

// ---------------------------------------------------------------------------
// 「我的券」的状态
// ---------------------------------------------------------------------------
describe("myCouponStatus", () => {
  const now = new Date("2026-10-15T12:00:00Z")
  /** 只关心 isActive / endAt 两个字段，其余不重要 */
  const rule = (overrides: Partial<CouponRule> = {}) =>
    makeCoupon({
      startAt: new Date("2026-10-01T00:00:00Z"),
      endAt: new Date("2026-10-31T23:59:59Z"),
      ...overrides,
    })

  it("没用过、还在有效期内 → unused", () => {
    expect(myCouponStatus(rule(), null, now)).toBe(MY_COUPON_STATUS.UNUSED)
  })

  it("用过 → used", () => {
    expect(myCouponStatus(rule(), new Date("2026-10-10T08:00:00Z"), now)).toBe(
      MY_COUPON_STATUS.USED,
    )
  })

  it("已经用掉的券，后来过期了、或者被停用了，仍然算「已使用」", () => {
    // 这是刻意的：用户心里「我用过的那张券」不该因为运营改了配置
    // 就跑到「已过期」那一栏去
    const usedAt = new Date("2026-10-10T08:00:00Z")
    expect(
      myCouponStatus(rule({ endAt: new Date("2026-10-12T00:00:00Z") }), usedAt, now),
    ).toBe(MY_COUPON_STATUS.USED)
    expect(myCouponStatus(rule({ isActive: false }), usedAt, now)).toBe(
      MY_COUPON_STATUS.USED,
    )
  })

  it("过了 endAt 还没用 → expired", () => {
    expect(
      myCouponStatus(rule({ endAt: new Date("2026-10-14T23:59:59Z") }), null, now),
    ).toBe(MY_COUPON_STATUS.EXPIRED)
  })

  it("被停用（但还没过期）→ disabled，和「已过期」分开", () => {
    // 分开的理由：过期是自然的，停用是运营的决定。页面上的角标文案不一样，
    // 但两者都归到「已过期」那个 tab —— 因为对用户来说结果都是「用不了」
    expect(myCouponStatus(rule({ isActive: false }), null, now)).toBe(
      MY_COUPON_STATUS.DISABLED,
    )
  })

  it("结束时间就是「现在」这一秒时仍然算 unused（含端点）", () => {
    expect(myCouponStatus(rule({ endAt: now }), null, now)).toBe(
      MY_COUPON_STATUS.UNUSED,
    )
  })

  it("还没到 startAt 的券算 unused（它只是还不能用，没作废）", () => {
    expect(
      myCouponStatus(rule({ startAt: new Date("2026-11-01T00:00:00Z") }), null, now),
    ).toBe(MY_COUPON_STATUS.UNUSED)
  })
})

// ---------------------------------------------------------------------------
// 券码归一化 / 类型收窄
// ---------------------------------------------------------------------------
describe("normalizeCouponCode / toCouponType", () => {
  it("去空格 + 转大写", () => {
    expect(normalizeCouponCode("  save10 ")).toBe("SAVE10")
    expect(normalizeCouponCode("save10")).toBe("SAVE10")
  })

  it("合法的 type 原样收窄", () => {
    expect(toCouponType("PERCENT")).toBe(COUPON_TYPE.PERCENT)
    expect(toCouponType("FIXED")).toBe(COUPON_TYPE.FIXED)
  })

  it("脏数据兜底成 FIXED，而不是抛异常", () => {
    // SQLite 没有 enum，理论上有脏数据的可能。这里的选择是：
    // 当成满减券（大不了减 0），而不是让整个订单页崩掉
    const dirty: string = "WHATEVER"
    expect(toCouponType(dirty)).toBe(COUPON_TYPE.FIXED)
  })
})
