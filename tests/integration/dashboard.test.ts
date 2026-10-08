import { beforeEach, describe, expect, it } from "vitest"

import { LOW_STOCK_THRESHOLD, ORDER_STATUS, ORDER_STATUS_VALUES } from "@/lib/constants"
import { getAdminDashboard } from "@/lib/dashboard"
import { startOfDay } from "@/lib/dates"
import { getAdminOrders, getAdminOrderStats } from "@/lib/orders"
import { getAdminProducts } from "@/lib/products"
import {
  makeOrder,
  makeProduct,
  makeSku,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 后台首页看板 —— 集成测试
//
// 【这一层在测什么】
// 单元测试能验「今天到明天是 24 小时」，但验不了「那笔昨天的订单有没有
// 被算进今日订单数」—— 那要真的写进数据库、再让 SQL 去筛。
// 看板这类代码的价值全在「数字对不对」，所以它必须有真实的库来测。
//
// 【重点：卡片数字和下钻列表必须是同一个 where】
// 管理员点开卡片看到的第一件事，就是拿列表里的行数和卡片上的数字对照。
// 对不上（哪怕只差 1）他就不信这一页了。下面有一整个 describe 专门钉这件事。
// ============================================================================

/** 今天零点。所有「今天/昨天」的用例都围着它构造时间 */
function todayStart(): Date {
  return startOfDay(new Date())
}

/** 今天零点往前挪 n 小时 —— 也就是「昨天」 */
function hoursBefore(date: Date, hours: number): Date {
  return new Date(date.getTime() - hours * 60 * 60 * 1000)
}

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

describe("空库：每个数字都得是 0，而不是 null 或崩掉", () => {
  it("一个订单、一个 SKU 都没有", async () => {
    // 【为什么这条要单独测】
    // SQL 的 SUM() 在没有行可加的时候返回的是 **NULL**，不是 0。
    // Prisma 把它翻译成 JS 的 null，于是 revenue._sum.totalAmount 是 null。
    // 页面上直接渲染就会显示「¥NaN」或者干脆是空白。
    // 这个 bug 只在「今天一笔都没卖」时出现 —— 而那正是新店最常见的情况
    const dashboard = await getAdminDashboard()

    expect(dashboard.totalOrders).toBe(0)
    expect(dashboard.statusStats[ORDER_STATUS.PAID]).toBe(0)

    expect(dashboard.todayOrderCount).toBe(0)
    expect(dashboard.todayRevenue).toBe(0)
    expect(dashboard.todayPaidOrderCount).toBe(0)

    expect(dashboard.pendingShipmentCount).toBe(0)
    expect(dashboard.lowStockSkuCount).toBe(0)
    expect(dashboard.lowStockProductCount).toBe(0)
  })

  it("五个状态都在，缺的补 0", async () => {
    const dashboard = await getAdminDashboard()

    for (const status of ORDER_STATUS_VALUES) {
      expect(dashboard.statusStats[status]).toBe(0)
    }
  })
})

describe("今日订单数：按 createdAt 算，卡在零点上也不会漏", () => {
  it("只算今天的，昨天的排除在外", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const start = todayStart()

    // 昨天 23:00 下的两单
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      createdAt: hoursBefore(start, 1),
    })
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      createdAt: hoursBefore(start, 5),
    })

    // 今天 09:00 下的一单
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      createdAt: new Date(start.getTime() + 9 * 60 * 60 * 1000),
    })

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayOrderCount).toBe(1)
    expect(dashboard.totalOrders).toBe(3) // 全站仍然是 3 笔
  })

  it("恰好卡在零点前一毫秒的单不算今天", async () => {
    // 「左闭右开」在真实数据上的表现 —— 差一毫秒也不能算进今天
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      createdAt: new Date(todayStart().getTime() - 1),
    })

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayOrderCount).toBe(0)
  })

  it("恰好落在零点整的单算今天", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    await makeOrder({ userId: user.id, skuId: sku.id, createdAt: todayStart() })

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayOrderCount).toBe(1)
  })

  it("不分状态：待支付的也算「今天下的单」", async () => {
    // 「今日订单数」问的是「今天有多少人下单」，
    // 而不是「今天成交了多少」——还有没付款的也该算
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const now = new Date()

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PENDING_PAYMENT,
      createdAt: now,
    })
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.CANCELLED,
      createdAt: now,
    })

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayOrderCount).toBe(2)
  })
})

describe("今日销售额：按 paidAt 算，不含已取消", () => {
  it("只累加今天付款的金额", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const start = todayStart()

    // 昨天下的单，今天付的款 —— 【应该算进今天的销售额】
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      totalAmount: 10000,
      createdAt: hoursBefore(start, 20),
      paidAt: new Date(start.getTime() + 60 * 1000),
    })

    // 今天下的单，昨天就付过款了 —— 这是不可能的数据，但正好检验
    // 「按 paidAt 筛」和「按 createdAt 筛」确实是两回事
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      totalAmount: 99999,
      createdAt: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      paidAt: hoursBefore(start, 30),
    })

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayRevenue).toBe(10000)
    expect(dashboard.todayPaidOrderCount).toBe(1)
  })

  it("未付款的订单不算销售额", async () => {
    // paidAt 是 null 的单，无论 created 到什么时候都不该进营收
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PENDING_PAYMENT,
      totalAmount: 50000,
      createdAt: new Date(),
    })

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayOrderCount).toBe(1) // 今天确实下了这一单
    expect(dashboard.todayRevenue).toBe(0) // 但一分钱没到账
  })

  it("今天付过款又被取消的单，不计入销售额", async () => {
    // 付款后取消 = 退款。钱退回去了就不是营收。
    // 现在还没有「已付款后取消」的入口，但状态机允许
    // PAID → CANCELLED，等哪天加了退款功能，这个数字不能突然虚高
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const now = new Date()

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.CANCELLED,
      totalAmount: 20000,
      paidAt: now,
      createdAt: now,
    })

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayPaidOrderCount).toBe(0)
    expect(dashboard.todayRevenue).toBe(0)
  })

  it("多笔订单的金额正确相加（用分，不丢精度）", async () => {
    // 【为什么金额必须用整数分】
    // 三笔 0.1 元 + 0.2 元的单，浮点加法会得到 0.30000000000000004。
    // 金额用分存、用分加，最后一步才除以 100 展示，就没有这个问题
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const now = new Date()

    for (const amount of [3333, 6667, 1]) {
      await makeOrder({
        userId: user.id,
        skuId: sku.id,
        status: ORDER_STATUS.PAID,
        totalAmount: amount,
        paidAt: now,
        createdAt: now,
      })
    }

    const dashboard = await getAdminDashboard()

    expect(dashboard.todayRevenue).toBe(10001)
  })
})

describe("低库存：SKU 数和商品数是两个不同的数字", () => {
  it("按 SKU 数统计，同时报告涉及几款商品", async () => {
    // 一款商品有 3 个 SKU 告急，另一款有 1 个 ——
    // 卡片上应该写「4 个规格」，同时能说清只涉及 2 款商品
    const productA = await makeProduct({ name: "A 款" })
    await makeSku(productA.id, { size: "42", stock: 0 })
    await makeSku(productA.id, { size: "43", stock: 1 })
    await makeSku(productA.id, { size: "44", stock: 4 })
    await makeSku(productA.id, { size: "45", stock: 4 + 1 }) // 恰好到阈值，不算

    const productB = await makeProduct({ name: "B 款" })
    await makeSku(productB.id, { size: "42", stock: 2 })

    const dashboard = await getAdminDashboard()

    expect(dashboard.lowStockSkuCount).toBe(4)
    expect(dashboard.lowStockProductCount).toBe(2)
  })

  it("阈值是「小于」，不是「小于等于」", async () => {
    // stock = LOW_STOCK_THRESHOLD 的 SKU 不算告急。
    // 这类边界写成 < 还是 <= 是经典错误，而两边「看起来都对」
    const product = await makeProduct()
    await makeSku(product.id, { size: "41", stock: LOW_STOCK_THRESHOLD - 1 })
    await makeSku(product.id, { size: "42", stock: LOW_STOCK_THRESHOLD })

    const dashboard = await getAdminDashboard()

    expect(dashboard.lowStockSkuCount).toBe(1)
  })

  it("库存充足时两项都是 0", async () => {
    const product = await makeProduct()
    await makeSku(product.id, { size: "42", stock: 999 })

    const dashboard = await getAdminDashboard()

    expect(dashboard.lowStockSkuCount).toBe(0)
    expect(dashboard.lowStockProductCount).toBe(0)
  })
})

describe("看板上的数字和订单列表对得上", () => {
  it("今日订单数 = ?range=today 列表的 total", async () => {
    // 【这是整个文件里最关键的一条】
    // 卡片写 7 笔、点进去列表只有 5 条 —— 这种不一致会直接摧毁
    // 管理员对这一页的信任。所以「聚合查询」和「下钻列表」
    // 必须用同一个 where 条件，这里用测试把它钉死
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id, { stock: 999 })
    const start = todayStart()

    for (const created of [
      hoursBefore(start, 30), // 昨天
      hoursBefore(start, 3), // 昨天
      new Date(start.getTime() + 3600_000),
      new Date(start.getTime() + 7200_000),
      new Date(start.getTime() + 10800_000),
    ]) {
      await makeOrder({ userId: user.id, skuId: sku.id, createdAt: created })
    }

    const dashboard = await getAdminDashboard()
    const list = await getAdminOrders({ createdToday: true })

    expect(dashboard.todayOrderCount).toBe(3)
    expect(list.total).toBe(dashboard.todayOrderCount)
  })

  it("今日销售额 = ?paidToday=1 列表里那些订单的金额之和", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id, { stock: 999 })
    const start = todayStart()

    // 今天付款的三笔
    for (const amount of [12000, 34500, 700]) {
      await makeOrder({
        userId: user.id,
        skuId: sku.id,
        status: ORDER_STATUS.PAID,
        totalAmount: amount,
        paidAt: new Date(start.getTime() + 3600_000),
        createdAt: new Date(start.getTime() + 1800_000),
      })
    }

    // 今天付款但已取消的一笔 —— 两边都必须排除它
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.CANCELLED,
      totalAmount: 88000,
      paidAt: new Date(start.getTime() + 3600_000),
      createdAt: new Date(start.getTime() + 1800_000),
    })

    const dashboard = await getAdminDashboard()
    const list = await getAdminOrders({ paidToday: true })

    const listedRevenue = list.rows.reduce((sum, row) => sum + row.totalAmount, 0)

    expect(dashboard.todayRevenue).toBe(12000 + 34500 + 700)
    expect(list.total).toBe(dashboard.todayPaidOrderCount)
    expect(listedRevenue).toBe(dashboard.todayRevenue)
  })

  it("待发货数 = ?status=PAID 列表的 total", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    for (const status of [
      ORDER_STATUS.PAID,
      ORDER_STATUS.PAID,
      ORDER_STATUS.SHIPPED,
      ORDER_STATUS.COMPLETED,
    ]) {
      await makeOrder({ userId: user.id, skuId: sku.id, status })
    }

    const dashboard = await getAdminDashboard()
    const list = await getAdminOrders({ status: ORDER_STATUS.PAID })

    expect(dashboard.pendingShipmentCount).toBe(2)
    expect(list.total).toBe(dashboard.pendingShipmentCount)
  })

  it("状态卡片和 getAdminOrderStats 是同一份数据", async () => {
    // 首页用 getAdminDashboard、订单页用 getAdminOrderStats。
    // 两个函数各查各的，但显示的必须是同一批数字，否则两页会打架
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    for (const status of ORDER_STATUS_VALUES) {
      await makeOrder({ userId: user.id, skuId: sku.id, status })
      await makeOrder({ userId: user.id, skuId: sku.id, status })
    }

    const dashboard = await getAdminDashboard()
    const stats = await getAdminOrderStats()

    for (const status of ORDER_STATUS_VALUES) {
      expect(dashboard.statusStats[status]).toBe(stats[status])
    }
    expect(dashboard.totalOrders).toBe(stats.total)
  })

  it("低库存商品列表：涉及的商品款数对得上", async () => {
    // 卡片说「分布在 N 款商品」，下钻列表就该正好 N 行
    const productA = await makeProduct({ name: "A 款" })
    await makeSku(productA.id, { size: "42", stock: 1 })
    await makeSku(productA.id, { size: "43", stock: 2 })

    const productB = await makeProduct({ name: "B 款" })
    await makeSku(productB.id, { size: "42", stock: 3 })

    const productC = await makeProduct({ name: "C 款" })
    await makeSku(productC.id, { size: "42", stock: 500 }) // 充足，不该出现

    const dashboard = await getAdminDashboard()
    const list = await getAdminProducts({ lowStock: true })

    expect(dashboard.lowStockProductCount).toBe(2)
    expect(list).toHaveLength(dashboard.lowStockProductCount)
    expect(list.map((p) => p.name).sort()).toEqual(["A 款", "B 款"])
  })

  it("列表里每款商品显示的低库存规格数，加起来等于卡片上的 SKU 数", async () => {
    // 卡片写 SKU 数（4），列表显示商品数（2）—— 这两个数字不一样。
    // 列表必须把「有几个规格告急」也显示出来，否则管理员
    // 会以为两个数字里有一个是错的。这条用例保证那个补充数字是对的
    const productA = await makeProduct()
    await makeSku(productA.id, { size: "42", stock: 0 })
    await makeSku(productA.id, { size: "43", stock: 1 })

    const productB = await makeProduct()
    await makeSku(productB.id, { size: "42", stock: 2 })
    await makeSku(productB.id, { size: "43", stock: 3 })

    const dashboard = await getAdminDashboard()
    const list = await getAdminProducts({ lowStock: true })

    const listed = list.reduce((sum, p) => sum + p.lowStockSkuCount, 0)

    expect(dashboard.lowStockSkuCount).toBe(4)
    expect(listed).toBe(dashboard.lowStockSkuCount)
  })
})

describe("商品列表的低库存筛选", () => {
  it("不传 lowStock 时返回全部商品", async () => {
    const healthy = await makeProduct()
    await makeSku(healthy.id, { stock: 100 })

    const low = await makeProduct()
    await makeSku(low.id, { stock: 1 })

    expect(await getAdminProducts()).toHaveLength(2)
    expect(await getAdminProducts({ lowStock: true })).toHaveLength(1)
  })

  it("和上下架筛选叠加：只看「在售 + 低库存」", async () => {
    // 下架商品的库存告急不用管 —— 它根本不卖
    const active = await makeProduct({ isActive: true })
    await makeSku(active.id, { stock: 1 })

    const inactive = await makeProduct({ isActive: false })
    await makeSku(inactive.id, { stock: 1 })

    const list = await getAdminProducts({ lowStock: true, active: true })

    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(active.id)
  })

  it("没有任何规格的商品不会被当成低库存", async () => {
    // stock 为「空」和 stock 为 0 是两回事。没有 SKU 的商品
    // 另有提示（前台显示售罄），不应该混进低库存列表
    const empty = await makeProduct()
    await makeProduct()

    const list = await getAdminProducts({ lowStock: true })

    expect(list.every((p) => p.id !== empty.id)).toBe(true)
    expect(list).toHaveLength(0)
  })
})

describe("订单列表：今天下单 / 今天付款两个筛选", () => {
  it("createdToday 只返回今天下的单", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const start = todayStart()

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      createdAt: hoursBefore(start, 2),
    })
    const todayOrder = await makeOrder({
      userId: user.id,
      skuId: sku.id,
      createdAt: new Date(start.getTime() + 60_000),
    })

    const list = await getAdminOrders({ createdToday: true })

    expect(list.total).toBe(1)
    expect(list.rows[0].id).toBe(todayOrder.id)
  })

  it("paidToday 只看今天到账的，且排除已取消", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const now = new Date()

    // 昨天付款，今天是付款时间之外
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      paidAt: hoursBefore(todayStart(), 5),
      createdAt: now,
    })

    const paidToday = await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.SHIPPED,
      paidAt: now,
    })

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.CANCELLED,
      paidAt: now,
    })

    const list = await getAdminOrders({ paidToday: true })

    expect(list.total).toBe(1)
    expect(list.rows[0].id).toBe(paidToday.id)
  })

  it("paidToday 和 status 同时给：显式的状态优先", async () => {
    // ?status=SHIPPED&paidToday=1 的意思是「今天付款且已发货」，
    // 而不是被 paidToday 自带的「非取消」条件盖掉
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const now = new Date()

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      paidAt: now,
    })
    const shipped = await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.SHIPPED,
      paidAt: now,
    })

    const list = await getAdminOrders({
      paidToday: true,
      status: ORDER_STATUS.SHIPPED,
    })

    expect(list.total).toBe(1)
    expect(list.rows[0].id).toBe(shipped.id)
  })

  it("两个筛选都不传时行为和以前完全一样", async () => {
    // 新参数不能改变老调用方的行为 —— 这是所有「加功能」的底线
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      createdAt: hoursBefore(todayStart(), 100),
    })
    await makeOrder({ userId: user.id, skuId: sku.id })

    const list = await getAdminOrders()

    expect(list.total).toBe(2)
  })

  it("筛选条件下的分页仍然自洽", async () => {
    // 【为什么这条要单独测】
    // 加了新的 where 条件之后，最容易漏的是「count 用了新条件、
    // findMany 忘了用」—— 于是列表里 3 条，却写着「共 45 笔，3 页」。
    // 两个查询是在一个 $transaction 里拼的，条件必须完全一致
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id, { stock: 999 })
    const start = todayStart()

    for (let i = 0; i < 25; i++) {
      await makeOrder({
        userId: user.id,
        skuId: sku.id,
        createdAt: new Date(start.getTime() + i * 60_000),
      })
    }
    for (let i = 0; i < 10; i++) {
      await makeOrder({
        userId: user.id,
        skuId: sku.id,
        createdAt: hoursBefore(start, i + 1),
      })
    }

    const page1 = await getAdminOrders({ createdToday: true, page: 1 })
    const page2 = await getAdminOrders({ createdToday: true, page: 2 })

    expect(page1.total).toBe(25) // 不是 35
    expect(page1.pageCount).toBe(2)
    expect(page1.rows).toHaveLength(20)
    expect(page2.rows).toHaveLength(5)

    const ids = [...page1.rows, ...page2.rows].map((r) => r.id)
    expect(new Set(ids).size).toBe(25) // 不重不漏
  })
})

describe("近 7 天销售额趋势：按 paidAt 按天聚合", () => {
  it("始终返回 7 个点，最后一个点是今天", async () => {
    const dashboard = await getAdminDashboard()

    expect(dashboard.salesTrend).toHaveLength(7)

    const last = dashboard.salesTrend[6].date
    const start = todayStart()
    expect(last.getFullYear()).toBe(start.getFullYear())
    expect(last.getMonth()).toBe(start.getMonth())
    expect(last.getDate()).toBe(start.getDate())
  })

  it("昨天付款的订单落在昨天的桶，今天的桶是 0", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      totalAmount: 5000,
      paidAt: hoursBefore(todayStart(), 12), // 昨天中午
    })

    const dashboard = await getAdminDashboard()
    // 倒数第二个点是昨天
    expect(dashboard.salesTrend[5].revenue).toBe(5000)
    expect(dashboard.salesTrend[6].revenue).toBe(0)
  })

  it("今天付款的金额计入最后一天，且和今日销售额一致", async () => {
    // 【为什么断言「和今日销售额一致」】
    // 趋势图最后那个点和 KPI 卡片上的「今日销售额」查的是同一批单。
    // 两个数字对不上，管理员就会发现「图和卡片打架」。
    // 这条用例把「同一口径」钉死，防止以后有人改一边不改另一边。
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const start = todayStart()

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      totalAmount: 12000,
      paidAt: new Date(start.getTime() + 3600_000),
    })
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      totalAmount: 8000,
      paidAt: new Date(start.getTime() + 7200_000),
    })

    const dashboard = await getAdminDashboard()

    expect(dashboard.salesTrend[6].revenue).toBe(20000)
    expect(dashboard.salesTrend[6].revenue).toBe(dashboard.todayRevenue)
  })

  it("已取消的订单（即便付过款）不计入趋势", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const now = new Date()

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.CANCELLED,
      totalAmount: 88000,
      paidAt: now,
      createdAt: now,
    })
    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PAID,
      totalAmount: 1000,
      paidAt: now,
      createdAt: now,
    })

    const dashboard = await getAdminDashboard()
    expect(dashboard.salesTrend[6].revenue).toBe(1000)
  })

  it("未付款（paidAt 为空）的订单不计入趋势", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    await makeOrder({
      userId: user.id,
      skuId: sku.id,
      status: ORDER_STATUS.PENDING_PAYMENT,
      totalAmount: 50000,
      createdAt: new Date(),
    })

    const dashboard = await getAdminDashboard()
    expect(dashboard.salesTrend[6].revenue).toBe(0)
  })

  it("相邻两天各自加总，不串桶", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    const start = todayStart()

    // 今天 3 笔，共 600 分
    for (const amount of [100, 200, 300]) {
      await makeOrder({
        userId: user.id,
        skuId: sku.id,
        status: ORDER_STATUS.PAID,
        totalAmount: amount,
        paidAt: new Date(start.getTime() + 3600_000),
      })
    }
    // 昨天 2 笔，共 900 分
    for (const amount of [400, 500]) {
      await makeOrder({
        userId: user.id,
        skuId: sku.id,
        status: ORDER_STATUS.PAID,
        totalAmount: amount,
        paidAt: hoursBefore(start, 12),
      })
    }

    const dashboard = await getAdminDashboard()
    expect(dashboard.salesTrend[6].revenue).toBe(600)
    expect(dashboard.salesTrend[5].revenue).toBe(900)
  })
})

describe("数字来源的唯一性", () => {
  it("lowStockSkuCount 是查出来的，不是把商品列表拉回来数的", async () => {
    // 【这条看起来像在测实现细节，其实不是】
    // 它记录的是「看板能不能扛住数据量」。如果哪天有人把
    // getAdminDashboard 改成先 findMany 所有 SKU 再 filter，
    // 功能上完全正确、测试也全绿，但后台首页会随 SKU 数量线性变慢。
    // 用 EXPLAIN 不好断言，退而求其次：确认计数的结果和
    // 「按商品分组再相加」一致 —— 也就是确认它走的确实是聚合那条路
    const product = await makeProduct()
    for (let i = 0; i < 30; i++) {
      await makeSku(product.id, { size: String(i), stock: i % 3 })
    }

    const grouped = await prisma.sku.groupBy({
      by: ["productId"],
      where: { stock: { lt: LOW_STOCK_THRESHOLD } },
      _count: { _all: true },
    })
    const expected = grouped.reduce((sum, row) => sum + row._count._all, 0)

    const dashboard = await getAdminDashboard()

    expect(dashboard.lowStockSkuCount).toBe(expected)
    expect(dashboard.lowStockSkuCount).toBeGreaterThan(0)
  })
})
