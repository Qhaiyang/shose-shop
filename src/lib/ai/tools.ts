// ============================================================================
// tools.ts：模型能调用的「手」
//
// 【为什么工具要和 client.ts 分开】
// client.ts 只管「怎么跟 DeepSeek 说话」，tools.ts 只管「模型能问什么、我们怎么答」。
// 前者换供应商会变，后者不会。分开写，换模型时 tools.ts 一个字不用改。
//
// 【这一层最像项目里的谁】
// 像 Server Action：外面（这里是模型）给一份不可信输入，我们这里 safeParse、
// 补上「当前用户是谁」，再调 src/lib/orders.ts 里的领域函数。模型和浏览器一样，
// 都不可信。
//
// 【userId 为什么是函数参数，不在 input schema 里】
// input schema 是模型填的。如果 userId 在 schema 里，模型（或者诱导它的人）
// 就能填别人的 id 去看别人的订单。所以 userId 从参数进来 —— 只有 agent 能给，
// 而 agent 的 userId 来自 session。和 getOrderDetail(orderId, userId) 同一条防线。
// ============================================================================

import { z } from "zod"

import { orderStatusSchema } from "@/lib/constants"
import { formatPrice } from "@/lib/format"
import {
  getOrderDetailByNo,
  getOrdersByUser,
  type OrderDetail,
  type OrderSummary,
} from "@/lib/orders"

import type { AiTool } from "./client"

/** 工具统一返回形状。agent 会 JSON.stringify 它，塞回 role:"tool" 那条消息 */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

// ============================================================================
// 1. 输入 schema —— 模型填的那部分
//
// 只有 status 一个可填项，直接复用 constants.ts 里已有的 orderStatusSchema，
// 不重新写一份枚举：写两份，将来加一个订单状态就会漏改一处。
// ============================================================================

export const listMyOrdersInput = z.object({
  status: orderStatusSchema
    .optional()
    .describe("按订单状态过滤；不传表示「全部订单」"),
})

export type ListMyOrdersInput = z.infer<typeof listMyOrdersInput>

// ============================================================================
// 2. 输出 schema —— 喂给模型看的形状
//
// 注意：这份 schema 描述的是「模型读到什么」，不是「前端渲染什么」。
// 所以钱已经格式化成了字符串（¥899.00）、时间已经是中文本地时间、
// 状态已经是中文标签。模型的活儿只是把这些话原样转述给用户，
// 不该让它去做「分转元」或者「枚举转中文」这种我们已经在别处做好的事 ——
// 让它算，它就可能算错。
// ============================================================================

/** 单个订单：只留模型和用户对话时用得上的字段 */
export const orderForModelSchema = z.object({
  /**
   * 单号（SO2026...）。它同时是两样东西：说给用户听的，和下一轮
   * 查详情时当把手的。**不给 id** —— 见下面 toModelOrder 的注释
   */
  orderNo: z.string(),
  /** 中文状态标签，如「待付款」「已发货」 */
  status: z.string(),
  /** 已格式化的金额字符串，如 "¥899.00"。模型不要自己转换 */
  totalPrice: z.string(),
  /** 已格式化的本地时间字符串 */
  createdAt: z.string(),
  /** 总件数（不是商品种类数） */
  totalQuantity: z.number(),
})

/** 整个工具的返回体 */
const listMyOrdersOutput = z.object({ orders: z.array(orderForModelSchema) })

/** 把领域对象压成「模型视角」的那几个字段 */
function toModelOrder(order: OrderSummary) {
  return {
    // 【为什么不给模型 id】
    // getOrderDetail 改成按单号查之后，id 在这条链路上**一个消费者都没有**。
    // 留着它，模型手上就有两个标识符、其中一个是废的，而「该用哪个」
    // 只能靠 description 里一句话去教 —— 教不住的时候就是一次查不到，
    // 而且它不会报错，只会礼貌地说「没找到这一单」。
    //
    // 这和 layout 里藏悬浮球、action 里照样验登录是同一条道理：
    // 能靠结构让错误不可能发生，就别靠说明书去提醒。
    orderNo: order.orderNo,
    status: order.statusLabel,
    totalPrice: formatPrice(order.totalAmount),
    createdAt: order.createdAt.toLocaleString("zh-CN"),
    totalQuantity: order.totalQuantity,
  }
}

// ============================================================================
// 3. 工具声明 —— 告诉 DeepSeek 有这么个工具、能传什么参数
//
// parameters 必须是 JSON Schema。zod v4 自带 toJSONSchema()，
// 不用再装 zod-to-json-schema（那是 zod v3 时代的包）。
//
// description 是真正的 prompt：写得越具体，模型越少乱调。
// 「什么时候用」比「它做什么」更重要。
// ============================================================================

export const listMyOrdersTool: AiTool = {
  name: "listMyOrders",
  description:
    "查询当前登录用户自己的订单列表，最新的在前。" +
    "当用户问「我的订单」「我买了什么」「我的单到哪了」「有几单还没付款」时调用。" +
    "只能查当前用户自己的订单，查不到别人的。" +
    "返回里的 orderNo 就是查单笔详情要用的那个单号。" +
    "不要用它回答「某个单的具体明细」——那用 getOrderDetail。",
  parameters: z.toJSONSchema(listMyOrdersInput) as Record<string, unknown>,
}

// ============================================================================
// 4. 执行器 —— agent 拿到模型给的参数后，真正去查库的那步
//
// 顺序固定：safeParse（模型给的不可信）→ 查库 → 映射 → 返回。
// 这里不 try/catch 吞异常，而是显式返回 ok:false：让 agent 决定
// 要不要把失败告诉模型（目前是告诉，让模型回一句「我这边查不到，稍后再试」）。
// ============================================================================

export async function executeListMyOrders(
  userId: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = listMyOrdersInput.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, error: `参数不合法：${parsed.error.issues[0]?.message}` }
  }

  let orders: OrderSummary[]
  try {
    orders = await getOrdersByUser(userId)
  } catch (error) {
    // 不把原始异常抛给模型：它既看不懂 stack，也可能被用户看到
    console.error("[ai] listMyOrders 查库失败", error)
    return { ok: false, error: "查询订单失败，请稍后再试" }
  }

  // 按状态过滤放内存里做，不传给 getOrdersByUser：
  // 那个函数现在只按 userId 查，加个过滤参数就得动已经被 653 条测试
  // 覆盖的 orders.ts。一个用户的订单也就几十条，内存过滤够用。
  // 真到上万条时，再把 status 推进 where（那时也该顺手加 take 分页）。
  const filtered = parsed.data.status
    ? orders.filter((o) => o.status === parsed.data.status)
    : orders

  // 运行时防线：把「映射函数」和「schema」这两份会各自漂移的东西钉在一起。
  // 这里**故意放在 catch 之外**：到这一步失败只可能是代码 bug
  // （白名单里多写/少写了一个字段），不是「查库失败」——
  // 它必须当场炸出来，而不是被 catch 降级成一句「稍后再试」骗过模型和测试。
  return {
    ok: true,
    data: listMyOrdersOutput.parse({ orders: filtered.map(toModelOrder) }),
  }
}

// ============================================================================
// 5. getOrderDetail —— 输入 schema
//
// 只收一个 orderNo。
//
// 【为什么是单号，不是 id】
// 工具结果不跨轮留存：history 里只有人和助手说过的话。第一轮
// listMyOrders 拿到的 id，到第二轮已经不在任何地方了 —— 模型手上
// 只剩它自己上一条回复里念过的那个单号。
//
// 所以拿 id 当把手，注定是「模型只能编一个」；拿单号当把手，
// 用户自己念得出来、模型转述得出来、上下轮都活得下来。
// 这一条不是口味问题，是那个「追问寄到哪了 → 没找到这一单」的 bug 教出来的。
//
// 模型自己编一个单号也无所谓 —— 查出来必然是空，因为 where 里永远带着 userId。
// ============================================================================

export const getOrderDetailInput = z.object({
  orderNo: z
    .string()
    .min(1)
    .describe(
      "订单号，形如 SO20261009...。用 listMyOrders 返回里的 orderNo，或者用户自己说的那个单号；不要改写、不要编造",
    ),
})

export type GetOrderDetailInput = z.infer<typeof getOrderDetailInput>

// ============================================================================
// 6. 输出 schema —— 模型视角的订单详情
//
// 和 listMyOrders 的输出**故意不是同一套字段**：
// 那个是「列表」，给的是摘要（件数、总价）；这个是「详情」，给的是内容
// （买了什么、寄到哪、什么时候发的）。同一个订单两种形状，各伺候一个用途。
//
// 【phone 为什么要打码再给模型】
// 手机号是**身份标识**：完整号码落到第三方模型和聊天记录里，是能直接被
// 拿去做诈骗/撞库的。而客服场景真正要的只是「让用户核对是不是这个号」——
// 138****8000 足够核对，不构成完整号码。地址不打码，是因为地址本来就要
// 念给用户看（「寄到 XX 路 1 号」），遮了这工具就没用了。
// 这两个字段都是用户自己的，不涉及越权；这里防的是**数据外流**，不是越权。
// ============================================================================

const orderItemForModelSchema = z.object({
  productName: z.string(),
  size: z.string(),
  color: z.string(),
  price: z.string(),
  quantity: z.number(),
})

export const orderDetailForModelSchema = z.object({
  // 注意这里没有 id —— 详情是拿去「念给用户听」的，里面没有一个字段
  // 是给模型当把手的。单号已经在 listMyOrders 那一层给过它了
  orderNo: z.string(),
  status: z.string(),
  items: z.array(orderItemForModelSchema),
  itemsTotal: z.string(),
  discountAmount: z.string(),
  couponCode: z.string().nullable(),
  totalAmount: z.string(),
  /** 收货地址原文。用户要核对就念它 */
  address: z.string(),
  /** 已打码的手机号，如 138****8000 */
  phone: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  refundedAt: z.string().nullable(),
})

const getOrderDetailOutput = z.object({
  order: orderDetailForModelSchema.nullable(),
})

/** 13800138000 → 138****8000。留前 3 后 4，够核对，又不是完整号码 */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "*".repeat(phone.length)
  return `${phone.slice(0, 3)}${"*".repeat(phone.length - 7)}${phone.slice(-4)}`
}

function formatTime(time: Date | null): string | null {
  return time ? time.toLocaleString("zh-CN") : null
}

function toModelOrderDetail(order: OrderDetail) {
  return {
    orderNo: order.orderNo,
    status: order.statusLabel,
    items: order.items.map((item) => ({
      productName: item.productName,
      size: item.size,
      color: item.color,
      price: formatPrice(item.price),
      quantity: item.quantity,
    })),
    itemsTotal: formatPrice(order.itemsTotal),
    discountAmount: formatPrice(order.discountAmount),
    couponCode: order.coupon?.code ?? null,
    totalAmount: formatPrice(order.totalAmount),
    address: order.address,
    phone: maskPhone(order.phone),
    note: order.note,
    createdAt: order.createdAt.toLocaleString("zh-CN"),
    paidAt: formatTime(order.paidAt),
    shippedAt: formatTime(order.shippedAt),
    completedAt: formatTime(order.completedAt),
    cancelledAt: formatTime(order.cancelledAt),
    refundedAt: formatTime(order.refundedAt),
  }
}

// ============================================================================
// 7. 工具声明
//
// description 里必须写清三件事：orderNo 从哪来（listMyOrders 的返回，
// 或者用户自己说的）、手上没有单号时该先做什么、以及「查不到」该怎么说。
// 这三句不写，模型就会自己编一个单号，或者把 null 解释成「系统出错」。
// 工具失败信息写在哪，比工具做什么更容易被忽略。
// ============================================================================

export const getOrderDetailTool: AiTool = {
  name: "getOrderDetail",
  description:
    "查某一笔订单的完整详情：买了什么、金额构成、收货信息、备注、各节点时间。" +
    "当用户问「这单什么时候发的」「寄到哪」「为什么便宜了」「我备注写的什么」时调用。" +
    "orderNo 用 listMyOrders 返回里的那个单号，或者用户自己说出来的单号。" +
    "手上没有单号时，先调 listMyOrders 拿一个，不要凭空编。" +
    "如果返回的 order 是 null，说明没找到这一单（单号不对，或不属于当前用户）——" +
    "直接告诉用户没找到，不要重试，也不要猜原因。" +
    "只能查当前用户自己的订单。",
  parameters: z.toJSONSchema(getOrderDetailInput) as Record<string, unknown>,
}

// ============================================================================
// 8. 执行器
//
// 注意这里**没有**「单号不存在」和「单号属于别人」两个分支 ——
// getOrderDetailByNo 的 where 是 { orderNo, userId }，两种情况合成同一个 null。
// 这不是偷懒，是刻意的：分开报错就等于给模型一个探测器，
// 让它能问出「这个单号存不存在」；而它对这两种情况的正确反应本来就一样。
// ============================================================================

export async function executeGetOrderDetail(
  userId: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = getOrderDetailInput.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, error: `参数不合法：${parsed.error.issues[0]?.message}` }
  }

  let order: OrderDetail | null
  try {
    order = await getOrderDetailByNo(parsed.data.orderNo, userId)
  } catch (error) {
    console.error("[ai] getOrderDetail 查库失败", error)
    return { ok: false, error: "查询订单失败，请稍后再试" }
  }

  // 「查不到」不是失败，是成功的空答案 —— 和 listMyOrders 查不到时回 [] 一致。
  // 用 ok:false 表示「工具没跑成」，用 ok:true + null 表示「跑成了，就是没有」。
  // 模型据此决定：前者该说「我这边出问题了」，后者该说「没找到这个单」。
  if (!order) return { ok: true, data: { order: null } }

  return {
    ok: true,
    data: getOrderDetailOutput.parse({ order: toModelOrderDetail(order) }),
  }
}
