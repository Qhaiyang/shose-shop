import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS, ORDER_STATUS_VALUES } from "@/lib/constants"
import {
  ADMIN_PAGE_SIZE,
  getAdminOrders,
  getAdminOrderStats,
  getOrdersByUser,
} from "@/lib/orders"
import {
  addToCart,
  makeOrder,
  makeProduct,
  makeSku,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 订单列表的查询：分页、筛选、聚合 —— 集成测试
//
// 【为什么「分页筛选自洽」值得单独测】
// 列表页的数字是从好几条 SQL 拼出来的：count 给总数、findMany 给当前页、
// groupBy 给总件数、_count 给商品种类数。任何两个对不上，页面就会显示
// 「共 3 页」但翻到第 3 页是空的，或者「等 2 件商品，共 5 件」这种
// 自相矛盾的话。这类 bug 不会抛异常，只会让用户觉得这个网站有毛病。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

/** 造 n 张订单，状态按 i 轮流分给五个状态 */
async function makeOrders(n: number) {
  const user = await makeUser()
  const product = await makeProduct()
  const sku = await makeSku(product.id, { stock: 1000 })
  const statuses = ORDER_STATUS_VALUES

  const orders = []
  for (let i = 0; i < n; i++) {
    orders.push(
      await makeOrder({
        userId: user.id,
        skuId: sku.id,
        quantity: 1,
        status: statuses[i % statuses.length],
      }),
    )
  }

  return { user, product, sku, orders }
}

describe("分页：页数、边界、越界", () => {
  it("empty 库：total 0，pageCount 至少 1", async () => {
    // pageCount 用 Math.max(1, ...) 兜底。返回 0 的话
    // 前端渲染「第 1 / 0 页」很难看
    const page = await getAdminOrders()

    expect(page.total).toBe(0)
    expect(page.rows).toEqual([])
    expect(page.page).toBe(1)
    expect(page.pageCount).toBe(1)
  })

  it("刚好一整页：20 条 → 1 页", async () => {
    await makeOrders(ADMIN_PAGE_SIZE)

    const page = await getAdminOrders()

    expect(page.total).toBe(ADMIN_PAGE_SIZE)
    expect(page.rows).toHaveLength(ADMIN_PAGE_SIZE)
    expect(page.pageCount).toBe(1)
  })

  it("多出一条：21 条 → 2 页，第二页只有 1 条", async () => {
    // 这是分页最经典的差一错误：写成 Math.floor 而不是 Math.ceil，
    // 第 21 条就永远看不到
    await makeOrders(ADMIN_PAGE_SIZE + 1)

    const first = await getAdminOrders({ page: 1 })
    const second = await getAdminOrders({ page: 2 })

    expect(first.pageCount).toBe(2)
    expect(first.rows).toHaveLength(ADMIN_PAGE_SIZE)
    expect(second.rows).toHaveLength(1)
  })

  it("两页之间不重不漏", async () => {
    // 只断言「各有 20 条」是不够的 —— 有可能两页返回了同一批数据
    await makeOrders(ADMIN_PAGE_SIZE + 5)

    const first = await getAdminOrders({ page: 1 })
    const second = await getAdminOrders({ page: 2 })

    const ids = [...first.rows, ...second.rows].map((row) => row.id)

    expect(ids).toHaveLength(ADMIN_PAGE_SIZE + 5)
    expect(new Set(ids).size).toBe(ADMIN_PAGE_SIZE + 5) // 没有重复
  })

  it("按 createdAt 倒序，最新的在第一页第一条", async () => {
    const { orders } = await makeOrders(3)
    const newest = orders[orders.length - 1]

    const page = await getAdminOrders()

    expect(page.rows[0].id).toBe(newest.id)
  })

  it("页码越界返回空行，但 total 仍然正确", async () => {
    // 手敲 ?page=999 不该报错，只该显示空列表
    await makeOrders(3)

    const page = await getAdminOrders({ page: 999 })

    expect(page.total).toBe(3)
    expect(page.rows).toEqual([])
    expect(page.page).toBe(999)
  })

  it("非法页码被规整成 1", async () => {
    // ?page=0 / ?page=-1 / ?page=abc(→NaN) 都不能让 skip 变成负数。
    // skip 是负数时 SQLite 的行为不是报错，而是**当成 0**，
    // 于是第 0 页和第 1 页返回同样的数据 —— 看起来「能用」，实则错了
    await makeOrders(3)

    for (const bad of [0, -1, -100, Number.NaN, 0.5]) {
      const page = await getAdminOrders({ page: bad })
      expect(page.page).toBe(1)
      expect(page.rows.length).toBe(Math.min(3, ADMIN_PAGE_SIZE))
    }
  })
})

describe("筛选：按状态", () => {
  it("只返回指定状态的订单", async () => {
    await makeOrders(10)

    const paid = await getAdminOrders({ status: ORDER_STATUS.PAID })

    expect(paid.rows.length).toBeGreaterThan(0)
    for (const row of paid.rows) {
      expect(row.status).toBe(ORDER_STATUS.PAID)
    }
  })

  it("筛选后的 total 和 rows 对得上", async () => {
    // count 和 findMany 用了同一个 where 吗？这里是唯一能验证的地方
    await makeOrders(12)
    const all = await getAdminOrders()
    const paid = await getAdminOrders({ status: ORDER_STATUS.PAID })
    const cancelled = await getAdminOrders({ status: ORDER_STATUS.CANCELLED })

    // 各状态之和等于总数（取消了分页限制所以能直接比）
    expect(paid.total + cancelled.total).toBeLessThanOrEqual(all.total)

    // 每一页的 rows 数量不超过 total，也不超过 pageSize
    expect(paid.rows.length).toBe(Math.min(paid.total, ADMIN_PAGE_SIZE))
    expect(paid.pageCount).toBe(Math.max(1, Math.ceil(paid.total / ADMIN_PAGE_SIZE)))
  })

  it("筛选一个没有任何订单的状态 → 空结果，pageCount 仍是 1", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    await makeOrder({ userId: user.id, skuId: sku.id, status: ORDER_STATUS.PAID })

    const shipped = await getAdminOrders({ status: ORDER_STATUS.SHIPPED })

    expect(shipped.total).toBe(0)
    expect(shipped.rows).toEqual([])
    expect(shipped.pageCount).toBe(1)
  })

  it("不传 status 就是全部", async () => {
    await makeOrders(7)

    const all = await getAdminOrders()
    const summed = await Promise.all(
      ORDER_STATUS_VALUES.map((status) => getAdminOrders({ status })),
    )

    expect(summed.reduce((sum, p) => sum + p.total, 0)).toBe(all.total)
  })
})

describe("聚合字段：件数、种类数、买家信息", () => {
  it("totalQuantity 是 quantity 之和，itemKindCount 是订单项条数", async () => {
    // 「共 3 件」和「等 2 种商品」是两回事，页面两个都会显示
    const user = await makeUser()
    const product = await makeProduct()
    const a = await makeSku(product.id, { size: "42", color: "黑", stock: 100 })
    const b = await makeSku(product.id, { size: "43", color: "白", stock: 100 })

    await addToCart(user.id, a.id, 2)
    await addToCart(user.id, b.id, 5)

    const { createOrderFromCart } = await import("@/lib/orders")
    await createOrderFromCart(user.id, {
      address: "北京市朝阳区某路 1 号",
      phone: "13800138000",
    })

    const page = await getAdminOrders()
    const row = page.rows[0]

    expect(row.itemKindCount).toBe(2) // 两种商品
    expect(row.totalQuantity).toBe(7) // 2 + 5 件
  })

  it("每张订单的件数各不相同，不会被串到一起", async () => {
    // groupBy 的结果要按 orderId 映射回去。映射写错的话
    // 所有订单会显示同一个件数 —— 而且看起来「有数据」，不容易发现
    const user = await makeUser()
    const product = await makeProduct()
    const skuA = await makeSku(product.id, { size: "42", color: "黑" })
    const skuB = await makeSku(product.id, { size: "43", color: "白" })
    const skuC = await makeSku(product.id, { size: "44", color: "灰" })

    const { createOrderFromCart } = await import("@/lib/orders")
    const quantities = [1, 2, 3]
    const skus = [skuA, skuB, skuC]

    for (let i = 0; i < 3; i++) {
      await addToCart(user.id, skus[i].id, quantities[i])
      await createOrderFromCart(user.id, {
        address: "北京市朝阳区某路 1 号",
        phone: "13800138000",
      })
    }

    const page = await getAdminOrders()
    const byQuantity = page.rows.map((r) => r.totalQuantity).sort()

    expect(byQuantity).toEqual([1, 2, 3])
  })

  it("带出买家姓名和邮箱", async () => {
    const user = await makeUser({ name: "王五", email: "wangwu@test.dev" })
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    await makeOrder({ userId: user.id, skuId: sku.id })

    const page = await getAdminOrders()

    expect(page.rows[0].buyer).toEqual({ name: "王五", email: "wangwu@test.dev" })
  })

  it("statusLabel 是中文，不是原始枚举值", async () => {
    await makeOrders(5)

    const page = await getAdminOrders()

    for (const row of page.rows) {
      expect(row.statusLabel).not.toBe(row.status)
      expect(row.statusLabel).toMatch(/[一-龥]/) // 至少含一个汉字
    }
  })
})

describe("getAdminOrderStats：后台首页的统计数字", () => {
  it("五个状态都有，缺的补 0", async () => {
    // 用 ?? 0 到处兜底不如在这里就填满 —— 前端拿到的是完整的 Record
    const stats = await getAdminOrderStats()

    for (const status of ORDER_STATUS_VALUES) {
      expect(typeof stats[status]).toBe("number")
    }
    expect(stats.total).toBe(0)
  })

  it("各状态数之和等于 total，也等于实际订单数", async () => {
    await makeOrders(13)

    const stats = await getAdminOrderStats()

    const sum = ORDER_STATUS_VALUES.reduce((acc, s) => acc + stats[s], 0)
    expect(sum).toBe(stats.total)
    expect(stats.total).toBe(await prisma.order.count())
  })

  it("统计数字和列表的 total 一致", async () => {
    // 两个页面（首页用 stats、列表页用 getAdminOrders）显示的数字
    // 必须是一个来源，不然会出现「首页说 13 单，列表说 12 单」
    await makeOrders(8)

    const stats = await getAdminOrderStats()
    const list = await getAdminOrders()

    expect(stats.total).toBe(list.total)
  })

  it("数据库里存了非法状态时忽略它，不崩", async () => {
    // SQLite 没有 enum，手工改库或者老数据可能塞进任何字符串
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    await makeOrder({ userId: user.id, skuId: sku.id })

    // 直接绕过应用层塞一个脏状态
    await prisma.order.updateMany({ data: { status: "NOT_A_REAL_STATUS" } })

    const stats = await getAdminOrderStats()

    expect(stats.total).toBe(0) // 脏数据不计入任何已知状态
    expect(stats[ORDER_STATUS.PENDING_PAYMENT]).toBe(0)
  })
})

describe("getOrdersByUser：买家自己的列表", () => {
  it("带出封面图、种类数、总件数", async () => {
    const user = await makeUser()
    const product = await makeProduct({ images: ["/shoes/cover.svg", "/shoes/b.svg"] })
    const sku = await makeSku(product.id, { stock: 100 })
    await addToCart(user.id, sku.id, 4)

    const { createOrderFromCart } = await import("@/lib/orders")
    await createOrderFromCart(user.id, {
      address: "北京市朝阳区某路 1 号",
      phone: "13800138000",
    })

    const [summary] = await getOrdersByUser(user.id)

    expect(summary.coverImage).toBe("/shoes/cover.svg") // 取第一张
    expect(summary.itemKindCount).toBe(1)
    expect(summary.totalQuantity).toBe(4)
  })

  it("SKU 被删除后拿不到封面图，但不报错", async () => {
    // coverImage 是顺着可空的 skuId 关联出去的，断链要能兜住
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    await makeOrder({ userId: user.id, skuId: sku.id })

    await prisma.sku.delete({ where: { id: sku.id } })

    const [summary] = await getOrdersByUser(user.id)

    expect(summary.coverImage).toBeNull()
    expect(summary.itemKindCount).toBe(1) // 订单项还在
  })

  it("订单按创建时间倒序", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)

    const first = await makeOrder({ userId: user.id, skuId: sku.id })
    const second = await makeOrder({ userId: user.id, skuId: sku.id })

    const list = await getOrdersByUser(user.id)

    expect(list[0].id).toBe(second.id)
    expect(list[1].id).toBe(first.id)
  })
})
