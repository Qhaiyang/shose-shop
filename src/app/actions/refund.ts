"use server"

import { revalidatePath } from "next/cache"

import { getCurrentUser, requireAdmin } from "@/lib/auth"
import { approveRefund, rejectRefund, requestRefund } from "@/lib/refunds-db"
import { refundRejectionSchema, refundRequestSchema } from "@/lib/schemas"

// ============================================================================
// 退款 Server Actions
//
// 【为什么买家和管理员的 action 写在同一个文件里】
// 项目里另有一个 actions/admin.ts，那里是按**权限**分的：打开它就能
// 确认「所有后台写操作都做了权限校验」。这个文件是按**业务**分的：
// 申请 → 批准 / 拒绝是一条完整的流程，分开写的话，「退款到底会改哪些东西」
// 这个问题要跨两个文件才能回答。
//
// 两种切法都有道理，所以这里用的是「按业务分，但每个 action 自己鉴权」——
// 也就是本项目一贯的规矩：
//   - 买家 action → getCurrentUser()，拿不到就拒
//   - 管理员 action → requireAdmin()，不是管理员就拒
//
// **绝不允许**出现「因为这个 action 在后台页面上，所以是安全的」这种想法。
// Server Action 编译后是一个独立的 POST 端点，任何人都能直接打。
//
// 【为什么这个文件里没有「谁该退多少钱」的计算】
// 金额是 refunds-db.ts 里的事，而且规则只有一条：退实付。
// action 只负责「鉴权 + 校验参数 + 重新渲染」，不参与业务判断 ——
// 这样从 action 的长度就能一眼看出它有没有偷偷做业务。
// ============================================================================

/** 三个 action 共用的返回形状。和订单那几个 action 保持一致，前端不用学新东西 */
export type RefundActionResult =
  | { ok: true; refundAmount: number }
  | { ok: false; error: string }

/**
 * 买家申请退款。
 *
 * 【为什么 orderId 可以从客户端传】
 * 和支付、发货是同一个道理：订单 id 只是个「操作哪一条」的定位符，
 * 不是权限凭证。权限来自下面从 cookie 认出来的 user.id，
 * 状态合法与否由 requestRefund 里 SQL 的 WHERE 把关。
 *
 * 【为什么 refundAmount 不由客户端传】
 * 这是整个功能里唯一不能信任客户端的地方 —— 表单里塞一个
 * `refundAmount=999999` 就能把平台掏空。所以金额只可能来自
 * 服务端读出来的订单实付。表单里压根就没有这个字段。
 */
export async function requestRefundAction(
  orderId: string,
  formData: FormData,
): Promise<RefundActionResult> {
  if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 64) {
    return { ok: false, error: "订单参数不正确" }
  }

  const user = await getCurrentUser()
  if (!user) return { ok: false, error: "登录状态已失效，请重新登录" }

  // 校验走 lib/schemas.ts —— 那里定义了规则，这里只负责把 FormData 拆开。
  // 前端的下拉框和 maxLength 都只是体验，服务端这一遍才是防线
  const parsed = refundRequestSchema.safeParse({
    reason: formData.get("reason"),
    // 补充说明选填：表单没带这个字段时 get() 返回 null，
    // 补个空串让它走「空 → null」那条正常路径，而不是当成校验失败
    description: String(formData.get("description") ?? ""),
  })

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "退款信息不合法",
    }
  }

  const result = await requestRefund({
    orderId,
    // 注意这里传的是**服务端认出来的** user.id，不是表单里的任何东西
    userId: user.id,
    reason: parsed.data.reason,
    description: parsed.data.description,
  })

  if (!result.ok) return { ok: false, error: result.error }

  // 订单详情的状态徽章要变成「退款处理中」，按钮要消失；
  // 后台的退款列表要多出一条待处理
  revalidatePath(`/orders/${orderId}`)
  revalidatePath("/orders")
  revalidatePath("/admin/refunds")

  return { ok: true, refundAmount: result.refundAmount }
}

/**
 * 管理员批准退款。
 *
 * 【三个参数分别防什么】
 *   refundId   —— 定位符，可能是别人的单，靠 requireAdmin 拦
 *   adminNote  —— 批准时的备注，选填，空串统一成 null
 *   （金额不在这里）—— 由 approveRefund 从订单上读，客户端说了不算
 *
 * 【为什么失败时要把详情页也 revalidate 一遍】
 * 最常见的失败原因是「这条已经被另一个管理员处理过了」——
 * 这时候页面上的内容已经过时了，刷新一下能让他看到最新状态，
 * 而不是对着一个还在显示「批准」按钮的页面反复点。
 */
export async function approveRefundAction(
  refundId: string,
): Promise<RefundActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (
    typeof refundId !== "string" ||
    refundId.length === 0 ||
    refundId.length > 64
  ) {
    return { ok: false, error: "退款单参数不正确" }
  }

  const result = await approveRefund(refundId, null)

  if (result.ok) {
    console.log(
      `[admin] ${auth.user.email} 批准退款 ${refundId}，金额 ${result.refundAmount} 分`,
    )
  }

  revalidateRefundViews(refundId)
  return result.ok
    ? { ok: true, refundAmount: result.refundAmount }
    : { ok: false, error: result.error }
}

/**
 * 管理员拒绝退款。**必须填理由。**
 *
 * 【为什么拒绝要理由，批准不用】
 * 批准是一个「什么都不用解释」的动作 —— 用户看到「已退款」就知道结果了。
 * 拒绝不是：用户看到的只是一个「不行」，他下一步该干什么（重新申请？
 * 联系客服？还是就这么算了）完全取决于为什么不行。
 * 所以理由在这里是**功能的一部分**，不是客气话，校验层直接卡住空值。
 */
export async function rejectRefundAction(
  refundId: string,
  formData: FormData,
): Promise<RefundActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  if (
    typeof refundId !== "string" ||
    refundId.length === 0 ||
    refundId.length > 64
  ) {
    return { ok: false, error: "退款单参数不正确" }
  }

  const parsed = refundRejectionSchema.safeParse({
    adminNote: formData.get("adminNote"),
  })

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "请填写拒绝理由",
    }
  }

  const result = await rejectRefund(refundId, parsed.data.adminNote)

  if (result.ok) {
    console.log(`[admin] ${auth.user.email} 拒绝退款 ${refundId}`)
  }

  revalidateRefundViews(refundId)
  return result.ok
    ? { ok: true, refundAmount: result.refundAmount }
    : { ok: false, error: result.error }
}

/**
 * 退款会牵动的一串页面。
 *
 * 【为什么要抽一个函数】
 * 批准和拒绝影响的页面完全一样：后台退款列表、退款详情、那一单的
 * 买家详情页和后台详情页。抄两遍的话，将来加了「退款后发通知」
 * 之类的东西一定会漏掉一处 —— 而漏掉的表现是「刷新一下才对」，
 * 属于最难被当成 bug 报告的那类问题。
 *
 * 【买家详情页的路径怎么来的】
 * 这里拿不到 orderId（只有 refundId），所以干脆整个 /orders 子树一起刷。
 * 对一个练手项目来说这点开销可以忽略，换来的是「不可能漏刷某一单」。
 * 真要优化的话得先按 refundId 查出 orderId，多一次查询、多一个
 * 可能失败的点，收益却只是省掉几次渲染。
 */
function revalidateRefundViews(refundId: string) {
  revalidatePath("/admin/refunds")
  revalidatePath(`/admin/refunds/${refundId}`)
  revalidatePath("/admin/orders")
  revalidatePath("/orders", "layout")
}
