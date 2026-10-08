"use server"

import { revalidatePath } from "next/cache"

import { getCurrentUser } from "@/lib/auth"
import { parseImageLines } from "@/lib/form"
import { parseRating } from "@/lib/reviews"
import { createReview } from "@/lib/reviews-db"
import { reviewSchema } from "@/lib/schemas"

// ============================================================================
// 提交评价 Server Action
//
// 【这个 action 只做四件事，一行业务规则都不写】
//   1. 从 cookie 认人
//   2. 把 FormData 里的原始字符串解析成有类型的值（星级 / 图片行）
//   3. 用 reviewSchema 校验
//   4. 交给 createReview
//
// 「只有买过的人能评」「订单必须已完成」「一件商品只能评一次」这些规则
// **不在这里**，在 src/lib/reviews-db.ts 的 createReview 里 ——
// 那里能直接查数据库拿到当前状态。action 层只负责鉴权 + 编排，
// 规则越靠近数据，越不容易被绕过。这是整个项目一贯的分法。
//
// 【为什么不用 useActionState】
// 提交评价没有「保留用户填过的内容」的需求（成功就关上表单了），
// 失败也就是一句提示。所以它和支付、确认收货一样：收普通参数、
// 返回普通结果对象，由客户端组件用 useTransition 调。
// 用 useActionState 反而要多一套 FormState 类型和一个「提交过了没有」
// 的状态判断，纯属负担。
// ============================================================================

export type ReviewActionResult =
  | { ok: true; productId: string }
  | { ok: false; error: string }

export async function createReviewAction(
  formData: FormData,
): Promise<ReviewActionResult> {
  // 照例从 cookie 认人，绝不接受客户端传 userId
  const user = await getCurrentUser()
  if (!user) {
    return { ok: false, error: "登录状态已失效，请重新登录" }
  }

  const orderItemId = String(formData.get("orderItemId") ?? "")
  if (orderItemId.length === 0 || orderItemId.length > 64) {
    return { ok: false, error: "订单参数不正确" }
  }

  // 星级是按钮选出来的，表单里是一个 <input type="hidden">
  const parsed = reviewSchema.safeParse({
    // parseRating 拿不准时返回 null，转成 undefined 让 zod 报「请先选择星级」
    rating: parseRating(formData.get("rating")) ?? undefined,
    // formData.get 可能返回 null（字段整个没提交），
    // 兜成空串交给 zod 的 .trim().min() 去报错，比在类型上纠结清楚
    content: String(formData.get("content") ?? ""),
    // 和后台商品表单共用同一个「一行一个路径」的解析。
    // 这里没有做真实上传 —— 学习项目不引入对象存储，
    // 图片就以路径/链接的形式填写，详见 README 里的说明
    images: parseImageLines(formData.get("images")),
  })

  if (!parsed.success) {
    // 一次只弹一句提示，取第一条就够了。表单里字段少，
    // 没必要把每条错误都摆出来
    return { ok: false, error: parsed.error.issues[0]?.message ?? "评价内容不正确" }
  }

  const result = await createReview(orderItemId, user.id, parsed.data)

  if (!result.ok) return result

  console.log(`[review] ${user.email} 评价了商品 ${result.productId}`)

  // 商品详情页的评价区要多显示一条、评分要重算
  revalidatePath(`/products/${result.productId}`)
  revalidatePath("/products")
  // 后台评价列表也要跟着变。这一条不是必须的 —— 用户手上的页面
  // 靠客户端 router.refresh() 已经刷新了，但管理员那边可能同时开着
  // /admin/reviews，作废一下缓存代价几乎为零
  revalidatePath("/admin/reviews")

  return { ok: true, productId: result.productId }
}
