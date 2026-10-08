import type { Metadata } from "next"

import { CartView } from "@/components/cart/cart-view"
import { CouponClaimList } from "@/components/coupon/coupon-claim-list"
import { getCurrentUser } from "@/lib/auth"
import { getDbCartItems } from "@/lib/cart"
import { getClaimableCoupons } from "@/lib/coupons-db"

// ============================================================================
// 购物车页 —— Server Component
//
// 服务端只做一件事：如果用户已登录，把数据库里的购物车查出来当 props 传下去。
// 未登录用户的数据在浏览器 localStorage 里，服务端读不到，所以传空数组，
// 由 <CartView /> 在客户端自己从 store 取。
// ============================================================================

export const metadata: Metadata = {
  title: "购物车 | 鞋店",
}

export const dynamic = "force-dynamic"

export default async function CartPage() {
  const user = await getCurrentUser()

  // 两个查询互不依赖，并行发出去（getClaimableCoupons 未登录时传 null 也能查）
  const [dbItems, claimableCoupons] = await Promise.all([
    user ? getDbCartItems(user.id) : Promise.resolve([]),
    getClaimableCoupons(user?.id ?? null),
  ])

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-8 space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">购物车</h1>
        <p className="text-muted-foreground">
          {user
            ? `已登录为 ${user.name}，购物车保存在你的账号里`
            : "当前未登录，购物车暂存在这台设备上，登录后会自动合并到账号"}
        </p>
      </header>

      <CartView isLoggedIn={user !== null} initialDbItems={dbItems} />

      {/*
        领券入口放在购物车**下面**。
        【为什么不塞进 CartView 里面（比如结算按钮上方）】
        那个组件是客户端的，内部有「已登录查库 / 未登录读 localStorage」
        两套数据源，服务端组件插不进去 —— 硬插得把券的数据也传进那个
        组件，等于让它再理解一套逻辑。
        放这儿的效果也说得通：用户先核对商品、再看有什么券可领。
        真到了「用哪张券」这一步，是结算页那一栏的事
      */}
      <div className="mt-8">
        <CouponClaimList
          coupons={claimableCoupons}
          isLoggedIn={user !== null}
          nextPath="/cart"
          description="领到手之后，结算时按订单金额挑一张用"
        />
      </div>
    </div>
  )
}
