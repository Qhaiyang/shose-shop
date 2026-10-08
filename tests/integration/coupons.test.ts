import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS } from "@/lib/constants"
import { claimCoupon, getMyCoupons, getUsableCoupons } from "@/lib/coupons-db"
import { cancelExpiredOrders, createOrderFromCart } from "@/lib/orders"
import {
  addToCart,
  claimCountOf,
  expiredAt,
  giveCoupon,
  makeCoupon,
  makeShop,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
  stockOf,
  usedCountOf,
} from "./helpers/db"

// ============================================================================
// 优惠券：领券、可用性筛选、下单用券、并发占券、取消退券
//
// 【为什么这些用例非打真库不可】
// 这个功能里最要命的两件事都只发生在数据库里：
//   1. 「每人限领 N 张」是 INSERT ... SELECT ... WHERE 一条语句完成的
//      （见 coupons-db.ts 的 claimCoupon）—— 单测里没有 SQL，测不出来
//   2. 「限量 3 张的券被 10 个人同时用」只能靠数据库的条件更新来保证
// 拿假数据（mock）测这两件事，测的是我自己写的假实现，等于没测。
//
// 【断言为什么统统用「分」】
// 全站金额都是 Int 分，这一层不做任何「元」的换算。
// 需求里那句「实付 84900」在这里应该逐字写成 84900
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

const ADDRESS = "北京市朝阳区测试路 1 号"
const PHONE = "13800138000"

/** 需求里那张「9 折，最多减 50」的券 */
const nineOffCappedAt50 = {
  type: "PERCENT" as const,
  value: 10,
  maxDiscount: 5000,
}

// ---------------------------------------------------------------------------
// 领券
// ---------------------------------------------------------------------------
describe("领券", () => {
  it("领一张券，user_coupons 里多一条记录", async () => {
    const user = await makeUser()
    const coupon = await makeCoupon()

    const result = await claimCoupon(user.id, coupon.id)

    expect(result.ok).toBe(true)
    expect(await claimCountOf(user.id, coupon.id)).toBe(1)

    // 领来的券是「未使用」状态：usedAt 和 orderId 都还空着
    const myCoupons = await getMyCoupons(user.id)
    expect(myCoupons).toHaveLength(1)
    expect(myCoupons[0].usedAt).toBeNull()
    expect(myCoupons[0].orderId).toBeNull()
  })

  it("超过「每人限领」再领会被拒，而且不会多出一条记录", async () => {
    const user = await makeUser()
    const coupon = await makeCoupon({ perUserLimit: 2 })

    expect((await claimCoupon(user.id, coupon.id)).ok).toBe(true)
    expect((await claimCoupon(user.id, coupon.id)).ok).toBe(true)

    const third = await claimCoupon(user.id, coupon.id)
    expect(third.ok).toBe(false)
    // 报错里要说清楚是限领，而不是含糊的「失败」
    expect(third.ok === false && third.error).toContain("每人限领")

    // 关键：被拒的那次**什么都没写进去**
    expect(await claimCountOf(user.id, coupon.id)).toBe(2)
  })

  it("并发领券不会突破「每人限领」", async () => {
    // 【这是 atomic INSERT ... SELECT 的证明】
    // 朴素写法（先 count 再 insert）在这个测试下必然失败：
    // 10 个并发请求都读到「已领 0 张」，于是都插入，最后领到 10 张。
    const user = await makeUser()
    const coupon = await makeCoupon({ perUserLimit: 2 })

    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimCoupon(user.id, coupon.id)),
    )

    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(await claimCountOf(user.id, coupon.id)).toBe(2)
  })

  it("别人领了多少不影响我领", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()])
    const coupon = await makeCoupon({ perUserLimit: 1 })

    expect((await claimCoupon(a.id, coupon.id)).ok).toBe(true)
    // b 一张都没领过，限量是按人算的，不该被 a 影响
    expect((await claimCoupon(b.id, coupon.id)).ok).toBe(true)
  })

  it("停用 / 过期 / 没开始 / 已发完的券都领不到", async () => {
    const user = await makeUser()

    const disabled = await makeCoupon({ isActive: false })
    const expired = await makeCoupon({ endAt: expiredAt() })
    const notStarted = await makeCoupon({
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    // 已发完：核销次数已经顶到发放总量
    const soldOut = await makeCoupon({ totalLimit: 3, usedCount: 3 })

    for (const coupon of [disabled, expired, notStarted, soldOut]) {
      expect((await claimCoupon(user.id, coupon.id)).ok).toBe(false)
      expect(await claimCountOf(user.id, coupon.id)).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 结算页的可用券
// ---------------------------------------------------------------------------
describe("结算页列出可用券", () => {
  it("金额没到门槛的券不出现，刚好够就出现", async () => {
    const user = await makeUser()
    const coupon = await makeCoupon({ minSpend: 80000 }) // 满 800 元
    await giveCoupon(user.id, coupon.id)

    // 799 元：还差 1 元，不列
    expect(await getUsableCoupons(user.id, 79900)).toHaveLength(0)
    // 800 元：够（含等于），列出来
    expect(await getUsableCoupons(user.id, 80000)).toHaveLength(1)
  })

  it("过期 / 停用的券不出现", async () => {
    const user = await makeUser()
    const expired = await makeCoupon({ endAt: expiredAt() })
    const disabled = await makeCoupon({ isActive: false })
    await giveCoupon(user.id, expired.id)
    await giveCoupon(user.id, disabled.id)

    expect(await getUsableCoupons(user.id, 100000)).toHaveLength(0)
  })

  it("已经用掉的券不出现", async () => {
    const user = await makeUser()
    const coupon = await makeCoupon()
    const given = await giveCoupon(user.id, coupon.id)
    await prisma.userCoupon.update({
      where: { id: given.id },
      data: { usedAt: new Date() },
    })

    expect(await getUsableCoupons(user.id, 100000)).toHaveLength(0)
  })

  it("别人的券不会出现在我的可用列表里", async () => {
    const [me, other] = await Promise.all([makeUser(), makeUser()])
    const coupon = await makeCoupon()
    await giveCoupon(other.id, coupon.id)

    expect(await getUsableCoupons(me.id, 100000)).toHaveLength(0)
  })

  it("每张券的折扣金额在列表里就算好了，而且和验收口径一致", async () => {
    const user = await makeUser()

    const nine50 = await makeCoupon(nineOffCappedAt50)
    const save100 = await makeCoupon({ value: 10000, minSpend: 80000 })
    await giveCoupon(user.id, nine50.id)
    await giveCoupon(user.id, save100.id)

    // 899 元的鞋：9 折本该减 8990，但封顶 50 元 → 减 5000
    const for899 = await getUsableCoupons(user.id, 89900)
    expect(for899).toHaveLength(2)
    expect(for899.find((c) => c.coupon.id === nine50.id)?.discountCents).toBe(5000)
    expect(for899.find((c) => c.coupon.id === save100.id)?.discountCents).toBe(10000)

    // 399 元的鞋：9 折减 3990（没到封顶），满 800 的券门槛不够、直接不出现
    const for399 = await getUsableCoupons(user.id, 39900)
    expect(for399).toHaveLength(1)
    expect(for399[0].discountCents).toBe(3990)
  })
})

// ---------------------------------------------------------------------------
// 下单用券
// ---------------------------------------------------------------------------
describe("下单时用券", () => {
  it("满 800 减 100：实付 = 原价 - 100，券的账也一起写上", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 5 })
    const coupon = await makeCoupon({ value: 10000, minSpend: 80000 })
    const given = await giveCoupon(userId, coupon.id)
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })

    expect(result.ok).toBe(true)

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
      include: { items: true, coupon: true },
    })

    // 1. 钱对：原价 899、优惠 100、实付 799
    expect(order.totalAmount).toBe(79900)
    expect(order.discountAmount).toBe(10000)
    expect(order.couponId).toBe(coupon.id)

    // 2. 订单项里存的仍然是原价 —— 优惠是订单级的，不摊到每一件上
    expect(order.items[0].price).toBe(89900)

    // 3. 核销次数 +1
    expect(await usedCountOf(coupon.id)).toBe(1)

    // 4. 我那张券被标记成已用，并且挂到了这一单上
    const myCoupon = await prisma.userCoupon.findUniqueOrThrow({
      where: { id: given.id },
    })
    expect(myCoupon.usedAt).not.toBeNull()
    expect(myCoupon.orderId).toBe(order.id)
  })

  it("9 折最多减 50：899 的鞋实付 84900，399 的鞋实付 35910", async () => {
    // 需求里的两个数，一个撞了封顶、一个没撞。
    // 两张券分给两个用户，避免 perUserLimit 干扰
    const coupon = await makeCoupon({ ...nineOffCappedAt50, perUserLimit: 2 })

    const expensive = await makeShop({ price: 89900, stock: 3 })
    const cheap = await makeShop({ price: 39900, stock: 3 })
    const expensiveCoupon = await giveCoupon(expensive.userId, coupon.id)
    const cheapCoupon = await giveCoupon(cheap.userId, coupon.id)

    await addToCart(expensive.userId, expensive.sku.id, 1)
    await addToCart(cheap.userId, cheap.sku.id, 1)

    const r1 = await createOrderFromCart(expensive.userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: expensiveCoupon.id,
    })
    const r2 = await createOrderFromCart(cheap.userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: cheapCoupon.id,
    })

    const order1 = await prisma.order.findUniqueOrThrow({
      where: { id: r1.ok ? r1.orderId : "" },
    })
    const order2 = await prisma.order.findUniqueOrThrow({
      where: { id: r2.ok ? r2.orderId : "" },
    })

    // 89900 - min(round(89900 * 10%), 5000) = 89900 - 5000
    expect(order1.discountAmount).toBe(5000)
    expect(order1.totalAmount).toBe(84900)

    // 39900 - round(39900 * 10%) = 39900 - 3990
    expect(order2.discountAmount).toBe(3990)
    expect(order2.totalAmount).toBe(35910)
    // 同一张券用了两次，核销次数是 2
    expect(await usedCountOf(coupon.id)).toBe(2)
  })

  it("不是自己的券用不了（越权）", async () => {
    const [me, other] = await Promise.all([makeUser(), makeUser()])
    const product = await makeShop({ userId: me.id })
    await addToCart(me.id, product.sku.id, 1)

    const coupon = await makeCoupon()
    const othersCoupon = await giveCoupon(other.id, coupon.id)

    const result = await createOrderFromCart(me.id, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: othersCoupon.id,
    })

    expect(result.ok).toBe(false)
    // 关键：失败就意味着什么都没发生 —— 没有订单、没动券、没扣库存
    expect(await prisma.order.count()).toBe(0)
    expect(await usedCountOf(coupon.id)).toBe(0)
    expect(await stockOf(product.sku.id)).toBe(10)
    // 别人的券也没被标记成已用
    const untouched = await prisma.userCoupon.findUniqueOrThrow({
      where: { id: othersCoupon.id },
    })
    expect(untouched.usedAt).toBeNull()
  })

  it("随便编一个不存在的券 id 也是同样的结果", async () => {
    const { userId, sku } = await makeShop()
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: "not-a-real-id",
    })

    expect(result.ok).toBe(false)
    expect(await prisma.order.count()).toBe(0)
  })

  it("同一张券不能用两次", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 5 })
    const coupon = await makeCoupon({ value: 10000 })
    const given = await giveCoupon(userId, coupon.id)

    await addToCart(userId, sku.id, 1)
    const first = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })
    expect(first.ok).toBe(true)

    // 第二次：这张券已经被上一单核销了
    await addToCart(userId, sku.id, 1)
    const second = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })

    expect(second.ok).toBe(false)
    // 【为什么这一条的报错文案和别处不一样】
    // 券本身没过期也没停用，是「这张券实例已经被上一单核销了」——
    // 这个判断发生在事务里（updateMany 的 where 带着 usedAt: null，
    // 影响 0 行就回滚），所以文案来自 CouponUnavailableError
    expect(second.ok === false && second.error).toContain("已经用过")
    expect(await prisma.order.count()).toBe(1)
    // 券只被核销了一次
    expect(await usedCountOf(coupon.id)).toBe(1)
  })

  it("过期和停用的券，下单时会被拒（不是只在前台藏起来）", async () => {
    // 【为什么这条必须在服务端也测】
    // 前台不显示只是体验；用户完全可以直接构造请求把 userCouponId 传上来。
    // 这一条证明「就算传上来了，服务端也不认」
    const { userId, sku } = await makeShop({ stock: 5 })

    const expired = await makeCoupon({ endAt: expiredAt() })
    const disabled = await makeCoupon({ isActive: false })
    const expiredCoupon = await giveCoupon(userId, expired.id)
    const disabledCoupon = await giveCoupon(userId, disabled.id)

    // 加购一次就够：下单失败时购物车**不会被清空**（整个事务回滚了），
    // 第二次请求还能拿同一车东西再试一遍
    await addToCart(userId, sku.id, 1)

    for (const userCouponId of [expiredCoupon.id, disabledCoupon.id]) {
      const result = await createOrderFromCart(userId, {
        address: ADDRESS,
        phone: PHONE,
        userCouponId,
      })
      expect(result.ok).toBe(false)
    }

    expect(await prisma.order.count()).toBe(0)
    // 库存没被扣，购物车也没被清
    expect(await stockOf(sku.id)).toBe(5)
    expect(await prisma.cartItem.count()).toBe(1)
  })

  it("金额没到门槛的券用不了（前台不显示，服务端也不认）", async () => {
    const { userId, sku } = await makeShop({ price: 39900, stock: 3 })
    const coupon = await makeCoupon({ value: 10000, minSpend: 80000 })
    const given = await giveCoupon(userId, coupon.id)
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })

    expect(result.ok).toBe(false)
    // 报错要说清楚差多少，用户才知道该怎么办
    expect(result.ok === false && result.error).toContain("还差")
  })

  it("发放总量用完的券用不了", async () => {
    const { userId, sku } = await makeShop({ stock: 3 })
    const coupon = await makeCoupon({ totalLimit: 2, usedCount: 2 })
    const given = await giveCoupon(userId, coupon.id)
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })

    expect(result.ok).toBe(false)
    expect(await prisma.order.count()).toBe(0)
  })

  it("满减券比订单还贵时，实付是 0，不会变成负数", async () => {
    // 满 10 减 100 的券买 5 块钱的东西 —— 现实里运营配错了。
    // 语义是「免单」：最多减到 0，平台不欠用户钱
    const { userId, sku } = await makeShop({ price: 500, stock: 3 })
    const coupon = await makeCoupon({ value: 10000 })
    const given = await giveCoupon(userId, coupon.id)
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })

    expect(result.ok).toBe(true)
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
    })
    expect(order.discountAmount).toBe(500)
    expect(order.totalAmount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 并发用券
// ---------------------------------------------------------------------------
describe("并发用券：限量多少就只能用出去多少", () => {
  it("限量 3 张，10 个人同时用 → 恰好 3 单成功，usedCount 正好是 3", async () => {
    // 【这是「不超发」的最终证明】
    // 券的核销次数是「同一行的两列比较」（usedCount < totalLimit），
    // Prisma 的 updateMany 表达不了，所以走的是原生 SQL：
    //   UPDATE coupons SET usedCount = usedCount + 1
    //   WHERE id = ? AND usedCount < totalLimit
    // 朴素写法（读出来判断、再写回去）在这个测试下必然超发
    const product = await makeShop({ stock: 20 })
    const coupon = await makeCoupon({ totalLimit: 3, perUserLimit: 1 })

    const buyers = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const user = await makeUser()
        const given = await giveCoupon(user.id, coupon.id)
        await addToCart(user.id, product.sku.id, 1)
        return { userId: user.id, userCouponId: given.id }
      }),
    )

    const results = await Promise.all(
      buyers.map((buyer) =>
        createOrderFromCart(buyer.userId, {
          address: ADDRESS,
          phone: PHONE,
          userCouponId: buyer.userCouponId,
        }),
      ),
    )

    const succeeded = results.filter((r) => r.ok)
    expect(succeeded).toHaveLength(3)

    // 核销次数既不超发也不漏计
    expect(await usedCountOf(coupon.id)).toBe(3)

    // 失败的 7 个人必须「什么都没发生」：没有订单、券也没被标记成已用
    expect(await prisma.order.count()).toBe(3)
    expect(
      await prisma.userCoupon.count({ where: { usedAt: { not: null } } }),
    ).toBe(3)
    // 库存也只扣了成功的 3 件
    expect(await stockOf(product.sku.id)).toBe(17)
  })
})

// ---------------------------------------------------------------------------
// 取消订单 → 退券
// ---------------------------------------------------------------------------
describe("订单取消后退券", () => {
  it("超时未支付被取消：usedCount 退回去，那张券回到「未使用」", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 5 })
    const coupon = await makeCoupon({ value: 10000, minSpend: 80000 })
    const given = await giveCoupon(userId, coupon.id)
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })
    expect(result.ok).toBe(true)
    const orderId = result.ok ? result.orderId : ""
    expect(await usedCountOf(coupon.id)).toBe(1)

    // 把支付倒计时拨到过去，模拟「15 分钟没付款」
    await prisma.order.update({
      where: { id: orderId },
      data: { expiresAt: expiredAt() },
    })

    const cancelled = await cancelExpiredOrders({ userId })
    expect(cancelled.cancelled).toBe(1)

    // 1. 订单变成已取消
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe(ORDER_STATUS.CANCELLED)

    // 2. 核销次数退回来了 —— 否则这张券的额度就被一次取消永久吃掉了
    expect(await usedCountOf(coupon.id)).toBe(0)

    // 3. 我那张券回到「未使用」，而且不再挂在那一单上
    const myCoupon = await prisma.userCoupon.findUniqueOrThrow({
      where: { id: given.id },
    })
    expect(myCoupon.usedAt).toBeNull()
    expect(myCoupon.orderId).toBeNull()

    // 4. 退回来的券立刻又能用了
    await addToCart(userId, sku.id, 1)
    expect(await getUsableCoupons(userId, 89900)).toHaveLength(1)
  })

  it("库存也一起还了（退券不该把还库存挤掉）", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 5 })
    const coupon = await makeCoupon({ value: 10000 })
    const given = await giveCoupon(userId, coupon.id)
    await addToCart(userId, sku.id, 2)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })
    expect(await stockOf(sku.id)).toBe(3)

    await prisma.order.update({
      where: { id: result.ok ? result.orderId : "" },
      data: { expiresAt: expiredAt() },
    })
    await cancelExpiredOrders({ userId })

    // 两件事在同一个事务里，要么都发生要么都不发生 ——
    // 这里验证的是「都发生了」
    expect(await stockOf(sku.id)).toBe(5)
    expect(await usedCountOf(coupon.id)).toBe(0)
  })

  it("重复扫描不会把 usedCount 退成负数", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 5 })
    const coupon = await makeCoupon({ value: 10000 })
    const given = await giveCoupon(userId, coupon.id)
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      userCouponId: given.id,
    })
    await prisma.order.update({
      where: { id: result.ok ? result.orderId : "" },
      data: { expiresAt: expiredAt() },
    })

    await cancelExpiredOrders({ userId })
    // 再扫两遍：订单已经不是 PENDING_PAYMENT 了，扫不到它。
    // 就算扫到了，restoreCouponForOrder 的 where 里带着 orderId，
    // 第二次也命中不了
    await cancelExpiredOrders({ userId })
    await cancelExpiredOrders({ userId })

    expect(await usedCountOf(coupon.id)).toBe(0)
  })
})
