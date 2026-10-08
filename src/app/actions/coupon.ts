"use server"

import { revalidatePath } from "next/cache"

import { getCurrentUser } from "@/lib/auth"
import { claimCoupon, type ClaimResult } from "@/lib/coupons-db"

// ============================================================================
// 优惠券 Server Action
//
// 【只有「领券」这一个写操作，用券/退券都不在这里】
// 用券发生在下单事务内部（src/lib/orders.ts），退券发生在取消订单的
// 事务内部 —— 它们必须和扣库存、改订单状态同生共死，不能单独暴露成
// 一个可以被 POST 直接打的接口。领券不一样：它只往 user_coupons 里
// 插一行，不影响任何别的数据，所以它自己就是一个完整的操作。
//
// 【安全前提和别的 action 一样】
// Server Action 编译后就是一个可以被任意 POST 直接打的接口：
//   ✗ 不接受客户端传 userId
//   ✓ 自己从 cookie 里解析（getCurrentUser）
// 这里的「资源 id」（couponId）可以来自客户端 —— 因为「领哪张券」
// 本来就该由用户决定做，而「能领几张」是服务端用 perUserLimit 判的。
// 换句话说：用户可以选券，但选不了自己是谁、也改不了限领张数。
// ============================================================================

/**
 * 领取一张优惠券。
 *
 * 【为什么参数是 couponId 而不是券码】
 * 券码是给人在线下念的（做活动的场景），页面上每一张券都已经带着 id 了，
 * 让用户从页面上「抄一遍券码再提交」纯属多余。将来真要做「输入券码兑换」，
 * 那是另一个入口（按码查一次 → 拿到 id → 调同一个 claimCoupon），
 * 不需要改这个函数。
 */
export async function claimCouponAction(couponId: string): Promise<ClaimResult> {
  const user = await getCurrentUser()
  if (!user) return { ok: false, error: "请先登录" }

  // 参数来自网络，先收窄长度再进查询 —— 和 setFavoriteAction 同一个理由：
  // 不是要精确校验 id 的格式，只是别让几 MB 的字符串进到 SQL 里
  if (typeof couponId !== "string" || couponId.length === 0 || couponId.length > 64) {
    return { ok: false, error: "参数不合法" }
  }

  const result = await claimCoupon(user.id, couponId)
  if (!result.ok) return result

  // 【为什么要 revalidate 三个页面】
  // 领到券之后，这三个地方的界面都变了：
  //   /my-coupons —— 多了一张「未使用」的券（这是给用户看的「我领到了」的证据）
  //   /checkout   —— 可用券列表里多一项（可能用户领完就直接去结算了）
  //   /cart       —— 购物车底部也有一份领券入口，上面「已领 X 张」的角标要更新
  // /products 用 layout 粒度整棵子树失效：商品详情页的领取入口在
  // **动态路由**里，而这里拿不到商品 id（领券这件事和商品无关），
  // 与其让调用方多传一个 id 上来（那个 id 同样不可信），不如整段失效。
  // 这些页面都是 dynamic 渲染，实际代价是「下次请求重查一遍」而不是「重新构建」
  revalidatePath("/my-coupons")
  revalidatePath("/checkout")
  revalidatePath("/cart")
  revalidatePath("/products", "layout")

  return result
}
