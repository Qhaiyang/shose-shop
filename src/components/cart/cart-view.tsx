"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2, Minus, Plus, ShoppingCart, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  refreshCartItemsAction,
  removeCartItemAction,
  updateCartQuantityAction,
} from "@/app/actions/cart"
import { Button, buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { formatPrice } from "@/lib/format"
import { useCartStore } from "@/lib/cart-store"
import {
  cartCount,
  cartSubtotal,
  findStockProblems,
  type CartItemView,
} from "@/lib/cart-types"

// ============================================================================
// 购物车视图（客户端）
//
// 【两套数据源，一个视图】
//   已登录 → 数据来自数据库，由服务端页面查好当 props 传进来（initialDbItems）。
//            任何修改都调 Server Action，然后 router.refresh() 让服务端重查。
//   未登录 → 数据来自 zustand（localStorage），修改直接改本地 state。
//
// 这个组件是唯一需要同时理解两套逻辑的地方。判断依据就一个 isLoggedIn。
// ============================================================================

/** 单次最多购买件数，与 SKU 选择器保持一致 */
const MAX_QUANTITY_PER_ORDER = 10

type CartViewProps = {
  isLoggedIn: boolean
  /** 已登录时由服务端查好的数据库购物车；未登录传空数组 */
  initialDbItems: CartItemView[]
}

export function CartView({ isLoggedIn, initialDbItems }: CartViewProps) {
  const localItems = useCartStore((state) => state.items)
  const hydrated = useCartStore((state) => state.hydrated)

  // 只需要 startTransition；「哪一行在 loading」由下面的 pendingSkuId 负责，
  // 因为 useTransition 的 isPending 是全局的，会让所有行一起转圈
  const [, startTransition] = useTransition()
  const router = useRouter()

  // 记录正在被操作的 skuId，用于给单行显示 loading
  const [pendingSkuId, setPendingSkuId] = useState<string | null>(null)

  // 未登录时在客户端刷新过价格的标记 —— 用 ref 而不是 state，
  // 因为刷新完会写回 store，用 state 会造成 effect 反复触发
  const refreshedRef = useRef(false)

  // ---- 未登录：进页面时刷新一次价格和库存 ----
  useEffect(() => {
    if (isLoggedIn || !hydrated || refreshedRef.current) return

    const ids = localItems.map((item) => item.skuId)
    if (ids.length === 0) return

    refreshedRef.current = true

    void (async () => {
      try {
        const fresh = await refreshCartItemsAction(ids)
        const byId = new Map(fresh.map((item) => [item.skuId, item]))

        // 用服务端的最新价格/库存覆盖本地快照，但【保留用户设的数量】
        const updated = localItems.map((item) => {
          const latest = byId.get(item.skuId)
          // 查不到说明这个 SKU 已被后台删除，标记成 0 库存让用户看到提示
          if (!latest) return { ...item, stock: 0 }

          return {
            ...item,
            price: latest.price,
            stock: latest.stock,
            productName: latest.productName,
            image: latest.image,
          }
        })

        useCartStore.getState().replaceAll(updated)
      } catch (error) {
        console.error("[cart] 刷新购物车失败:", error)
      }
    })()
    // 依赖里故意不放 localItems：只在「水合完成后」跑一次，
    // 否则 replaceAll 会让这个 effect 无限循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, hydrated])

  // ---- 决定数据源 ----
  const items = isLoggedIn ? initialDbItems : localItems
  // 未登录且还没水合完 → 先不渲染内容，避免服务端(空)和客户端(有货)对不上
  const notReady = !isLoggedIn && !hydrated

  // ---- 操作分发：已登录走服务端，未登录改本地 ----

  function changeQuantity(skuId: string, quantity: number) {
    if (isLoggedIn) {
      setPendingSkuId(skuId)
      startTransition(async () => {
        const result = await updateCartQuantityAction(skuId, quantity)
        if (!result.ok) toast.error("修改数量失败", { description: result.error })
        else router.refresh()
        setPendingSkuId(null)
      })
      return
    }

    useCartStore.getState().setQuantity(skuId, quantity)
  }

  function removeItem(skuId: string, name: string) {
    if (isLoggedIn) {
      setPendingSkuId(skuId)
      startTransition(async () => {
        const result = await removeCartItemAction(skuId)
        if (!result.ok) toast.error("删除失败", { description: result.error })
        else {
          toast.success("已移出购物车", { description: name })
          router.refresh()
        }
        setPendingSkuId(null)
      })
      return
    }

    useCartStore.getState().removeItem(skuId)
    toast.success("已移出购物车", { description: name })
  }

  // ---- 渲染 ----

  if (notReady) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (items.length === 0) {
    return <EmptyCart />
  }

  const subtotal = cartSubtotal(items)
  const count = cartCount(items)

  // 有商品缺货或数量超库存时不让结算 —— 服务端那条 UPDATE ... WHERE stock >= ?
  // 也会拦住，这里只是省得用户白填一遍收货信息。
  // 用和结算页同一个纯函数判断，两边不会写岔（见 cart-types.ts 的 findStockProblems）
  const problemSkuIds = new Set(findStockProblems(items).map((p) => p.skuId))
  const hasStockIssue = problemSkuIds.size > 0

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_20rem]">
      {/* ==================== 商品列表 ==================== */}
      <div className="divide-y rounded-xl border">
        {items.map((item) => {
          const rowPending = pendingSkuId === item.skuId
          // 库存不足：用户加购后库存被别处买走了
          const outOfStock = item.stock === 0
          const overStock = item.quantity > item.stock && item.stock > 0
          const hasProblem = problemSkuIds.has(item.skuId)
          const max = Math.max(1, Math.min(item.stock, MAX_QUANTITY_PER_ORDER))

          return (
            <div
              key={item.skuId}
              className={cn(
                "flex gap-4 p-4",
                rowPending && "opacity-60",
                // 库存不足的整行标红：光靠一行小字，用户会漏看
                hasProblem && "bg-destructive/5 ring-1 ring-inset ring-destructive/30",
              )}
            >
              {/* 图 */}
              <Link
                href={`/products/${item.productId}`}
                className="shrink-0 overflow-hidden rounded-lg border bg-muted"
              >
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 本地 SVG，见 product-card.tsx 的说明
                  <img
                    src={item.image}
                    alt={item.productName}
                    className="size-24 object-cover"
                  />
                ) : (
                  <div className="flex size-24 items-center justify-center text-xs text-muted-foreground">
                    无图
                  </div>
                )}
              </Link>

              {/* 信息 */}
              <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
                <div className="space-y-1">
                  <Link
                    href={`/products/${item.productId}`}
                    className="line-clamp-1 font-medium hover:text-primary"
                  >
                    {item.productName}
                  </Link>

                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>
                      {item.color} / {item.size} 码
                    </span>
                    <span className="text-xs">{item.skuCode}</span>
                  </div>

                  {outOfStock && (
                    <p className="text-sm font-medium text-destructive">
                      该规格已售罄，请移除后再结算
                    </p>
                  )}
                  {overStock && (
                    <p className="text-sm font-medium text-destructive">
                      仅剩 {item.stock} 件，请调整数量
                    </p>
                  )}
                  {!outOfStock && !overStock && item.stock < 5 && (
                    <p className="text-sm text-amber-600">
                      仅剩 {item.stock} 件
                    </p>
                  )}
                </div>

                {/* 数量 + 删除 */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7"
                      disabled={item.quantity <= 1 || rowPending}
                      onClick={() =>
                        changeQuantity(item.skuId, item.quantity - 1)
                      }
                    >
                      <Minus className="size-3" />
                      <span className="sr-only">减少数量</span>
                    </Button>

                    <span className="w-10 text-center text-sm tabular-nums">
                      {rowPending ? (
                        <Loader2 className="mx-auto size-3.5 animate-spin" />
                      ) : (
                        item.quantity
                      )}
                    </span>

                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7"
                      disabled={item.quantity >= max || rowPending}
                      onClick={() =>
                        changeQuantity(item.skuId, item.quantity + 1)
                      }
                    >
                      <Plus className="size-3" />
                      <span className="sr-only">增加数量</span>
                    </Button>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={rowPending}
                    onClick={() => removeItem(item.skuId, item.productName)}
                  >
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                </div>
              </div>

              {/* 小计 */}
              <div className="shrink-0 text-right">
                <div className="font-semibold">
                  {formatPrice(item.price * item.quantity)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatPrice(item.price)} / 件
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ==================== 结算栏 ==================== */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="space-y-4 rounded-xl border p-5">
          <h2 className="font-semibold">订单摘要</h2>

          <Separator />

          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">商品件数</span>
            <span className="tabular-nums">{count} 件</span>
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">商品金额</span>
            <span className="tabular-nums">{formatPrice(subtotal)}</span>
          </div>

          <Separator />

          <div className="flex items-baseline justify-between">
            <span className="font-medium">合计</span>
            <span className="text-2xl font-bold text-primary">
              {formatPrice(subtotal)}
            </span>
          </div>

          {/*
            【未登录为什么不直接跳 /checkout】
            登录后本地购物车是「异步」合并进数据库的（CartSync 在 useEffect 里做）。
            直接跳结算页的话，很可能合并还没跑完，结算页查到空购物车就把人弹回来了。
            所以先回购物车 —— 那里能看到合并结果，再点一次去结算。
          */}
          {!isLoggedIn ? (
            <Link
              href="/login?next=/cart"
              className={cn(buttonVariants({ size: "lg" }), "w-full")}
            >
              登录后结算
            </Link>
          ) : hasStockIssue ? (
            <Button size="lg" className="w-full" disabled>
              请先调整上方缺货商品
            </Button>
          ) : (
            <Link
              href="/checkout"
              className={cn(buttonVariants({ size: "lg" }), "w-full")}
            >
              去结算
            </Link>
          )}

          <p className="text-center text-xs text-muted-foreground">
            提交订单时会锁定库存，15 分钟内未支付自动取消
          </p>
        </div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 空购物车
// ---------------------------------------------------------------------------
function EmptyCart() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed py-24 text-center">
      <ShoppingCart className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-medium">购物车还是空的</p>
        <p className="text-sm text-muted-foreground">
          挑几双鞋放进来吧
        </p>
      </div>
      <Link href="/products" className={cn(buttonVariants(), "mt-2")}>
        去逛逛
      </Link>
    </div>
  )
}
