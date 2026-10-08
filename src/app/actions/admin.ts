"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { requireAdmin } from "@/lib/auth"
import { COUPON_TYPE, MAX_STOCK_DELTA } from "@/lib/constants"
import {
  createCoupon,
  setCouponActive,
  updateCoupon,
} from "@/lib/coupons-db"
import { endOfDay } from "@/lib/dates"
import {
  parseDateInput,
  parseImageLines,
  parseNonNegativeInt,
  parseYuanToCents,
} from "@/lib/form"
import {
  bulkAdjustProductStock,
  bulkSetProductActive,
  bulkUpdateProductPrice,
} from "@/lib/product-bulk"
// productSchema / skuSchema 搬去了 lib —— "use server" 文件只能导出 async 函数，
// schema 定义在本文件里就没法被测试 import
import {
  bulkPriceSchema,
  bulkProductIdsSchema,
  bulkStockDeltaSchema,
  couponSchema,
  productSchema,
  skuSchema,
} from "@/lib/schemas"
import { shipOrder, type TransitionOrderResult } from "@/lib/orders"
import {
  adjustSkuStock,
  createProduct,
  createSku,
  deleteProduct,
  deleteSku,
  setProductActive,
  updateProduct,
  updateSkuPrice,
} from "@/lib/products"
import { softDeleteReview } from "@/lib/reviews-db"

// ============================================================================
// 管理后台 Server Actions
//
// 【最重要的一件事：layout 保护不了 Server Action】
//
// 我刚给 /admin 加了 layout.tsx，非管理员进去会被拦下。但那**只对页面渲染有效**。
//
// Server Action 编译后是一个独立的 POST 端点，客户端可以直接调它，
// 整个 React 组件树（包括 layout）根本不会参与。
// 也就是说：普通用户没法通过浏览器**看到**后台页面，
// 但完全可以自己构造一个请求去调 shipOrderAction。
//
// 所以每一个后台 action 都必须**自己再查一遍权限**，不能依赖：
//   ✗ 前端的按钮 disabled
//   ✗ 页面上有没有渲染这个按钮
//   ✗ layout 里已经拦过了
//   ✗ 路由叫 /admin
//
// 这就是「纵深防御」：每一层都假设上一层已经失守。
// 成本是重复几行代码，收益是任何一层被绕过都不会出事。
//
// 【这个文件为什么单独存在，而不是塞进 orders.ts 的 action 里】
// 把所有需要管理员权限的操作集中在一个文件，好处是：
// 你只要看这一个文件，就能确认「所有后台写操作都做了权限校验」。
// 如果它们散落在各个 action 文件里，漏掉一个很难被发现。
// ============================================================================

type AdminActionResult =
  | { ok: true }
  | { ok: false; error: string }

// requireAdmin 现在住在 src/lib/auth.ts。
//
// 【为什么从"复制一份"改成"共用一份"】
// 第 7 步的退款把管理员的「批准 / 拒绝」放进了 actions/refund.ts ——
// 那个文件是按**业务**分的（买家申请 + 管理员处理写在同一个功能文件里），
// 而本文件是按**权限**分的。两套切法都成立，于是权限检查这两个文件都要用。
// 抄一份的代价是「谁算管理员」变成两处各判一次：将来加了客服角色，
// 漏改一处的表现是某个后台操作对普通用户敞开，而且不会有测试报错。
// 详见 lib/auth.ts 里 requireAdmin 的注释。

// ---------------------------------------------------------------------------
// 发货
// ---------------------------------------------------------------------------

/**
 * 管理员发货：把订单从 PAID 推到 SHIPPED。
 *
 * 【为什么 orderId 可以从客户端传】
 * 和用户支付是同一个道理：订单 id 只是个「操作哪一条」的定位符，
 * 不是权限凭证。权限由 requireAdmin() 把关，状态合法与否由
 * shipOrder 里 SQL 的 WHERE 把关。三个条件是独立的，缺一不可。
 *
 * 【为什么不需要额外校验 orderId 格式】
 * 它只会被当成字符串塞进 SQL 的 WHERE，Prisma 会做参数化绑定，
 * 不存在注入。查不到就是不存在的订单，走 updateMany 的 count = 0 分支。
 * 但仍然限制一下长度，避免有人用超长字符串来试探。
 */
export async function shipOrderAction(
  orderId: string,
): Promise<TransitionOrderResult | AdminActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 64) {
    return { ok: false, error: "订单参数不正确" }
  }

  const result = await shipOrder(orderId)

  if (result.ok) {
    console.log(`[admin] ${auth.user.email} 发货订单 ${orderId}`)
    // 后台列表、后台详情、用户自己的订单列表和详情，四处都要重新查
    revalidatePath("/admin/orders")
    revalidatePath(`/admin/orders/${orderId}`)
    revalidatePath("/orders")
    revalidatePath(`/orders/${orderId}`)
  }

  return result
}

// ============================================================================
// 商品管理 —— 第 9b 步
//
// 每一个 action 仍然以 requireAdmin() 开头，理由见本文件顶部那段长注释。
// 页面上的按钮长什么样、有没有渲染，都跟权限无关。
// ============================================================================

// 输入解析（元→分、多行文本→图片数组）在 src/lib/form.ts。
// "use server" 文件只能导出 async 函数，所以纯函数必须放在外面 ——
// 那里有详细的说明。
//
// ---------------------------------------------------------------------------
// 商品：新建 / 编辑
// ---------------------------------------------------------------------------

export type ProductFormValues = {
  name: string
  description: string
  category: string
  images: string[]
}

/** useActionState 的返回值。新建和编辑两个表单共用 */
export type ProductFormState =
  | {
      errors?: {
        name?: string[]
        description?: string[]
        category?: string[]
        images?: string[]
      }
      /** 非字段级的整体错误（没权限、商品不存在……） */
      message?: string
      /**
       * 失败时把用户填过的内容退回去，道理和 SkuFormState.values 一样：
       * React 19 在 action 结束后会自动重置整个表单，
       * 不回传的话用户输入的内容就白填了。
       */
      values?: ProductFormValues
    }
  | undefined

/**
 * 从 formData 取出商品字段并校验。新建和编辑共用同一套规则。
 *
 * 返回值里同时带上已清洗的 values —— 校验失败时 action 要把它退给客户端，
 * 让用户不用重填。清洗过的值比原始输入更适合回填（去了空格、图片去了重）
 */
function readProductForm(formData: FormData): ReturnType<typeof productSchema.safeParse> & {
  values: ProductFormValues
} {
  // 这里手工 String(...).trim() 而不是用 zod 的 .trim()，
  // 因为「先转换还是先校验」在这类链式 API 里很容易记反 ——
  // 见 actions/auth.ts 里对同一个坑的说明。清洗交给这里，zod 只管校验
  const values: ProductFormValues = {
    name: String(formData.get("name") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    category: String(formData.get("category") ?? "").trim(),
    images: parseImageLines(formData.get("images")),
  }

  return Object.assign(productSchema.safeParse(values), { values })
}

export async function createProductAction(
  _prevState: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { message: auth.error }

  const parsed = readProductForm(formData)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors, values: parsed.values }
  }

  const product = await createProduct(parsed.data)

  console.log(`[admin] ${auth.user.email} 新建商品《${parsed.data.name}》`)

  revalidatePath("/admin/products")
  revalidatePath("/products")

  // 新商品一个 SKU 都还没有，前台点了会显示售罄 ——
  // 直接把管理员送到编辑页去加规格，并带个 ?created=1 显示一句引导。
  //
  // redirect() 靠抛异常工作，必须在所有 try/catch 之外。
  // 这个函数里没有 try/catch，所以放在最后一行是安全的
  redirect(`/admin/products/${product.id}?created=1`)
}

export async function updateProductAction(
  _prevState: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { message: auth.error }

  const productId = String(formData.get("productId") ?? "")
  if (!productId) return { message: "缺少商品 id" }

  const parsed = readProductForm(formData)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors, values: parsed.values }
  }

  await updateProduct(productId, parsed.data)

  console.log(`[admin] ${auth.user.email} 修改商品《${parsed.data.name}》`)

  // 后台列表、后台详情、前台列表、前台详情 —— 四处缓存都要作废
  revalidatePath("/admin/products")
  revalidatePath(`/admin/products/${productId}`)
  revalidatePath("/products")
  revalidatePath(`/products/${productId}`)

  // 返回 {} 而不是 undefined：undefined 会被 useActionState 当成
  // 「还没提交过」，{} 才表示「提交过了，没有错误」
  return {}
}

// ---------------------------------------------------------------------------
// 商品：上下架 / 删除
// ---------------------------------------------------------------------------

export async function setProductActiveAction(
  productId: string,
  isActive: boolean,
): Promise<AdminActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (typeof productId !== "string" || productId.length === 0 || productId.length > 64) {
    return { ok: false, error: "商品参数不正确" }
  }

  await setProductActive(productId, isActive)

  console.log(
    `[admin] ${auth.user.email} ${isActive ? "上架" : "下架"}商品 ${productId}`,
  )

  revalidatePath("/admin/products")
  revalidatePath(`/admin/products/${productId}`)
  revalidatePath("/products")
  revalidatePath(`/products/${productId}`)

  return { ok: true }
}

/**
 * 删除商品。
 *
 * 【为什么真删之前先在页面上引导用「下架」】
 * 见 src/lib/products.ts 里 setProductActive 的注释：卖过的商品不该删。
 * deleteProduct 内部会检查有没有被订单引用，被引用就拒绝 ——
 * 这里是第二道闸，页面上是第三道（按钮上就写着风险）。
 */
export async function deleteProductAction(
  productId: string,
): Promise<AdminActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (typeof productId !== "string" || productId.length === 0 || productId.length > 64) {
    return { ok: false, error: "商品参数不正确" }
  }

  const result = await deleteProduct(productId)

  if (result.ok) {
    console.log(`[admin] ${auth.user.email} 删除商品 ${productId}`)
    revalidatePath("/admin/products")
    revalidatePath("/products")
  }

  return result
}

// ---------------------------------------------------------------------------
// SKU：新增 / 改价 / 调库存 / 删除
// ---------------------------------------------------------------------------

/** 失败时原样退回用户填过的内容，免得他重填一遍 */
export type SkuFormValues = {
  color: string
  size: string
  price: string
  stock: string
}

export type SkuFormState =
  | {
      errors?: {
        size?: string[]
        color?: string[]
        price?: string[]
        stock?: string[]
      }
      message?: string
      /**
       * 【为什么要把用户填的内容原样退回去】
       * React 19 有一个很容易踩的行为：`<form action={fn}>` 提交结束后，
       * React 会**自动把整个表单重置**，不管这次是成功还是失败。
       *
       * 好处是成功时不用手写清空逻辑 —— 加完一个规格，输入框自己就空了。
       * 坏处是校验失败时，用户刚填的四个字段也一起没了，
       * 他得全部重打一遍才能改掉那个错的。
       *
       * 所以失败时把这些值带回来，客户端拿它们当 defaultValue 重新渲染。
       * 成功时不带（values 是 undefined），表单自然保持空 —— 两边都对。
       */
      values?: SkuFormValues
    }
  | undefined

export async function createSkuAction(
  _prevState: SkuFormState,
  formData: FormData,
): Promise<SkuFormState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { message: auth.error }

  const productId = String(formData.get("productId") ?? "")
  if (!productId) return { message: "缺少商品 id" }

  // 先原样留一份用户输入。任何一条失败路径都把它带回去
  const values: SkuFormValues = {
    color: String(formData.get("color") ?? "").trim(),
    size: String(formData.get("size") ?? "").trim(),
    price: String(formData.get("price") ?? "").trim(),
    stock: String(formData.get("stock") ?? "").trim(),
  }

  const priceCents = parseYuanToCents(values.price)
  if (priceCents === null) {
    return { errors: { price: ["价格格式不对，例如 899 或 899.00"] }, values }
  }
  if (priceCents <= 0) {
    return { errors: { price: ["价格必须大于 0"] }, values }
  }

  const parsed = skuSchema.safeParse({
    size: values.size,
    color: values.color,
    // parseNonNegativeInt 返回 NaN 而不是 0 —— 详见 src/lib/form.ts
    stock: parseNonNegativeInt(values.stock),
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors, values }
  }

  const result = await createSku(productId, {
    ...parsed.data,
    price: priceCents,
  })

  if (!result.ok) return { message: result.error, values }

  console.log(
    `[admin] ${auth.user.email} 给 ${productId} 新增规格 ${parsed.data.color}/${parsed.data.size}码`,
  )

  revalidatePath(`/admin/products/${productId}`)
  revalidatePath("/products")
  revalidatePath(`/products/${productId}`)

  // 返回 {} 而不是 { values }：成功时不清空是 React 自己做的
  // （见 SkuFormState.values 的说明），客户端不用再管
  return {}
}

export async function updateSkuPriceAction(
  skuId: string,
  priceInput: string,
): Promise<AdminActionResult & { price?: number }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  const priceCents = parseYuanToCents(priceInput)
  if (priceCents === null || priceCents <= 0) {
    return { ok: false, error: "价格格式不对，例如 899 或 899.00" }
  }

  const result = await updateSkuPrice(skuId, priceCents)
  if (!result.ok) return result

  console.log(`[admin] ${auth.user.email} 把规格 ${skuId} 的价格改成 ${priceCents} 分`)

  revalidatePath("/admin/products")
  revalidatePath("/products")

  return { ok: true, price: result.price }
}

/**
 * 调整库存。delta > 0 入库，delta < 0 出库。
 *
 * 【为什么参数是「增减量」而不是「目标值」】
 * 这是这一节最该记住的一点。假设页面提供「把库存设成 100」：
 *
 *   t1  管理员打开页面，看到库存 100
 *   t2  有买家下单买了 3 件，库存变成 97
 *   t3  管理员填 100 提交 —— 于是那 3 件被「凭空补回来」了
 *
 * 库存少卖了 3 件还算轻的，反过来（设成一个比真实值小的数）会
 * 让本来有货的商品显示售罄。根子在于「读」和「写」之间隔了一个人脑。
 *
 * 改成增减量就没有这个问题：+N 表达的是「又进了 N 件货」，
 * 这句话在任何时刻都成立，跟当前库存是多少无关。
 * 底层实现见 src/lib/products.ts 的 adjustSkuStock —— 出库走的是
 * 带 stock >= 数量的条件更新，绝不可能扣成负数。
 */
export async function adjustSkuStockAction(
  skuId: string,
  delta: number,
): Promise<AdminActionResult & { stock?: number }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_STOCK_DELTA) {
    return { ok: false, error: `调整数量必须是 1 ~ ${MAX_STOCK_DELTA} 之间的整数` }
  }

  const result = await adjustSkuStock(skuId, delta)
  if (!result.ok) return result

  console.log(
    `[admin] ${auth.user.email} 调整规格 ${skuId} 库存 ${delta > 0 ? "+" : ""}${delta}`,
  )

  revalidatePath("/admin/products")
  revalidatePath("/products")

  return { ok: true, stock: result.stock }
}

export async function deleteSkuAction(
  skuId: string,
): Promise<AdminActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  const result = await deleteSku(skuId)

  if (result.ok) {
    console.log(`[admin] ${auth.user.email} 删除规格 ${skuId}`)
    revalidatePath("/admin/products")
    revalidatePath("/products")
  }

  return result
}

// ---------------------------------------------------------------------------
// 商品：批量操作
//
// 【为什么每个 action 都要把 ids 再校验一遍】
// 这些 action 是被客户端组件调用的，而客户端组件里的「勾选了哪几款」
// 完全是浏览器说了算 —— 谁都可以打开控制台，用任意一个数组去调它们。
// 「界面上最多勾 100 个」这句话，对直接构造请求的人来说毫无约束力。
//
// 所以校验必须在**服务端**再做一次，而且是每个 action 各自做 ——
// 不能指望「反正组件里已经拦过了」。
// 和文件头部那段「layout 保护不了 Server Action」是同一件事的两面。
// ---------------------------------------------------------------------------

export type AdminBulkResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

/** 批量操作成功后统一刷新的页面 */
function revalidateProductPages(): void {
  revalidatePath("/admin/products")
  revalidatePath("/products")
}

/** 校验通过后返回 id 数组，否则返回错误。省得每个 action 重复这段 */
function parseBulkIds(
  ids: unknown,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const parsed = bulkProductIdsSchema.safeParse(ids)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "商品参数不正确" }
  }

  // 去重。勾选界面本身不会产生重复的 id，但直接调接口的人可以传
  // ["a","a","a"] —— 不去重的话 count 校验（found !== ids.length）
  // 会算出 1 !== 3，然后报一个「有 2 款商品已经不存在了」的假错误
  return { ok: true, ids: [...new Set(parsed.data)] }
}

/**
 * 批量上架 / 下架。
 *
 * 【为什么 isActive 要单独校验类型】
 * 它会被拼进 message 和日志里。如果放任它是个字符串 "x"，
 * 逻辑上 `isActive ? "上架" : "下架"` 会把任何真值都当成上架，
 * 于是 {"isActive": "false"} 会**上架**商品 —— 一个字符串
 * 让操作朝反方向执行，而且没有任何报错
 */
export async function bulkSetProductActiveAction(
  ids: string[],
  isActive: boolean,
): Promise<AdminBulkResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  const parsed = parseBulkIds(ids)
  if (!parsed.ok) return parsed

  if (typeof isActive !== "boolean") {
    return { ok: false, error: "参数不正确" }
  }

  const result = await bulkSetProductActive(parsed.ids, isActive)
  if (!result.ok) return result

  console.log(
    `[admin] ${auth.user.email} 批量${isActive ? "上架" : "下架"} ${result.affected} 款商品`,
  )
  revalidateProductPages()

  return { ok: true, message: result.message }
}

/**
 * 批量改价。
 *
 * 【为什么价格从客户端传的是**字符串**而不是数字】
 * 「899.00」这个输入用数字传会经过一次 JSON 序列化和一次浮点解析，
 * 而 0.29 这类值在二进制浮点里本来就存不准。整个项目处理金额的原则是
 * 「只在最后渲染时才转元」—— 用户输入的那一刻也是一样：
 * 把原始字符串带上服务端，用 parseYuanToCents 按小数点拆，
 * 中间不经过任何浮点运算。
 * 单个改价的 updateSkuPriceAction 也是这个套路。
 */
export async function bulkUpdateProductPriceAction(
  ids: string[],
  mode: string,
  rawValue: string,
): Promise<AdminBulkResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  const parsedIds = parseBulkIds(ids)
  if (!parsedIds.ok) return parsedIds

  if (typeof rawValue !== "string") {
    return { ok: false, error: "参数不正确" }
  }
  const trimmed = rawValue.trim()

  let value: number
  if (mode === "set") {
    const cents = parseYuanToCents(trimmed)
    if (cents === null) {
      return { ok: false, error: "价格格式不对，例如 899 或 899.00" }
    }
    value = cents
  } else if (mode === "percent") {
    // 用正则而不是 parseInt：parseInt("10abc") 会愉快地返回 10，
    // 把「用户输错了」变成「按 10% 改了」。严格匹配整数字符串才算数
    if (!/^-?\d{1,3}$/.test(trimmed)) {
      return { ok: false, error: "百分比必须是整数，例如 10 或 -15" }
    }
    value = Number(trimmed)
  } else {
    return { ok: false, error: "参数不正确" }
  }

  const parsed = bulkPriceSchema.safeParse({ mode, value })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数不正确" }
  }

  const result = await bulkUpdateProductPrice(
    parsedIds.ids,
    parsed.data.mode,
    parsed.data.value,
  )
  if (!result.ok) return result

  console.log(
    `[admin] ${auth.user.email} 批量改价 mode=${parsed.data.mode} value=${parsed.data.value} 影响 ${result.affected} 个规格`,
  )
  revalidateProductPages()

  return { ok: true, message: result.message }
}

// ============================================================================
// 商品评价 —— 软删除
//
// 【为什么这个 action 放在 admin.ts 而不是 actions/review.ts】
// 提交评价是买家的事，下架评价是管理员的事，两者权限模型完全不同。
// 本文件开头的注释说过这个文件存在的意义：把**所有**后台写操作集中在一处，
// 这样「后台写操作都做了鉴权」这句话只需要看一个文件就能确认。
// 把软删除留在 review.ts 里，就破坏了这条规矩。
//
// 【为什么是软删除】
// 详见 prisma/schema.prisma 里 Review 模型的注释：留着行，orderItemId 的
// 唯一约束才还占着位（同一件商品不会被重复评价），管理员也才复查得了
// 自己删过什么。所以这里只把 isDeleted 置 true，一行都不删。
// ============================================================================

/**
 * 下架一条评价。
 *
 * 【productId 为什么由客户端传】
 * 它只用来作废商品详情页的缓存。传错了最多让某个页面多查一次数据库，
 * 没有任何越权风险 —— 和「不能信任客户端传价格」是两回事：
 * 价格是业务数据，productId 只是个「刷新哪一页」的定位符。
 */
export async function deleteReviewAction(
  reviewId: string,
  productId: string,
): Promise<AdminActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (
    typeof reviewId !== "string" ||
    reviewId.length === 0 ||
    reviewId.length > 64
  ) {
    return { ok: false, error: "评价参数不正确" }
  }

  const result = await softDeleteReview(reviewId)
  if (!result.ok) return result

  console.log(`[admin] ${auth.user.email} 下架评价 ${reviewId}`)

  revalidatePath("/admin/reviews")
  revalidatePath("/products")
  if (typeof productId === "string" && productId.length > 0 && productId.length <= 64) {
    revalidatePath(`/products/${productId}`)
  }

  return { ok: true }
}

/** 批量调库存。delta > 0 入库，delta < 0 出库 */
export async function bulkAdjustProductStockAction(
  ids: string[],
  delta: number,
): Promise<AdminBulkResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  const parsedIds = parseBulkIds(ids)
  if (!parsedIds.ok) return parsedIds

  const parsed = bulkStockDeltaSchema.safeParse(delta)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数不正确" }
  }

  const result = await bulkAdjustProductStock(parsedIds.ids, parsed.data)
  if (!result.ok) return result

  console.log(
    `[admin] ${auth.user.email} 批量调库存 ${parsed.data > 0 ? "+" : ""}${parsed.data} 影响 ${result.affected} 个规格`,
  )
  revalidateProductPages()

  return { ok: true, message: result.message }
}

// ---------------------------------------------------------------------------
// 优惠券：新建 / 编辑 / 停用
//
// 【为什么券的后台比商品的后台简单】
// 商品要管 SKU、库存、图片、批量操作；券就是一张表、几个数字。
// 所以这里只有三个 action，没有批量、没有删除 ——
// 尤其是**没有删除**：删券会让历史订单的 couponId 被置空，
// 「这单用了哪张券」就查不到了（见 coupons-db.ts 的 setCouponActive）。
// 停用能表达「不发了」，而且不留坑。
// ---------------------------------------------------------------------------

/**
 * 表单里回填用的值。全是**字符串**，因为表单控件收的就是字符串 ——
 * 把「元」转成「分」是提交时的事（见 readCouponForm），
 * 回填时要还原成用户当初敲的样子，不然他看到的是「10000」而不是「100」
 */
export type CouponFormValues = {
  code: string
  type: string
  value: string
  minSpend: string
  maxDiscount: string
  startAt: string
  endAt: string
  totalLimit: string
  perUserLimit: string
  isActive: boolean
}

export type CouponFormState =
  | {
      errors?: {
        code?: string[]
        type?: string[]
        value?: string[]
        minSpend?: string[]
        maxDiscount?: string[]
        startAt?: string[]
        endAt?: string[]
        totalLimit?: string[]
        perUserLimit?: string[]
      }
      message?: string
      values?: CouponFormValues
    }
  | undefined

/** 从 formData 里读出一个字段，缺失时给空串（表单重置后就是这种状态） */
function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim()
}

/**
 * 取券表单并校验。新建和编辑共用。
 *
 * 【为什么 type 要单独先读出来】
 * 因为 value 这个输入框的含义**由 type 决定**：
 *   满减券填的是「元」，要转成分（100 → 10000）
 *   折扣券填的是「百分比整数」（10 表示 9 折），原样用
 * 如果无脑按「元 → 分」解析，那张 9 折券的 value 会变成 1000，
 * 也就是「减 1000%」—— 而 zod 会放行（范围 1~99 拦不住这种量级吗？
 * 其实拦得住，1000 > 99），但用户看到的报错会是「折扣百分比最多 99」，
 * 完全指不到「你不该在这里填元」。所以这里必须分开解析。
 *
 * maxDiscount 只在折扣券上存在，满减券传 null ——
 * couponSchema 里 FIXED 分支写的就是 z.null()，传别的值会被拒
 */
function readCouponForm(
  formData: FormData,
): ReturnType<typeof couponSchema.safeParse> & { values: CouponFormValues } {
  const type = field(formData, "type")
  const isPercent = type === COUPON_TYPE.PERCENT

  const values: CouponFormValues = {
    code: field(formData, "code"),
    type,
    value: field(formData, "value"),
    minSpend: field(formData, "minSpend"),
    maxDiscount: field(formData, "maxDiscount"),
    startAt: field(formData, "startAt"),
    endAt: field(formData, "endAt"),
    totalLimit: field(formData, "totalLimit"),
    perUserLimit: field(formData, "perUserLimit"),
    isActive: formData.get("isActive") === "on",
  }

  // 解析失败一律给 NaN/null，让 zod 去说「必须是数字」——
  // 这里不自己编错误文案，规则和文案都在 schemas.ts 里有一份
  const parsed = couponSchema.safeParse({
    code: values.code,
    type,
    // 折扣券的 value 是百分比（原样），满减券的是金额（元 → 分）
    value: isPercent ? parseNonNegativeInt(values.value) : parseYuanToCents(values.value),
    minSpend: parseYuanToCents(values.minSpend === "" ? "0" : values.minSpend),
    maxDiscount: isPercent
      ? parseYuanToCents(values.maxDiscount)
      : null,
    // 开始日期取当天零点，结束日期取当天最后一毫秒 ——
    // 见 src/lib/dates.ts 的 endOfDay（「到 10 月 31 日」不能理解成 31 号零点）
    startAt: parseDateInput(values.startAt),
    endAt: (() => {
      const day = parseDateInput(values.endAt)
      return day ? endOfDay(day) : null
    })(),
    totalLimit: parseNonNegativeInt(values.totalLimit),
    perUserLimit: parseNonNegativeInt(values.perUserLimit),
    isActive: values.isActive,
  })

  return Object.assign(parsed, { values })
}

/** 券改动后要作废哪些页面 —— 前后台都要，因为券在两边都显示 */
function revalidateCouponPages(id?: string): void {
  revalidatePath("/admin/coupons")
  if (id) revalidatePath(`/admin/coupons/${id}`)
  // 前台：领券入口在商品详情页和购物车页，领到的券在「我的券」，用券在结算页
  revalidatePath("/my-coupons")
  revalidatePath("/cart")
  revalidatePath("/checkout")
}

export async function createCouponAction(
  _prevState: CouponFormState,
  formData: FormData,
): Promise<CouponFormState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { message: auth.error }

  const parsed = readCouponForm(formData)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors, values: parsed.values }
  }

  const result = await createCoupon(parsed.data)
  // 券码撞了之类的失败要原样带回表单（含用户填的一堆数字），
  // 让他改一个字段就能重试，而不是从头再填一遍
  if (!result.ok) return { message: result.error, values: parsed.values }

  console.log(`[admin] ${auth.user.email} 新建优惠券 ${parsed.data.code}`)

  revalidateCouponPages(result.id)

  // 新建完跳回列表：那里有「已领 0/100」这种全局视图，
  // 比停在编辑页更能确认「确实建出来了」。redirect 必须在 try/catch 之外
  redirect("/admin/coupons?created=1")
}

export async function updateCouponAction(
  _prevState: CouponFormState,
  formData: FormData,
): Promise<CouponFormState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { message: auth.error }

  const couponId = field(formData, "couponId")
  if (!couponId) return { message: "缺少优惠券 id" }

  const parsed = readCouponForm(formData)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors, values: parsed.values }
  }

  const result = await updateCoupon(couponId, parsed.data)
  if (!result.ok) return { message: result.error, values: parsed.values }

  console.log(`[admin] ${auth.user.email} 修改优惠券 ${parsed.data.code}`)

  revalidateCouponPages(couponId)

  return {}
}

/**
 * 停用 / 启用一张券。
 *
 * 【为什么和商品的上下架一样做成幂等的 set(desired)】
 * 理由见 src/lib/favorites-db.ts 里 setFavorite 的注释：
 * 传「我想要什么」而不是 toggle，重复点击和过期页面都不会翻到反面。
 */
export async function setCouponActiveAction(
  couponId: string,
  isActive: boolean,
): Promise<AdminActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (
    typeof couponId !== "string" ||
    couponId.length === 0 ||
    couponId.length > 64
  ) {
    return { ok: false, error: "优惠券参数不正确" }
  }

  const result = await setCouponActive(couponId, isActive === true)
  if (!result.ok) return { ok: false, error: result.error }

  console.log(
    `[admin] ${auth.user.email} ${isActive ? "启用" : "停用"}优惠券 ${couponId}`,
  )

  revalidateCouponPages(couponId)

  return { ok: true }
}
