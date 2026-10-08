import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS } from "@/lib/constants"
import {
  cancelExpiredOrders,
  confirmReceipt,
  createOrderFromCart,
  getOrderDetail,
  getOrderDetailForAdmin,
  getOrdersByUser,
  payOrder,
  shipOrder,
} from "@/lib/orders"
import {
  expiredAt,
  makeOrder,
  makeShop,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
  statusOf,
} from "./helpers/db"

// ============================================================================
// 越权访问（IDOR）—— 集成测试
//
// IDOR = Insecure Direct Object Reference。电商里最常见的一种漏洞：
// 接口收一个 id，但没验证「这个 id 是不是你的」，于是把别人的订单
// 收货地址、手机号、买了什么全都吐出去了。
//
// 【本项目的防线：把 userId 写进 where，而不是查出来再 if 判断】
//     prisma.order.findFirst({ where: { id, userId } })   ← 防线在这里
//     const o = await findUnique({ where: { id } })
//     if (o.userId !== userId) throw ...                  ← 迟早有人忘了写
//
// 所以下面每一条都在验证：**换个人来调，返回的是「不存在」**，
// 而不是「你没有权限看这个」——后者本身就泄露了「这个订单存在」。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

/** 造两个人的两笔订单，返回各种 id */
async function twoUsersTwoOrders() {
  const alice = await makeUser({ name: "Alice" })
  const bob = await makeUser({ name: "Bob" })
  const product = (await makeShop()).product
  const sku = await prisma.sku.findFirstOrThrow({ where: { productId: product.id } })

  const aliceOrder = await makeOrder({ userId: alice.id, skuId: sku.id })
  const bobOrder = await makeOrder({ userId: bob.id, skuId: sku.id })

  return { alice, bob, aliceOrder, bobOrder }
}

describe("查订单详情：只能看到自己的", () => {
  it("自己的订单能查到完整信息", async () => {
    const { alice, aliceOrder } = await twoUsersTwoOrders()

    const detail = await getOrderDetail(aliceOrder.id, alice.id)

    expect(detail).not.toBeNull()
    expect(detail?.id).toBe(aliceOrder.id)
    expect(detail?.phone).toBe("13800138000")
    expect(detail?.items).toHaveLength(1)
  })

  it("拿别人的订单 id 去查 → null（不是抛错，也不是返回数据）", async () => {
    // 返回 null 而不是「无权访问」，是因为「无权访问」这句话
    // 本身就承认了「这个订单存在」。对攻击者来说这是有用的信息
    const { alice, bob, aliceOrder } = await twoUsersTwoOrders()

    expect(await getOrderDetail(aliceOrder.id, bob.id)).toBeNull()
    expect(await getOrderDetail(aliceOrder.id, alice.id)).not.toBeNull()
  })

  it("管理员查询走另一个函数，能看到任何人的订单", async () => {
    // getOrderDetail 和 getOrderDetailForAdmin 有意保持两个独立函数。
    // 合并成 getOrderDetail(id, userId?) 的话，就存在「忘了传 userId」
    // 这条路径 —— 而忘记传的后果是静默地把别人的订单暴露出去
    const { alice, aliceOrder } = await twoUsersTwoOrders()

    const detail = await getOrderDetailForAdmin(aliceOrder.id)

    expect(detail).not.toBeNull()
    expect(detail?.buyer.id).toBe(alice.id)
    expect(detail?.buyer.name).toBe("Alice")
  })

  it("不存在的订单，两种查询都返回 null", async () => {
    expect(await getOrderDetail("nope", "whoever")).toBeNull()
    expect(await getOrderDetailForAdmin("nope")).toBeNull()
  })
})

describe("订单列表：只返回自己的", () => {
  it("Bob 的列表里看不到 Alice 的订单", async () => {
    // 列表页少写一个 userId 条件，登录用户就能看到全站订单
    const { alice, bob } = await twoUsersTwoOrders()

    const aliceList = await getOrdersByUser(alice.id)
    const bobList = await getOrdersByUser(bob.id)

    expect(aliceList).toHaveLength(1)
    expect(bobList).toHaveLength(1)
    expect(aliceList[0].id).not.toBe(bobList[0].id)
  })

  it("没下过单的人拿到空列表，而不是别人的", async () => {
    const { alice } = await twoUsersTwoOrders()
    const carol = await makeUser({ name: "Carol" })

    expect(await getOrdersByUser(alice.id)).toHaveLength(1)
    expect(await getOrdersByUser(carol.id)).toEqual([])
  })
})

describe("改订单状态：别人的订单改不动", () => {
  it("支付别人的订单 → 订单不存在", async () => {
    const { bob, aliceOrder } = await twoUsersTwoOrders()

    const result = await payOrder(aliceOrder.id, bob.id)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe("订单不存在")
    // 数据库里必须纹丝不动
    expect(await statusOf(aliceOrder.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })

  it("确认收货别人的订单 → 订单不存在", async () => {
    // confirmReceipt 是 scopeToUser: true 的，where 里带 userId
    const { bob, aliceOrder } = await twoUsersTwoOrders()
    await prisma.order.update({
      where: { id: aliceOrder.id },
      data: { status: ORDER_STATUS.SHIPPED },
    })

    const result = await confirmReceipt(aliceOrder.id, bob.id)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe("订单不存在")
    expect(await statusOf(aliceOrder.id)).toBe(ORDER_STATUS.SHIPPED)
  })

  it("发货是管理员的活，不带 userId —— 但它由 action 层鉴权", async () => {
    // shipOrder 自己没有 userId 条件（管理员本来就该能发任何订单），
    // 权限由 src/app/actions/admin.ts 的 requireAdmin() 把关。
    //
    // 这里把这条边界**显式记下来**：这个函数不安全，安全性在调用方。
    // 哪天有人从别处直接调 shipOrder，就有越权风险 —— 测试把这件事说清楚，
    // 比让下一个人自己去读注释靠谱
    const { aliceOrder } = await twoUsersTwoOrders()
    await prisma.order.update({
      where: { id: aliceOrder.id },
      data: { status: ORDER_STATUS.PAID },
    })

    expect((await shipOrder(aliceOrder.id)).ok).toBe(true)
    expect(await statusOf(aliceOrder.id)).toBe(ORDER_STATUS.SHIPPED)
  })

  it("越权和「订单不存在」返回完全一样的提示", async () => {
    // 两种情况的返回值必须一模一样，否则攻击者可以拿它当探针，
    // 遍历 id 来问「这个订单存不存在」
    const { bob, aliceOrder } = await twoUsersTwoOrders()

    const notYours = await payOrder(aliceOrder.id, bob.id)
    const notExist = await payOrder("definitely-not-real", bob.id)

    expect(notYours).toEqual(notExist)
    expect(notYours).toEqual({ ok: false, error: "订单不存在" })
  })
})

describe("购物车也按 userId 隔离", () => {
  it("下单只结算自己的购物车", async () => {
    // 这条在 checkout.test.ts 里也测了，这里从越权角度看一遍：
    // 「我能不能把别人车里的东西买走 / 让别人帮我清空购物车」
    const alice = await makeUser()
    const bob = await makeUser()
    const product = (await makeShop()).product
    const sku = await prisma.sku.findFirstOrThrow({ where: { productId: product.id } })

    await prisma.cartItem.create({ data: { userId: alice.id, skuId: sku.id, quantity: 2 } })

    // Bob 下单，他自己车里是空的
    const result = await createOrderFromCart(bob.id, {
      address: "北京市朝阳区某路 1 号",
      phone: "13800138000",
    })

    expect(result.ok).toBe(false)
    // Alice 的车还在
    expect(await prisma.cartItem.count({ where: { userId: alice.id } })).toBe(1)
  })
})

describe("过期订单也一样受 userId 约束", () => {
  it("页面兜底扫描只扫自己的，扫不到别人的", async () => {
    const alice = await makeUser()
    const bob = await makeUser()
    const product = (await makeShop()).product
    const sku = await prisma.sku.findFirstOrThrow({ where: { productId: product.id } })

    const aliceOrder = await makeOrder({
      userId: alice.id,
      skuId: sku.id,
      expiresAt: expiredAt(60), // Alice 的订单已经过期了，正等着被扫
    })

    const result = await cancelExpiredOrders({ userId: bob.id })

    expect(result.cancelled).toBe(0)
    expect(await statusOf(aliceOrder.id)).toBe(ORDER_STATUS.PENDING_PAYMENT)
  })
})
