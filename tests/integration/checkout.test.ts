import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS, ORDER_TIMEOUT_MINUTES } from "@/lib/constants"
import { createOrderFromCart } from "@/lib/orders"
import {
  addToCart,
  makeProduct,
  makeShop,
  makeSku,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
  stockOf,
} from "./helpers/db"

// ============================================================================
// 下单：事务扣库存 —— 集成测试
//
// 【这一组测的是整个项目最核心的那段代码】
// src/lib/orders.ts 的 createOrderFromCart。它要同时保证四件事：
//
//   1. 单件商品不会被超卖        → 条件更新（stock >= qty 写进 WHERE）
//   2. 一单里多件商品全有或全无  → $transaction
//   3. 价格由服务端说了算        → 只收 address/phone，金额从库里读
//   4. 下单成功后购物车被清空    → 和扣库存在同一个事务里
//
// 第 1 条在单元测试里验证不了（并发是数据库的行为），
// 第 2 条更是只有真的事务才能证明。所以这层必须打真库。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

const ADDRESS = "北京市朝阳区测试路 1 号"
const PHONE = "13800138000"

describe("下单成功：一次事务里该做的四件事都做了", () => {
  it("扣库存、建订单、写快照、清空购物车", async () => {
    const { userId, product, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 3)

    const result = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
    })

    expect(result.ok).toBe(true)

    // 1. 库存被扣
    expect(await stockOf(sku.id)).toBe(7)

    // 2. 订单建出来了，状态和金额都对
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
      include: { items: true },
    })
    expect(order.status).toBe(ORDER_STATUS.PENDING_PAYMENT)
    expect(order.totalAmount).toBe(89900 * 3) // 单位：分
    expect(order.address).toBe(ADDRESS)
    expect(order.phone).toBe(PHONE)

    // 3. 订单项是**快照**，不是引用
    expect(order.items).toHaveLength(1)
    expect(order.items[0]).toMatchObject({
      skuId: sku.id,
      productName: product.name,
      size: "42",
      color: "黑色",
      price: 89900, // 成交价，不是当前价
      quantity: 3,
    })

    // 4. 购物车被清空
    expect(await prisma.cartItem.count({ where: { userId } })).toBe(0)
  })

  it("订单号是 SO + 时间戳 + 随机数，且唯一", async () => {
    const { userId, sku } = await makeShop()
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })

    expect(result.ok && result.orderNo).toMatch(/^SO\d{20}$/)

    // 再下一单，两个单号必须不同
    await addToCart(userId, sku.id, 1)
    const second = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })

    expect(second.ok && second.orderId).not.toBe(result.ok && result.orderId)
  })

  it("expiresAt = 下单时刻 + ORDER_TIMEOUT_MINUTES 分钟", async () => {
    // 这个字段是超时扫描的索引条件，写错了整个自动取消功能就废了
    const { userId, sku } = await makeShop()
    await addToCart(userId, sku.id, 1)

    const before = Date.now()
    const result = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })
    const after = Date.now()

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
    })

    const expected = ORDER_TIMEOUT_MINUTES * 60 * 1000
    const delta = order.expiresAt.getTime() - order.createdAt.getTime()

    // createdAt 由数据库默认值生成，expiresAt 由应用算，两者有毫秒级偏差
    expect(delta).toBeGreaterThanOrEqual(expected - 1000)
    expect(delta).toBeLessThanOrEqual(expected + 1000)

    // 而且确实落在「下单前后」这个时间窗里
    expect(order.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expected - 1000)
    expect(order.expiresAt.getTime()).toBeLessThanOrEqual(after + expected + 1000)
  })

  it("多件不同 SKU 的总价 = 各单价 × 数量求和", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const a = await makeSku(product.id, { price: 89900, stock: 5, size: "42", color: "黑" })
    const b = await makeSku(product.id, { price: 129900, stock: 5, size: "43", color: "白" })

    await addToCart(user.id, a.id, 2)
    await addToCart(user.id, b.id, 1)

    const result = await createOrderFromCart(user.id, { address: ADDRESS, phone: PHONE })

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
    })
    expect(order.totalAmount).toBe(89900 * 2 + 129900)
  })
})

describe("下单失败：库存不足时必须整个回滚", () => {
  it("单件商品库存不够 → 不建订单、不扣库存、购物车保留", async () => {
    const { userId, sku } = await makeShop({ stock: 2 })
    await addToCart(userId, sku.id, 5) // 要 5 件，只有 2 件

    const result = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("库存不足")
    // 除了给用户看的那句话，还要带回是**哪个 SKU** —— 前端拿它定位对应行
    expect(result.ok === false && result.insufficientSkuId).toBe(sku.id)

    // 库存一点没动
    expect(await stockOf(sku.id)).toBe(2)
    // 没有订单
    expect(await prisma.order.count()).toBe(0)
    // 购物车还在 —— 用户改小数量就能重新下单，不该让他重加一遍
    expect(await prisma.cartItem.count({ where: { userId } })).toBe(1)
  })

  it("多件商品：【前一件扣成功了，后一件不够】→ 前面那件也要还回去", async () => {
    // 这就是 $transaction 存在的**唯一**理由。
    // 少了事务，A 的库存会被白白扣掉：用户没下单成功，货却少了一件
    const user = await makeUser()
    const product = await makeProduct()
    const a = await makeSku(product.id, { stock: 100, size: "42", color: "黑" })
    const b = await makeSku(product.id, { stock: 1, size: "43", color: "白" })

    await addToCart(user.id, a.id, 10) // A 库存充足
    await addToCart(user.id, b.id, 5) // B 只有 1 件，必然失败

    const result = await createOrderFromCart(user.id, { address: ADDRESS, phone: PHONE })

    expect(result.ok).toBe(false)
    // 报告的是**不够的那一件**（B），而不是够的 A —— 前端据此定位到正确行
    expect(result.ok === false && result.insufficientSkuId).toBe(b.id)

    // 无论 A 和 B 谁先被处理，A 的库存都必须是 100
    expect(await stockOf(a.id)).toBe(100)
    expect(await stockOf(b.id)).toBe(1)

    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.orderItem.count()).toBe(0)
    expect(await prisma.cartItem.count({ where: { userId: user.id } })).toBe(2)
  })

  it("库存刚好够 → 成功，且扣到 0", async () => {
    // 边界：stock >= quantity 用 gte，所以「刚好等于」必须算通过。
    // 写成 gt 的话这里会误判为库存不足
    const { userId, sku } = await makeShop({ stock: 3 })
    await addToCart(userId, sku.id, 3)

    const result = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })

    expect(result.ok).toBe(true)
    expect(await stockOf(sku.id)).toBe(0)
  })

  it("库存差一件 → 失败，实际库存不允许变成负数", async () => {
    const { userId, sku } = await makeShop({ stock: 2 })
    await addToCart(userId, sku.id, 3)

    const result = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })

    expect(result.ok).toBe(false)
    expect(await stockOf(sku.id)).toBe(2)
  })

  it("购物车是空的 → 明确报错，不建空订单", async () => {
    const user = await makeUser()

    const result = await createOrderFromCart(user.id, { address: ADDRESS, phone: PHONE })

    expect(result).toEqual({ ok: false, error: "购物车是空的" })
    expect(await prisma.order.count()).toBe(0)
  })

  it("只买到了别人的购物车 —— 别人的车不受影响", async () => {
    // cartItem 是按 userId 查的。少了这个条件就会出现
    // 「A 下单把 B 车里的东西买走了」这种离谱的事
    const alice = await makeUser()
    const bob = await makeUser()
    const { sku } = await makeShop()

    await addToCart(alice.id, sku.id, 1)

    const result = await createOrderFromCart(bob.id, { address: ADDRESS, phone: PHONE })

    expect(result).toEqual({ ok: false, error: "购物车是空的" })
    expect(await prisma.cartItem.count({ where: { userId: alice.id } })).toBe(1)
  })
})

describe("并发下单：最后一件只能卖给一个人", () => {
  it("库存 1 件，5 个人同时下单 → 恰好 1 个成功，库存归 0", async () => {
    // 【这是「防超卖」的最终证明】
    // 朴素写法（先查再改）在这个测试下必然失败：5 个请求都会读到 stock = 1，
    // 都认为够，然后都扣。跑完库存变成 -4，或者卖出 5 件只剩 0 件。
    const product = await makeProduct()
    const sku = await makeSku(product.id, { stock: 1 })

    const buyers = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const user = await makeUser()
        await addToCart(user.id, sku.id, 1)
        return user
      }),
    )

    const results = await Promise.all(
      buyers.map((user) =>
        createOrderFromCart(user.id, { address: ADDRESS, phone: PHONE }),
      ),
    )

    const succeeded = results.filter((r) => r.ok)
    expect(succeeded).toHaveLength(1)

    // 库存既不超卖也不变负
    expect(await stockOf(sku.id)).toBe(0)
    // 只应该有一张订单 —— 失败的那些必须连订单都没建
    expect(await prisma.order.count()).toBe(1)
  })

  it("库存 10 件，10 个人各买 1 件 → 全部成功，库存归 0", async () => {
    // 反向验证：并发不该被「误伤」。条件更新只挡住不够的，
    // 不该把够的也一起拒掉
    const product = await makeProduct()
    const sku = await makeSku(product.id, { stock: 10 })

    const buyers = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const user = await makeUser()
        await addToCart(user.id, sku.id, 1)
        return user
      }),
    )

    const results = await Promise.all(
      buyers.map((user) =>
        createOrderFromCart(user.id, { address: ADDRESS, phone: PHONE }),
      ),
    )

    expect(results.filter((r) => r.ok)).toHaveLength(10)
    expect(await stockOf(sku.id)).toBe(0)
  })
})

describe("订单快照：下单之后改商品，历史订单不受影响", () => {
  it("改价格 → 已下单的订单金额和单价不变", async () => {
    // 这是「快照而不是引用」的核心价值。
    // 订单是历史凭证，商家事后调价不能改写用户买过的价格
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })
    const orderId = result.ok ? result.orderId : ""

    // 商家把价格改成 199 元
    await prisma.sku.update({ where: { id: sku.id }, data: { price: 19900 } })
    await prisma.product.updateMany({ data: { name: "改过名字的鞋" } })

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    })

    expect(order.totalAmount).toBe(89900) // 还是原价
    expect(order.items[0].price).toBe(89900) // 快照单价也是原价
    expect(order.items[0].productName).not.toBe("改过名字的鞋")
  })

  it("SKU 被物理删除 → 订单项仍在，skuId 置空但信息可读", async () => {
    // schema 里 OrderItem.skuId 是可空的，onDelete: SetNull。
    // 这样删除商品不会连带删掉历史订单
    const { userId, sku } = await makeShop()
    await addToCart(userId, sku.id, 2)

    const result = await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })

    await prisma.sku.delete({ where: { id: sku.id } })

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
      include: { items: true },
    })

    expect(order.items).toHaveLength(1)
    expect(order.items[0].skuId).toBeNull()
    // 快照字段一个都不能少
    expect(order.items[0].quantity).toBe(2)
    expect(order.items[0].skuCode).toBeTruthy()
  })
})

// ============================================================================
// 幂等键：同一个下单请求重复到达，只能落成一笔订单
//
// 【要挡的三种「重复到达」】
//   1. 用户双击提交按钮
//   2. 请求超时被网络层重试
//   3. 两个请求同时在途 —— 这一种最危险
//
// 前两种其实已经被「下单后清空购物车」挡住了（第二次会撞「购物车是空的」），
// 但第 3 种挡不住：两个请求都读到了还没被清空的购物车。
// 幂等键补的就是这个洞，靠的是 Order 上 (userId, idempotencyKey) 的唯一约束。
//
// 【为什么不用「先查后写」单独实现】
// 先查后写在并发下必然漏 —— 两个请求都查不到、都往下走。
// 唯一约束是数据库给的原子性保证，这才是说了算的那一道。
// ============================================================================

describe("幂等键：重复提交只落一笔订单", () => {
  it("同一个键顺序提交两次 → 只有一单，第二次把第一单原样还回来", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 3)

    const input = {
      address: ADDRESS,
      phone: PHONE,
      idempotencyKey: "idem-sequential",
    }

    const first = await createOrderFromCart(userId, input)
    // 第二次到达时购物车已经被第一单清空了。如果幂等早查排在了
    // 「读购物车」后面，这里会返回「购物车是空的」—— 一句正在误导用户的
    // 错误提示（他其实早就下单成功了）。所以早查必须在读购物车之前
    const second = await createOrderFromCart(userId, input)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.ok && second.orderId).toBe(first.ok && first.orderId)
    expect(second.ok && second.orderNo).toBe(first.ok && first.orderNo)

    // 库存只扣了一次（10 - 3），订单只有一笔
    expect(await stockOf(sku.id)).toBe(7)
    expect(await prisma.order.count()).toBe(1)
  })

  it("同一个键并发提交两次 → 唯一约束兜底，只有一单、库存只扣一次", async () => {
    // 【这是幂等键存在的真正理由】
    // 两个请求同时在途，都读到还没被清空的购物车，都扣库存、都建单。
    // 唯一约束只放行一个，输的那个事务整体回滚 ——
    // 它已经扣掉的库存必须跟着还回来，否则就成了「订单只有一笔、库存扣了两次」
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 2)

    const input = {
      address: ADDRESS,
      phone: PHONE,
      idempotencyKey: "idem-concurrent",
    }
    const [a, b] = await Promise.all([
      createOrderFromCart(userId, input),
      createOrderFromCart(userId, input),
    ])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // 两次拿到的必须是同一笔订单 —— 对用户来说「点了几次，看到的是同一单」
    expect(a.ok && a.orderId).toBe(b.ok && b.orderId)

    expect(await prisma.order.count()).toBe(1)
    // 关键断言：应该是 10 - 2 = 8，而不是 6。
    // 6 就说明输的那个请求扣的库存没被回滚
    expect(await stockOf(sku.id)).toBe(8)
  })

  it("不同的键 → 各成一单（键没有被错误复用）", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })

    await addToCart(userId, sku.id, 1)
    const first = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      idempotencyKey: "idem-a",
    })

    // 换一个键 = 「又买了一次」，必须真的成单。
    // 如果实现里把键当成了「这个用户下过单就不再下」，这条会挂
    await addToCart(userId, sku.id, 1)
    const second = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
      idempotencyKey: "idem-b",
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.ok && second.orderId).not.toBe(first.ok && first.orderId)
    expect(await prisma.order.count()).toBe(2)
    expect(await stockOf(sku.id)).toBe(8)
  })

  it("作用域是单个人：两个人用同一个键互不干扰", async () => {
    // 唯一约束是 (userId, idempotencyKey) 复合的，不是 idempotencyKey 全局唯一。
    // 全局唯一的话，别人猜到/复用一个键就能顶掉我的订单，等于开了一条
    // 跨用户探测订单的口子。这条测试守住的就是那个 userId 前缀
    const product = await makeProduct()
    const sku = await makeSku(product.id, { stock: 10 })

    const alice = await makeUser()
    const bob = await makeUser()
    await addToCart(alice.id, sku.id, 1)
    await addToCart(bob.id, sku.id, 1)

    const input = { address: ADDRESS, phone: PHONE, idempotencyKey: "same-key" }
    const [ra, rb] = await Promise.all([
      createOrderFromCart(alice.id, input),
      createOrderFromCart(bob.id, input),
    ])

    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    expect(ra.ok && ra.orderId).not.toBe(rb.ok && rb.orderId)
    expect(await prisma.order.count()).toBe(2)
    // 两单各扣一件，谁也没被别人的键吃掉
    expect(await stockOf(sku.id)).toBe(8)
  })

  it("不带幂等键 → 行为和加这个字段之前完全一样", async () => {
    // 兼容性守卫：字段是可选的，内部调用（脚本、测试造数）都不传，
    // 它们的行为不能因为这次改动发生任何变化
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 1)

    const first = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
    })
    expect(first.ok).toBe(true)

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: first.ok ? first.orderId : "" },
    })
    // 没带键就存 NULL，而不是空串 —— 空串会变成一个「人人都一样」的键，
    // 那样第二个不带键的订单反而会撞上第一个
    expect(order.idempotencyKey).toBeNull()

    // 老的防重复行为原样保留：第二次提交撞「购物车是空的」
    await expect(
      createOrderFromCart(userId, { address: ADDRESS, phone: PHONE }),
    ).resolves.toEqual({ ok: false, error: "购物车是空的" })
  })
})
