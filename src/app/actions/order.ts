"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { getCurrentUser } from "@/lib/auth"
import { checkoutSchema, orderNoteSchema } from "@/lib/schemas"
import {
  confirmReceipt,
  createOrderFromCart,
  payOrder,
  updateOrderNote,
  type TransitionOrderResult,
  type UpdateOrderNoteResult,
} from "@/lib/orders"

// ============================================================================
// 下单 Server Action
//
// 【这个 action 只收「收货信息」两个字段】
// 商品、数量、单价、总价一个都不从表单里读 —— 全部由服务端拿 userId
// 去数据库里查购物车得到。表单里就算塞了 price=1 也不会被用到。
//
// 【redirect 的位置】
// 和 auth.ts 一样，redirect() 必须放在 try/catch 之外，
// 否则它抛出的特殊异常会被自己的 catch 吃掉，跳转静默失效。
// 这里 createOrderFromCart 用返回值而不是抛错来表示「库存不足」，
// 所以整个函数根本不需要 try/catch，顺带就避开了这个坑。
// ============================================================================

export type OrderFormState =
  | {
      errors?: {
        address?: string[]
        phone?: string[]
        note?: string[]
      }
      message?: string
      /** 库存不足时是哪个 SKU —— 前端用来定位到结算页摘要里对应那一行 */
      insufficientSkuId?: string
    }
  | undefined

export async function createOrderAction(
  _prevState: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  // 下单必须先登录。照例自己从 cookie 里认人，不接受客户端传 userId
  const user = await getCurrentUser()
  if (!user) {
    return { message: "登录状态已失效，请重新登录后再下单" }
  }

  const parsed = checkoutSchema.safeParse({
    address: formData.get("address"),
    phone: formData.get("phone"),
    // 备注是选填，表单里没这个字段时 get() 返回 null，
    // 而 orderNoteSchema 收的是字符串 —— 补一个空串，
    // 让它走「空串 → null」那条正常路径，而不是当成校验失败
    note: String(formData.get("note") ?? ""),
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  // 【券为什么不过 zod，而是手动读一下】
  // 它是个可选的「引用 id」，唯一的规则是「非空字符串」——
  // 给它写个 schema 只是为了报一句「券不合法」，而真正决定它合不合法的
  // 是数据库里的那张券（是不是你的、过没过期、有没有被抢完）。
  // 那件事只有 createOrderFromCart 查了库才知道，这里拦不出任何东西。
  // 空串当成「没用券」：表单里没选券时提交上来的就是这个
  const rawUserCouponId = formData.get("userCouponId")
  const userCouponId =
    typeof rawUserCouponId === "string" && rawUserCouponId !== ""
      ? rawUserCouponId
      : null

  // 【幂等键为什么也不过 zod，和券同一个道理】
  // 它没有任何「格式合法与否」可言 —— 客户端给的任意字符串都能用，
  // 服务端拿它去数据库里比一下就知道重没重复。真正需要校验的
  // 是它**属于谁**，而那件事是靠 where 里的 userId 保证的，
  // 不是靠格式检查。空串（隐藏字段没渲染出来）归成 null = 不做幂等
  const rawIdempotencyKey = formData.get("idempotencyKey")
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey !== ""
      ? rawIdempotencyKey
      : null

  const result = await createOrderFromCart(user.id, {
    ...parsed.data,
    userCouponId,
    idempotencyKey,
  })

  if (!result.ok) {
    // 库存不足这类业务失败。购物车内容可能已经过期（别人买走了），
    // 让购物车页和结算页都重新查一遍最新库存，前端据此标红对应行
    revalidatePath("/cart")
    revalidatePath("/checkout")
    return {
      message: result.error,
      insufficientSkuId: result.insufficientSkuId,
    }
  }

  // 下单成功后购物车被清空、订单列表多了一条
  revalidatePath("/cart")
  revalidatePath("/orders")

  redirect(`/orders/${result.orderId}`)
}

// ============================================================================
// 模拟支付 Server Action
//
// 【为什么不用 useActionState、也就不用 form action】
// 支付没有表单字段要填，也不需要保留「上次的错误状态」——
// 失败了弹个 toast 就够了，用户再点一次按钮即可。
// 所以它收的是普通参数、返回普通对象，由客户端组件用 useTransition 调。
//
// 【为什么返回值里没有 redirect】
// 支付成功后停在原页面最合适：用户能立刻看到状态从「待支付」变成「已支付」，
// 比跳走更有反馈感。客户端拿到 ok: true 后 toast + router.refresh()，
// 刷新会重新跑服务端组件，徽章就变色了。
//
// 【为什么 orderId 可以从客户端传】
// 订单 id 不是秘密（用户本来就能在 URL 里看到），真正的防线是 payOrder 里
// where 条件上的 userId —— 传别人的 id 只会得到 count=0。
// 这和「不能信任客户端传来的价格」是两回事：
// 价格是业务数据（被改了会亏钱），订单 id 只是个「我要操作哪一条」的定位符。
// ============================================================================

export type PayOrderActionResult = { ok: true } | { ok: false; error: string }

export async function payOrderAction(
  orderId: string,
): Promise<PayOrderActionResult> {
  if (typeof orderId !== "string" || orderId.length === 0) {
    return { ok: false, error: "订单参数不正确" }
  }

  // 照例从 cookie 认人，不接受客户端传 userId
  const user = await getCurrentUser()
  if (!user) {
    return { ok: false, error: "登录状态已失效，请重新登录" }
  }

  const result = await payOrder(orderId, user.id)

  if (result.ok) {
    // 详情页的状态徽章、订单列表里那一条，都要重新查
    revalidatePath(`/orders/${orderId}`)
    revalidatePath("/orders")
  }

  return result
}

// ============================================================================
// 确认收货 Server Action
//
// 状态机的最后一跳：SHIPPED → COMPLETED。
//
// 【为什么这一步不需要「管理员确认」】
// 收货这件事只有买家自己知道 —— 快递有没有送到、鞋合不合脚，
// 商家无从判断。所以确认权在用户手里，这也是各大电商的通行做法。
//
// 【和支付长得一模一样】
// 同样是「用户对自己订单的操作」，所以同样：
//   - 从 cookie 认人，不接受客户端传 userId
//   - 把 userId 写进 updateMany 的 WHERE，越权自然 count = 0
//   - 把「当前必须是 SHIPPED」写进 WHERE，防重复确认
//
// 唯一的差别是这一步**不碰库存、不碰钱** —— 库存早在下单时就扣了，
// 钱在支付时就收了。确认收货纯粹是把状态推到终态，让订单从
// 「进行中」的列表里消失。
// ============================================================================

export async function confirmReceiptAction(
  orderId: string,
): Promise<TransitionOrderResult> {
  if (typeof orderId !== "string" || orderId.length === 0) {
    return { ok: false, error: "订单参数不正确" }
  }

  const user = await getCurrentUser()
  if (!user) {
    return { ok: false, error: "登录状态已失效，请重新登录" }
  }

  const result = await confirmReceipt(orderId, user.id)

  if (result.ok) {
    revalidatePath(`/orders/${orderId}`)
    revalidatePath("/orders")
    // 后台的订单列表和详情也要跟着变 —— 管理员会看到这条订单变成「已完成」
    revalidatePath("/admin/orders")
    revalidatePath(`/admin/orders/${orderId}`)
  }

  return result
}

// ============================================================================
// 改订单备注 Server Action
//
// 【为什么它和 payOrderAction 长得一样，而不是用 useActionState】
// 备注没有「保留用户输入重新显示」的需求 —— 失败时 textarea 里的字还在
// 组件自己的 state 里，不需要服务端把它带回来。所以按普通参数收、
// 返回普通对象，客户端用 useTransition 调。
//
// 【为什么 note 要在这里再过一次 schema】
// 虽然 client 端会传「已经归一化过的」值，但这个 action 编译后是一个
// 可以被任意 POST 直接打的接口 —— 客户端传什么都可能。长度上限和
// trim 必须在服务端再做一遍。（前端加 maxLength 只是体验，不是防线。）
// ============================================================================

export type UpdateNoteActionResult = UpdateOrderNoteResult

export async function updateOrderNoteAction(
  orderId: string,
  note: string,
): Promise<UpdateNoteActionResult> {
  // orderId 只是个定位符（用户本来就能在 URL 里看到），
  // 真正的防线是 updateOrderNote 里 WHERE 上的 userId
  if (typeof orderId !== "string" || orderId.length === 0) {
    return { ok: false, error: "订单参数不正确" }
  }

  const user = await getCurrentUser()
  if (!user) {
    return { ok: false, error: "登录状态已失效，请重新登录" }
  }

  // 【为什么要显式判 string】不判的话，传个对象进来会在 .trim() 那里
  // 抛 TypeError，变成一个 500 —— 一个本该是「参数不合法」的错误
  const parsed = orderNoteSchema.safeParse(
    typeof note === "string" ? note : "",
  )
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "备注不合法" }
  }

  const result = await updateOrderNote(orderId, user.id, parsed.data)

  if (result.ok) {
    // 买家详情页和后台详情页都要重新渲染 —— 管理员得看到最新那句交代
    revalidatePath(`/orders/${orderId}`)
    revalidatePath(`/admin/orders/${orderId}`)
  }

  return result
}
