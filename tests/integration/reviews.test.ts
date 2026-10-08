import { beforeEach, describe, expect, it } from "vitest"

import { ORDER_STATUS } from "@/lib/constants"
import { REVIEWS_PAGE_SIZE } from "@/lib/reviews"
import {
  createReview,
  getAdminReviews,
  getProductReviews,
  softDeleteReview,
} from "@/lib/reviews-db"
import {
  firstItemOf,
  makeOrder,
  makeProduct,
  makeSku,
  makeUser,
  prisma,
  resetDb,
  resetSeq,
} from "./helpers/db"

// ============================================================================
// 商品评价 —— 集成测试
//
// 星级解析和分布汇总的数学在单元测试里钉死了，这里测的是另一半：
//   - 查询的过滤 / 排序 / 分页真的按预期工作
//   - 「谁能评价」这条业务规则真的拦得住人
//   - 软删除之后「不能再评同一件」这条保证还在
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

/**
 * 造一条评价（绕过 createReview，直接写库）。
 *
 * 【为什么每个评价都得有自己的订单项】
 * Review.orderItemId 上有唯一约束 —— 这就是「一件商品只能评一次」的载体。
 * 所以 6 条评价得有 6 个订单项。
 *
 * 【为什么订单项的 skuId 留空】
 * 这些用例测的是**查询**，不关心商品是怎么被买到的。
 * skuId 可空本来就是允许的（SKU 被物理删除后就是这个状态）。
 * 测 createReview 的用例才会造真正的 SKU —— 那里需要顺着 skuId 找商品。
 */
async function makeReviewRow(options: {
  userId: string
  productId: string
  rating: number
  content?: string
  isDeleted?: boolean
  createdAt?: Date
}) {
  const order = await makeOrder({
    userId: options.userId,
    status: ORDER_STATUS.COMPLETED,
  })

  const item = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      productName: "测试鞋款",
      size: "42",
      color: "黑色",
      price: 89900,
      quantity: 1,
    },
  })

  return prisma.review.create({
    data: {
      userId: options.userId,
      productId: options.productId,
      orderItemId: item.id,
      rating: options.rating,
      content: options.content ?? "默认评价内容",
      ...(options.isDeleted ? { isDeleted: true } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  })
}

/** 造一张「已完成、带一个真 SKU 订单项」的订单，createReview 需要它 */
async function makeCompletedOrder(userId: string) {
  const product = await makeProduct()
  const sku = await makeSku(product.id, { price: 89900 })
  const order = await makeOrder({
    userId,
    status: ORDER_STATUS.COMPLETED,
    skuId: sku.id,
  })
  const item = await firstItemOf(order.id)

  return { product, sku, order, item }
}

describe("getProductReviews：详情页的评价查询", () => {
  it("只返回这一款商品的评价", async () => {
    const user = await makeUser()
    const target = await makeProduct()
    const other = await makeProduct()

    await makeReviewRow({ userId: user.id, productId: target.id, rating: 5 })
    await makeReviewRow({ userId: user.id, productId: other.id, rating: 1 })

    const page = await getProductReviews(target.id)

    expect(page.total).toBe(1)
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0].rating).toBe(5)
    // 另一款商品的差评不能串进来 —— 串了的话分数会莫名其妙地低
    expect(page.summary.average).toBe(5)
  })

  it("被下架（软删除）的评价对买家不可见", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    await makeReviewRow({ userId: user.id, productId: product.id, rating: 5 })
    await makeReviewRow({
      userId: user.id,
      productId: product.id,
      rating: 1,
      isDeleted: true,
    })

    const page = await getProductReviews(product.id)

    expect(page.total).toBe(1)
    expect(page.rows.map((row) => row.rating)).toEqual([5])
    // 汇总也必须是「只算没下架的」—— 否则列表里一条、分数按两条算
    expect(page.summary.total).toBe(1)
    expect(page.summary.average).toBe(5)
  })

  it("按时间倒序，最新的在最前面", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    const base = Date.now()
    await makeReviewRow({
      userId: user.id,
      productId: product.id,
      rating: 3,
      content: "中间那条",
      createdAt: new Date(base - 2 * 60 * 1000),
    })
    await makeReviewRow({
      userId: user.id,
      productId: product.id,
      rating: 5,
      content: "最新那条",
      createdAt: new Date(base - 60 * 1000),
    })
    await makeReviewRow({
      userId: user.id,
      productId: product.id,
      rating: 1,
      content: "最旧那条",
      createdAt: new Date(base - 3 * 60 * 1000),
    })

    const page = await getProductReviews(product.id)

    expect(page.rows.map((row) => row.content)).toEqual([
      "最新那条",
      "中间那条",
      "最旧那条",
    ])
  })

  it("汇总的条数、平均分、分布和评价一一对上", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    // 5 星 1 条、4 星 2 条：(5 + 4 + 4) / 3 = 4.333… → 4.3
    for (const rating of [5, 4, 4]) {
      await makeReviewRow({ userId: user.id, productId: product.id, rating })
    }

    const { summary } = await getProductReviews(product.id)

    expect(summary.total).toBe(3)
    expect(summary.average).toBe(4.3)
    expect(summary.bars.map((bar) => bar.count)).toEqual([1, 2, 0, 0, 0])
    // 百分比只保留整数
    expect(summary.bars.map((bar) => bar.percent)).toEqual([33, 67, 0, 0, 0])
  })

  it("评价人的昵称带出来了，但没带邮箱", async () => {
    const user = await makeUser({ name: "李小明" })
    const product = await makeProduct()
    await makeReviewRow({ userId: user.id, productId: product.id, rating: 5 })

    const page = await getProductReviews(product.id)

    // 详情页是公开页面，作者的邮箱不该出现在上面
    expect(page.rows[0].authorName).toBe("李小明")
    expect(Object.keys(page.rows[0])).not.toContain("authorEmail")
  })

  it("分页：一页放满 REVIEWS_PAGE_SIZE 条，剩下的进第二页", async () => {
    const user = await makeUser()
    const product = await makeProduct()

    const total = REVIEWS_PAGE_SIZE + 2
    for (let i = 0; i < total; i += 1) {
      await makeReviewRow({
        userId: user.id,
        productId: product.id,
        rating: 5,
        content: `第 ${i} 条`,
        createdAt: new Date(Date.now() - i * 60 * 1000),
      })
    }

    const first = await getProductReviews(product.id, 1)
    const second = await getProductReviews(product.id, 2)

    expect(first.rows).toHaveLength(REVIEWS_PAGE_SIZE)
    expect(second.rows).toHaveLength(2)
    expect(first.total).toBe(total)
    expect(first.pageCount).toBe(2)
    // 两页的内容不能重叠 —— 排序不稳定时最容易出的就是这种错
    const ids = new Set([...first.rows, ...second.rows].map((row) => row.id))
    expect(ids.size).toBe(total)
  })

  it("非法的页码落回第 1 页，而不是抛 Prisma 错误", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    await makeReviewRow({ userId: user.id, productId: product.id, rating: 5 })

    // NaN 直接进 skip 就是一个 PrismaClientValidationError（500）
    for (const page of [Number.NaN, 0, -3, undefined]) {
      const result = await getProductReviews(product.id, page)
      expect(result.page).toBe(1)
      expect(result.rows).toHaveLength(1)
    }
  })

  it("没有评价时返回空列表和全 0 的汇总", async () => {
    const product = await makeProduct()

    const page = await getProductReviews(product.id)

    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
    expect(page.pageCount).toBe(1)
    expect(page.summary.total).toBe(0)
    expect(page.summary.average).toBe(0)
  })
})

describe("createReview：谁能评价", () => {
  it("已完成订单的本人可以评价，评价挂在正确的商品上", async () => {
    const user = await makeUser()
    const { product, item } = await makeCompletedOrder(user.id)

    const result = await createReview(item.id, user.id, {
      rating: 5,
      content: "尺码标准，脚感很好",
      images: [],
    })

    expect(result).toEqual({ ok: true, productId: product.id })

    const saved = await prisma.review.findUniqueOrThrow({
      where: { orderItemId: item.id },
    })
    expect(saved.productId).toBe(product.id)
    expect(saved.userId).toBe(user.id)
    expect(saved.rating).toBe(5)
    expect(saved.isDeleted).toBe(false)
  })

  it("图片存成 JSON 字符串，读出来还是数组", async () => {
    const user = await makeUser()
    const { product, item } = await makeCompletedOrder(user.id)

    await createReview(item.id, user.id, {
      rating: 4,
      content: "晒两张图",
      images: ["/shoes/a.svg", "/shoes/b.svg"],
    })

    // SQLite 不支持标量数组，只能自己序列化 —— 这里确认来回都正确
    const page = await getProductReviews(product.id)
    expect(page.rows[0].images).toEqual(["/shoes/a.svg", "/shoes/b.svg"])
  })

  it("订单还没完成时被拒 —— 这是服务端自己查出来的，不信前端", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    const sku = await makeSku(product.id)
    // 已发货但还没确认收货：货还在路上，评价没有意义
    const order = await makeOrder({
      userId: user.id,
      status: ORDER_STATUS.SHIPPED,
      skuId: sku.id,
    })
    const item = await firstItemOf(order.id)

    const result = await createReview(item.id, user.id, {
      rating: 5,
      content: "还没收到货就先给个五星",
      images: [],
    })

    expect(result.ok).toBe(false)
    expect(await prisma.review.count()).toBe(0)
  })

  it("拿别人的订单项来评价会被拒，而且和「不存在」是同一句话", async () => {
    const owner = await makeUser()
    const attacker = await makeUser()
    const { item } = await makeCompletedOrder(owner.id)

    const stolen = await createReview(item.id, attacker.id, {
      rating: 5,
      content: "我没买过但这双鞋真不错",
      images: [],
    })
    const missing = await createReview("not-a-real-order-item", attacker.id, {
      rating: 5,
      content: "随便编一个 id",
      images: [],
    })

    expect(stolen).toEqual({ ok: false, error: "找不到这条订单商品" })
    // 【为什么两句必须一模一样】分开说就等于告诉调用方
    // 「这个订单项是存在的」，可以拿它逐个探测
    expect(missing).toEqual(stolen)
    expect(await prisma.review.count()).toBe(0)
  })

  it("同一件商品只能评价一次", async () => {
    const user = await makeUser()
    const { item } = await makeCompletedOrder(user.id)

    const first = await createReview(item.id, user.id, {
      rating: 5,
      content: "第一次评价，五星好评",
      images: [],
    })
    const second = await createReview(item.id, user.id, {
      rating: 1,
      content: "想改成差评但是改不了",
      images: [],
    })

    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, error: "这条商品已经评价过了" })
    // 第二次不能把第一条覆盖掉，也不能多出一条
    expect(await prisma.review.count()).toBe(1)
  })

  it("SKU 已被删除（skuId 为空）时无法评价", async () => {
    const user = await makeUser()
    // 不传 skuId 造出来的订单项，skuId 是 null —— 模拟 SKU 被物理删除
    const order = await makeOrder({ userId: user.id, status: ORDER_STATUS.COMPLETED })
    const item = await firstOrderItemWithNullSku(order.id)

    const result = await createReview(item.id, user.id, {
      rating: 5,
      content: "商品都没了还想评价",
      images: [],
    })

    expect(result.ok).toBe(false)
    expect(await prisma.review.count()).toBe(0)
  })
})

/** makeOrder 只有传了 skuId 才会建订单项，这里手写一个 skuId 为空的 */
async function firstOrderItemWithNullSku(orderId: string) {
  return prisma.orderItem.create({
    data: {
      orderId,
      productName: "已删除的商品",
      size: "42",
      color: "黑色",
      price: 89900,
      quantity: 1,
    },
  })
}

describe("softDeleteReview：管理员下架评价", () => {
  it("下架之后详情页查不到，但行还在库里", async () => {
    const user = await makeUser()
    const { product, item } = await makeCompletedOrder(user.id)
    await createReview(item.id, user.id, {
      rating: 1,
      content: "这是一条要被下架的评价",
      images: [],
    })
    const review = await prisma.review.findUniqueOrThrow({
      where: { orderItemId: item.id },
    })

    const result = await softDeleteReview(review.id)

    expect(result).toEqual({ ok: true })
    expect((await getProductReviews(product.id)).total).toBe(0)
    // 【这是软删除和真删除的分水岭】行还在，只是 isDeleted 变成 true
    const stillThere = await prisma.review.findUnique({ where: { id: review.id } })
    expect(stillThere?.isDeleted).toBe(true)
  })

  it("重复下架会被拒，而不是把标志位写两遍", async () => {
    const user = await makeUser()
    const { item } = await makeCompletedOrder(user.id)
    await createReview(item.id, user.id, {
      rating: 5,
      content: "第一条评价内容",
      images: [],
    })
    const review = await prisma.review.findUniqueOrThrow({
      where: { orderItemId: item.id },
    })

    await softDeleteReview(review.id)
    const again = await softDeleteReview(review.id)

    expect(again).toEqual({ ok: false, error: "评价不存在或已被删除" })
  })

  it("评价被下架之后，那件商品依然不能再评一次", async () => {
    const user = await makeUser()
    const { item } = await makeCompletedOrder(user.id)
    await createReview(item.id, user.id, {
      rating: 1,
      content: "违规内容，等着被管理员下架",
      images: [],
    })
    const review = await prisma.review.findUniqueOrThrow({
      where: { orderItemId: item.id },
    })
    await softDeleteReview(review.id)

    const retry = await createReview(item.id, user.id, {
      rating: 5,
      content: "被删了那我重新写一条好评",
      images: [],
    })

    // 【为什么这条必须测】如果软删除是「真删除行」，orderItemId 的唯一约束
    // 就跟着一起没了，用户可以删了写、写了删无限刷分。
    // 留着行才堵得住这个口子 —— 这正是选软删除的原因之一
    expect(retry).toEqual({ ok: false, error: "这条商品已经评价过了" })
    expect(await prisma.review.count()).toBe(1)
  })
})

describe("getAdminReviews：后台评价列表", () => {
  it("已下架的评价也留在列表里，并且单独计数", async () => {
    const user = await makeUser()
    const product = await makeProduct()
    await makeReviewRow({ userId: user.id, productId: product.id, rating: 5 })
    await makeReviewRow({
      userId: user.id,
      productId: product.id,
      rating: 1,
      isDeleted: true,
    })

    const page = await getAdminReviews()

    // 【和 getProductReviews 正好相反】买家看不到已下架的，管理员必须看到 ——
    // 否则「软删除」和「真删除」在界面上毫无区别，误删了也发现不了
    expect(page.total).toBe(2)
    expect(page.deletedCount).toBe(1)
    expect(page.rows.filter((row) => row.isDeleted)).toHaveLength(1)
  })

  it("带上商品名和评价人的联系方式", async () => {
    const user = await makeUser({ name: "王五" })
    const product = await makeProduct({ name: "「测试」跑鞋" })
    await makeReviewRow({ userId: user.id, productId: product.id, rating: 4 })

    const page = await getAdminReviews()
    const row = page.rows[0]

    expect(row.productName).toBe("「测试」跑鞋")
    expect(row.authorName).toBe("王五")
    // 管理员要能联系到人，所以这里**必须**有邮箱 ——
    // 和买家侧公开页面刚好相反（见上一个 describe 里的断言）
    expect(row.authorEmail).toBe(user.email)
  })

  it("没有评价时返回空列表", async () => {
    const page = await getAdminReviews()

    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
    expect(page.deletedCount).toBe(0)
  })
})
