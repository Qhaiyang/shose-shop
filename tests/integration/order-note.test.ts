import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS, type OrderStatus } from "@/lib/constants"
import { createOrderFromCart, updateOrderNote } from "@/lib/orders"
import {
  addToCart,
  makeOrder,
  makeShop,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 订单备注 —— 集成测试
//
// 要钉死的是这条规则：**发货之后就不能再改了**。
//
// 【为什么这件事非要在真库上测】
// 它的实现不是「查一下状态、再决定改不改」，而是把状态条件写进 UPDATE 的
// WHERE（见 src/lib/orders.ts 的 updateOrderNote）。这种写法的正确性
// 完全取决于 SQL 里的那个条件 —— 纯函数层面看不出对错。
//
// 顺带还要确认一条界面上看不见的规则：改别人的订单必须和「订单不存在」
// 得到一模一样的回应，不能成为探测他人订单状态的工具。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

/** 造一张指定状态的订单，返回它的 id */
async function orderWithStatus(status: OrderStatus) {
  const user = await makeUser()
  const order = await makeOrder({ userId: user.id, status })
  return { user, orderId: order.id }
}

describe("updateOrderNote：什么时候能改", () => {
  it("待支付的订单能改", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.PENDING_PAYMENT)

    const result = await updateOrderNote(orderId, user.id, "请工作日送达")

    expect(result).toEqual({ ok: true })
    const saved = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(saved.note).toBe("请工作日送达")
  })

  it("已支付但还没发货的订单也能改", async () => {
    // 订单还没出仓库，改一句话不影响任何已经发生的事
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.PAID)

    expect(await updateOrderNote(orderId, user.id, "改成放门口快递柜")).toEqual({
      ok: true,
    })
  })

  it("已发货的订单被拒，库里一个字都没变", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.SHIPPED)
    await prisma.order.update({ where: { id: orderId }, data: { note: "原备注" } })

    const result = await updateOrderNote(orderId, user.id, "货都发了还想改")

    expect(result.ok).toBe(false)
    // 【不能只断言 result】还要确认数据库真的没被写坏 ——
    // 万一实现是先写后校验，这里就会露馅
    const saved = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(saved.note).toBe("原备注")
  })

  it("已完成的订单被拒", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.COMPLETED)

    expect((await updateOrderNote(orderId, user.id, "补一句")).ok).toBe(false)
  })

  it("已取消的订单被拒", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.CANCELLED)

    expect((await updateOrderNote(orderId, user.id, "补一句")).ok).toBe(false)
  })

  it("被拒时说清楚是「已发货」而不是一句笼统的失败", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.SHIPPED)

    const result = await updateOrderNote(orderId, user.id, "改一下")

    // 界面上会原样显示这句话。用户得知道是「不能改了」，
    // 而不是「哪里出错了、要不要再试一次」
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/已发货/)
  })
})

describe("updateOrderNote：越权和不存在", () => {
  it("改别人的订单会被拒，而且和「订单不存在」是同一句话", async () => {
    const owner = await makeUser()
    const attacker = await makeUser()
    const order = await makeOrder({
      userId: owner.id,
      status: ORDER_STATUS.PENDING_PAYMENT,
    })
    await prisma.order.update({
      where: { id: order.id },
      data: { note: "别人的备注" },
    })

    const stolen = await updateOrderNote(order.id, attacker.id, "我改你的")
    const missing = await updateOrderNote("not-a-real-order", attacker.id, "随便编")

    expect(stolen).toEqual({ ok: false, error: "订单不存在" })
    // 【为什么两句必须一字不差】分开说就等于告诉调用方「这个订单 id 是存在的」，
    // 可以拿它逐个试探出别人的订单
    expect(missing).toEqual(stolen)

    const saved = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(saved.note).toBe("别人的备注")
  })

  it("订单不存在时不会顺手把它建出来", async () => {
    const user = await makeUser()

    await updateOrderNote("not-a-real-order", user.id, "写点什么")

    expect(await prisma.order.count()).toBe(0)
  })
})

describe("updateOrderNote：备注本身", () => {
  it("可以清空备注（写回 null）", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.PAID)
    await updateOrderNote(orderId, user.id, "先写着")

    await updateOrderNote(orderId, user.id, null)

    const saved = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    // 归一化成 NULL 而不是空串 —— 见 orderNoteSchema 上的注释
    expect(saved.note).toBeNull()
  })

  it("改备注只动 note，别的字段一个都不碰", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.PAID)
    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })

    await updateOrderNote(orderId, user.id, "新的备注")

    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(after).toMatchObject({
      status: before.status,
      totalAmount: before.totalAmount,
      address: before.address,
      phone: before.phone,
      orderNo: before.orderNo,
    })
    expect(after.note).toBe("新的备注")
  })

  it("改两次是覆盖，不是追加", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.PAID)

    await updateOrderNote(orderId, user.id, "第一句")
    await updateOrderNote(orderId, user.id, "第二句")

    const saved = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(saved.note).toBe("第二句")
  })

  it("重复写入同样的内容是成功的（不会因为「没变化」而报错）", async () => {
    const { user, orderId } = await orderWithStatus(ORDER_STATUS.PAID)
    await updateOrderNote(orderId, user.id, "请工作日送达")

    // 用户点了「修改」又没改内容直接保存 —— 这不该被当成失败
    expect(await updateOrderNote(orderId, user.id, "请工作日送达")).toEqual({
      ok: true,
    })
  })
})

describe("下单时带的备注", () => {
  it("结算页填的备注会写进订单", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: "北京市朝阳区测试路 1 号",
      phone: "13800138000",
      note: "请工作日送达",
    })

    expect(result.ok).toBe(true)
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
    })
    expect(order.note).toBe("请工作日送达")
  })

  it("不填备注（字段缺省）时存的是 NULL", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: "北京市朝阳区测试路 1 号",
      phone: "13800138000",
    })

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
    })
    // 【为什么这条要单独测】undefined 和 null 在这里必须是同一个结果，
    // 否则库里「没写备注」会有两种表示
    expect(order.note).toBeNull()
  })

  it("显式传 null 和不传是同一个结果", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 1)

    const result = await createOrderFromCart(userId, {
      address: "北京市朝阳区测试路 1 号",
      phone: "13800138000",
      note: null,
    })

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.ok ? result.orderId : "" },
    })
    expect(order.note).toBeNull()
  })
})
