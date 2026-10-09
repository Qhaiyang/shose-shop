import { beforeEach, describe, expect, it } from "vitest"

import { executeGetOrderDetail, executeListMyOrders } from "@/lib/ai/tools"
import { ORDER_STATUS } from "@/lib/constants"
import { createOrderFromCart } from "@/lib/orders"
import {
  addToCart,
  makeOrder,
  makeShop,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// AI 工具层：executeListMyOrders —— 集成测试
//
// 【为什么这层要打真库】
// 和 Stripe 那边一样的分工：模型用 mock（不花真钱、结果稳定），
// 但工具查库这段是真的 SQL、真的 where、真的关联 —— 只有真库能证明
// 「userId 过滤生效」和「映射出来的字段对」。
//
// 【这一组最想守住的是什么】
// 工具的输出是**喂给模型看的**，不是给前端渲染的。所以这里断言的
// 就是那份「压过的形状」：不得多一个字段、不得少一个字段、钱必须
// 已经是格式化好的字符串。映射写错（比如把分直接给模型、或者把
// 中文标签换成枚举）在前端页面上看不出来，但模型会照着说错话。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

const ADDRESS = "北京市朝阳区测试路 1 号"
const PHONE = "13800138000"

/** 从 ToolResult 里把 orders 数组取出来，顺带收窄类型 */
function ordersOf(result: Awaited<ReturnType<typeof executeListMyOrders>>) {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.error}`)
  return (result.data as { orders: Record<string, unknown>[] }).orders
}

describe("executeListMyOrders：输出是「给模型看的形状」", () => {
  it("真实下单后，字段被压成五个，钱和时间都已经格式化好", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    // 同一 SKU 买 3 件：种类数 1、总件数 3，用来区分这两个概念
    await addToCart(userId, sku.id, 3)
    const created = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
    })
    expect(created.ok).toBe(true)

    const orders = ordersOf(await executeListMyOrders(userId, {}))
    expect(orders).toHaveLength(1)

    const order = orders[0]
    // 字段集合精确相等 —— 多一个（漏删内部字段）少一个（漏给模型）都要红。
    // 这里盯着的就是「id 没有被偷偷放回来」：模型手上只能有一个把手，
    // 而那个把手是 orderNo
    expect(Object.keys(order).sort()).toEqual(
      ["createdAt", "orderNo", "status", "totalPrice", "totalQuantity"].sort(),
    )

    // 状态是中文标签，不是 PENDING_PAYMENT 这种枚举
    expect(order.status).toBe("待支付")

    // 钱是格式化好的字符串：89900 分 × 3 件 = 269700 分
    expect(order.totalPrice).toBe("¥2697.00")

    // 总件数是「数量相加」，不是「商品种类数」
    expect(order.totalQuantity).toBe(3)

    // 时间是字符串，不是 Date 对象（Date 过不了 JSON.stringify 那一关）
    expect(typeof order.createdAt).toBe("string")
    expect(order.createdAt).not.toBe("")
  })

  it("没有订单时返回空数组，不是报错", async () => {
    const { userId } = await makeShop()
    const result = await executeListMyOrders(userId, {})
    expect(result.ok).toBe(true)
    expect(ordersOf(result)).toEqual([])
  })
})

describe("executeListMyOrders：越权防线", () => {
  it("只返回该 userId 自己的订单", async () => {
    const a = await makeShop()
    const b = await makeShop()
    await makeOrder({ userId: a.userId })
    await makeOrder({ userId: a.userId })
    await makeOrder({ userId: b.userId })

    const orders = ordersOf(await executeListMyOrders(b.userId, {}))
    expect(orders).toHaveLength(1)
  })

  it("模型在参数里塞 userId 也没用 —— 它被 schema 丢掉，进不了 where", async () => {
    const a = await makeShop()
    const b = await makeShop()
    await makeOrder({ userId: a.userId })

    // 模型（或者诱导它的人）试图越权：把别人的 userId 拼进参数
    const orders = ordersOf(
      await executeListMyOrders(b.userId, { userId: a.userId }),
    )

    // schema 里没有 userId 这个键，zod 默认把它剥掉，
    // 查询用的仍是函数参数进来的 b.userId → 查不到 a 的单
    expect(orders).toEqual([])
  })
})

describe("executeListMyOrders：status 过滤与非法输入", () => {
  it("传 status 只返回该状态的订单", async () => {
    const { userId } = await makeShop()
    await makeOrder({ userId })
    await makeOrder({ userId, status: ORDER_STATUS.PAID })

    expect(ordersOf(await executeListMyOrders(userId, {}))).toHaveLength(2)

    const paid = ordersOf(
      await executeListMyOrders(userId, { status: ORDER_STATUS.PAID }),
    )
    expect(paid).toHaveLength(1)
    expect(paid[0].status).toBe("已支付")
  })

  it("模型编了个不存在的状态 → ok:false，不抛异常", async () => {
    const result = await executeListMyOrders("u_whatever", {
      status: "NOT_A_STATUS",
    })
    expect(result.ok).toBe(false)
  })
})

// ============================================================================
// executeGetOrderDetail
//
// 这一组最想守住的有两条：
//
//   1. 「id 不存在」和「id 是别人的」必须返回**完全一样**的东西。
//      只要两者可区分，模型（或诱导它的人）就拿到了一个探测器，
//      可以拿 id 去问「这个存在吗」。所以要逐字节相等，不是「都差不多」。
//
//   2. 手机号必须打码后才离开这个函数。第三方模型拿到完整号码，
//      是能直接拿去诈骗/撞库的；这是数据外流，不是越权。
// ============================================================================

/** 下一单，返回 userId 和那一单在 AI 视角下的 id */
async function makeOrderForAi() {
  const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
  await addToCart(userId, sku.id, 2)
  const created = await createOrderFromCart(userId, {
    address: ADDRESS,
    phone: PHONE,
  })
  if (!created.ok) throw new Error("下单失败，测试前置条件没搭起来")
  // 给的是**单号**不是 id：工具结果不跨轮留存，模型下一轮手上只有单号。
  // 这个测试夹具返回什么，就等于模型能拿到什么
  return { userId, orderNo: created.orderNo }
}

function detailOf(result: Awaited<ReturnType<typeof executeGetOrderDetail>>) {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.error}`)
  return (result.data as { order: Record<string, unknown> | null }).order
}

describe("executeGetOrderDetail：详情映射", () => {
  it("真实订单查出来是「详情形状」：金额已格式化、明细已展开、时间已转文本", async () => {
    const { userId, orderNo } = await makeOrderForAi()

    const order = detailOf(await executeGetOrderDetail(userId, { orderNo }))
    expect(order).not.toBeNull()
    if (!order) return

    // 字段集合精确相等：多一个（漏删内部字段）少一个（漏给模型）都要红
    expect(Object.keys(order).sort()).toEqual(
      [
        "address",
        "cancelledAt",
        "completedAt",
        "couponCode",
        "createdAt",
        "discountAmount",
        "items",
        "itemsTotal",
        "note",
        "orderNo",
        "paidAt",
        "phone",
        "refundedAt",
        "shippedAt",
        "status",
        "totalAmount",
      ].sort(),
    )

    expect(order.status).toBe("待支付")

    // 明细展开成数组，单价也是格式化好的字符串
    const items = order.items as Record<string, unknown>[]
    expect(items).toHaveLength(1)
    expect(Object.keys(items[0]).sort()).toEqual(
      ["color", "price", "productName", "quantity", "size"].sort(),
    )
    expect(items[0].price).toBe("¥899.00")
    expect(items[0].quantity).toBe(2)

    // 金额三件套都是格式化字符串：89900 × 2 = 179800
    expect(order.itemsTotal).toBe("¥1798.00")
    expect(order.discountAmount).toBe("¥0.00")
    expect(order.totalAmount).toBe("¥1798.00")

    // 没用券 → null，不是空串
    expect(order.couponCode).toBeNull()
    // 没发货 → null，不是 Invalid Date
    expect(order.shippedAt).toBeNull()
    // 没写备注 → null
    expect(order.note).toBeNull()
  })

  it("手机号打码后才给模型，完整号码一个字节都不出现", async () => {
    const { userId, orderNo } = await makeOrderForAi()

    const result = await executeGetOrderDetail(userId, { orderNo })
    const order = detailOf(result)

    expect(order?.phone).toBe("138****8000")
    // 整个返回体里都不许有完整号码 —— 包括将来有人不小心加了别的字段
    expect(JSON.stringify(result)).not.toContain(PHONE)
  })
})

describe("executeGetOrderDetail：三种「查不到」的处理", () => {
  it("单号不存在 → ok:true + order:null（不是 ok:false）", async () => {
    const { userId } = await makeShop()

    const result = await executeGetOrderDetail(userId, {
      orderNo: "SO-NOT-FOUND",
    })
    expect(result.ok).toBe(true)
    expect(detailOf(result)).toBeNull()
  })

  it("单号是别人的 → 和「单号不存在」返回的东西完全一致", async () => {
    const a = await makeOrderForAi()
    const b = await makeShop()

    const notFound = await executeGetOrderDetail(a.userId, {
      orderNo: "SO-NOT-FOUND",
    })
    const others = await executeGetOrderDetail(b.userId, { orderNo: a.orderNo })

    // 逐字节相等：两者可区分，就等于给了模型一个「这个单号存在吗」的探测器
    expect(others).toEqual(notFound)
    expect(detailOf(others)).toBeNull()
  })

  it("模型给的 orderNo 不是字符串 → ok:false（这是模型的错，不是查不到）", async () => {
    const result = await executeGetOrderDetail("u_whatever", { orderNo: 123 })
    expect(result.ok).toBe(false)
  })
})
