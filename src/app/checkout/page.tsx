import Link from "next/link"
import { redirect } from "next/navigation"
import { AlertTriangle } from "lucide-react"

import { CheckoutCoupon } from "@/components/checkout/checkout-coupon"
import { CheckoutForm } from "@/components/checkout/checkout-form"
import { Separator } from "@/components/ui/separator"
import { getCurrentUser } from "@/lib/auth"
import { getDbCartItems } from "@/lib/cart"
import { findStockProblems } from "@/lib/cart-types"
import { getUsableCoupons } from "@/lib/coupons-db"
import { formatPrice } from "@/lib/format"
import { cn } from "@/lib/utils"

// 读 cookie + 查购物车，必须是动态页面，否则会把某个用户的购物车烤进构建产物
export const dynamic = "force-dynamic"

export const metadata = {
  title: "确认订单 | 鞋店",
}

export default async function CheckoutPage() {
  const user = await getCurrentUser()

  // 未登录先去登录，登录后自动跳回结算页。
  // 注意这里跳回 /checkout 是安全的：CartSync 会在登录后把本地购物车
  // 合并进数据库，如果合并还没跑完，下面的「购物车为空」会把用户送回 /cart，
  // 不会出现「钱收了但东西没了」。
  if (!user) redirect("/login?next=/checkout")

  const items = await getDbCartItems(user.id)

  // 空购物车没什么可结算的
  if (items.length === 0) redirect("/cart")

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0)

  // 这笔订单能用的券 —— 把「商品原价合计」传进去，门槛不够的、过期的、
  // 停用的、已经用掉的那几种在 getUsableCoupons 里就被筛掉了。
  // 页面拿到的每一张都是真的能用的，各自的优惠金额也算好了
  const usableCoupons = await getUsableCoupons(user.id, total)

  // 展示层面的「够不够卖」提醒。真正拦下来的是服务端那条
  // UPDATE ... WHERE stock >= ?，这里只是让用户少走一趟冤枉路。
  // 和购物车页共用 findStockProblems，判断口径一致
  const problems = findStockProblems(items)
  const problemSkuIds = new Set(problems.map((p) => p.skuId))

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">确认订单</h1>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_22rem]">
        {/* ---------------- 左：收货信息 ---------------- */}
        <div className="space-y-6">
          {problems.length > 0 && (
            <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">有商品库存发生变化，可能无法下单：</p>
                <ul className="mt-1 list-inside list-disc">
                  {problems.map((problem) => {
                    const item = items.find((i) => i.skuId === problem.skuId)
                    if (!item) return null
                    return (
                      <li key={problem.skuId}>
                        {item.productName} {item.color}/{item.size}码 —— 现有库存{" "}
                        {problem.stock} 件，你要 {problem.quantity} 件
                      </li>
                    )
                  })}
                </ul>
                <Link href="/cart" className="mt-1 inline-block underline">
                  回购物车调整数量
                </Link>
              </div>
            </div>
          )}

          <div className="rounded-xl border p-5">
            <h2 className="mb-4 font-semibold">收货信息</h2>
            <CheckoutForm />
          </div>
        </div>

        {/* ---------------- 右：订单摘要 ---------------- */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="space-y-4 rounded-xl border p-5">
            <h2 className="font-semibold">订单摘要</h2>

            <Separator />

            <ul className="space-y-3">
              {items.map((item) => (
                <li
                  key={item.skuId}
                  className={cn(
                    "flex gap-3 rounded-lg",
                    problemSkuIds.has(item.skuId) &&
                      "bg-destructive/5 p-2 ring-1 ring-inset ring-destructive/30",
                  )}
                >
                  <div className="size-14 shrink-0 overflow-hidden rounded-lg border bg-muted">
                    {item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- 本地图片，见 product-card.tsx 的说明
                      <img
                        src={item.image}
                        alt={item.productName}
                        className="size-full object-cover"
                      />
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm font-medium">
                      {item.productName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.color} / {item.size}码 × {item.quantity}
                    </p>
                  </div>

                  <div className="shrink-0 text-sm tabular-nums">
                    {formatPrice(item.price * item.quantity)}
                  </div>
                </li>
              ))}
            </ul>

            <Separator />

            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">商品件数</span>
              <span className="tabular-nums">
                {items.reduce((sum, i) => sum + i.quantity, 0)} 件
              </span>
            </div>

            {/*
              【金额为什么交给客户端组件去渲染】
              因为「优惠 / 实付」这两行会随用户选哪张券实时变。
              服务端渲染的是「一开始的金额」（不选券 = 商品总额），
              选券之后要由浏览器立刻算出新数 —— 这才叫实时，
              否则用户点一下券还要等一个来回才知道省了多少。

              这里的 itemsTotal 传的是原价合计，不含任何优惠：
              minSpend 比的也是它。这点和 Order 表里的口径一致
              （见 schema 里 totalAmount 的注释）
            */}
            <CheckoutCoupon coupons={usableCoupons} itemsTotal={total} />
          </div>
        </aside>
      </div>
    </div>
  )
}
