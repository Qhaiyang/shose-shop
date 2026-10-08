"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Minus, Plus, ShoppingCart } from "lucide-react"
import { toast } from "sonner"

import { addToCartAction } from "@/app/actions/cart"
import { getSkuAvailabilityAction } from "@/app/actions/product"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { formatPrice } from "@/lib/format"
import { useCartStore } from "@/lib/cart-store"
import type { ColorGroup } from "@/lib/products"

// ============================================================================
// SKU 选择器
//
// 【为什么必须是 Client Component】
// 它持有「当前选中哪个颜色/尺码」的交互状态，而 Server Component 不能有
// useState。所以这一块从服务端渲染的页面里切出来，单独做成客户端组件，
// 由页面把数据（colors）作为 props 传进来。
//
// 【数据流是单向的】
//   页面(Server) 查数据库 → 传 colors 给选择器(Client) → 选择器只管交互
// 选择器不做任何数据请求。所以它拿到的是「页面加载那一刻」的库存快照，
// 真正的库存校验在第 6 步下单时于服务端再查一次 —— 前端置灰只是体验优化，
// 不是安全边界。
// ============================================================================

/** 低于这个库存量就提示「仅剩 N 件」 */
const LOW_STOCK_THRESHOLD = 5

/** 单次最多购买件数（防止有人一次性买空库存） */
const MAX_QUANTITY_PER_ORDER = 10

type SkuSelectorProps = {
  colors: ColorGroup[]
  /** 下面三个用于生成本地购物车的商品快照（见 cart-types.ts 的说明） */
  productId: string
  productName: string
  image: string | null
  /** 是否已登录。已登录走数据库购物车，未登录走 localStorage */
  isLoggedIn: boolean
}

export function SkuSelector({
  colors,
  productId,
  productName,
  image,
  isLoggedIn,
}: SkuSelectorProps) {
  // 两个维度都没选时是 null —— 用 null 而不是空字符串，语义更明确
  const [selectedColor, setSelectedColor] = useState<string | null>(null)
  const [selectedSize, setSelectedSize] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)

  // 服务端写入（已登录用户）是异步的，用 transition 让按钮显示 loading 且不卡界面
  const [isPending, startTransition] = useTransition()
  const addItem = useCartStore((state) => state.addItem)
  const router = useRouter()

  // ---- 派生状态：不需要额外 useState，每次渲染时算出来即可 ----
  // 用 useMemo 是为了避免每次输入都重新遍历（这里数据量小，其实无所谓，
  // 但养成习惯：派生值不要存进 state，否则两边容易不同步）
  const activeColor = useMemo(
    () => colors.find((c) => c.color === selectedColor) ?? null,
    [colors, selectedColor],
  )

  const currentSku = useMemo(
    () => activeColor?.sizes.find((s) => s.size === selectedSize) ?? null,
    [activeColor, selectedSize],
  )

  // ---- 实时库存 ----
  // 【为什么页面上已经传了 colors（带库存），还要再查一次】
  // colors 是「页面加载那一刻」的快照。从加载到用户点下颜色尺码之间，
  // 别的买家可能已经下单把库存买走了。所以每次选中一个新规格，就调
  // Server Action 拿此刻的最新库存，用 liveSku 覆盖快照里的 stock/price。
  // 快照只负责「按钮长什么样、哪些规格可点」，真正的库存数字以这次为准。
  //
  // liveSku 里存着 skuId，是为了「换规格后旧数据自动失效」：
  // 旧规格查回来的结果还在 state 里，但 id 对不上当前规格，就会被忽略。
  // 这样就不用再写一个「清空」动作（也避开了在 effect 里同步 setState）。
  const [liveSku, setLiveSku] = useState<{
    skuId: string
    stock: number
    price: number
  } | null>(null)

  useEffect(() => {
    if (!currentSku) return

    let cancelled = false

    void (async () => {
      const result = await getSkuAvailabilityAction(currentSku.id)
      if (!cancelled && result.ok) {
        setLiveSku({
          skuId: currentSku.id,
          stock: result.stock,
          price: result.price,
        })
        // 实时库存比快照少的话，把已选数量也压下来，
        // 否则会出现「显示 ×5、实际只能买 3」的对不上
        const cap = Math.max(1, Math.min(result.stock, MAX_QUANTITY_PER_ORDER))
        setQuantity((q) => Math.min(q, cap))
      }
    })()

    return () => {
      cancelled = true
    }
    // 依赖是 id 而不是整个 currentSku 对象 —— 对象每次渲染都是新的，
    // 用它当依赖会导致这个 effect 在每次按键（改数量）时都重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSku?.id])

  // 生效的库存/价格：优先用实时查回来的（且 id 对得上），还没回来时用快照兜底
  const live = liveSku?.skuId === currentSku?.id ? liveSku : null
  const effectiveStock = live?.stock ?? currentSku?.stock ?? 0
  const effectivePrice = live?.price ?? currentSku?.price ?? 0

  /** 当前 SKU 的可购上限 */
  const maxQuantity = currentSku
    ? Math.min(effectiveStock, MAX_QUANTITY_PER_ORDER)
    : 1

  // ---- 事件处理 ----

  function handleSelectColor(color: string) {
    setSelectedColor(color)
    setQuantity(1)

    // 换颜色后，如果新颜色下当前选中的尺码不可买（不存在或没库存），
    // 就把尺码选择清掉，避免出现「显示着 42 码但那个 42 码不是这个颜色的」
    const group = colors.find((c) => c.color === color)
    const stillAvailable = group?.sizes.some(
      (s) => s.size === selectedSize && s.stock > 0,
    )
    if (!stillAvailable) {
      setSelectedSize(null)
    }
  }

  function handleSelectSize(size: string) {
    setSelectedSize(size)
    setQuantity(1)
  }

  function handleAddToCart() {
    if (!currentSku || effectiveStock === 0) return

    // 快照字段：加购时把商品信息一起存下来，购物车页面就能直接渲染，
    // 不用等一次网络往返（详见 cart-types.ts 的注释）
    const snapshot = {
      skuId: currentSku.id,
      skuCode: currentSku.skuCode,
      productId,
      productName,
      size: currentSku.size,
      color: currentSku.color,
      price: effectivePrice,
      image,
      stock: effectiveStock,
    }

    const description = `${currentSku.color} / ${currentSku.size} 码 × ${quantity}`

    // ---- 已登录：写到数据库 ----
    if (isLoggedIn) {
      startTransition(async () => {
        const result = await addToCartAction(currentSku.id, quantity)

        if (!result.ok) {
          toast.error("加入购物车失败", { description: result.error })
          return
        }

        toast.success("已加入购物车", { description })
        // 让顶部的购物车角标刷新（它读的是服务端数据）
        router.refresh()
      })
      return
    }

    // ---- 未登录：写到 localStorage ----
    addItem(snapshot, quantity)
    toast.success("已加入购物车", { description })
  }

  const canAddToCart = Boolean(currentSku && effectiveStock > 0)

  return (
    <div className="space-y-6">
      {/* ================= 价格与库存 ================= */}
      <div className="min-h-[4.5rem] rounded-lg bg-muted/50 p-4">
        {currentSku ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight">
                {formatPrice(effectivePrice)}
              </span>
              <span className="text-sm text-muted-foreground">
                {currentSku.skuCode}
              </span>
            </div>

            <div className="flex items-center gap-2 text-sm">
              {effectiveStock === 0 ? (
                <span className="font-medium text-destructive">该规格已售罄</span>
              ) : effectiveStock < LOW_STOCK_THRESHOLD ? (
                // 库存紧张：用醒目颜色催单，这是真实电商常见的转化手段
                <span className="font-medium text-amber-600">
                  仅剩 {effectiveStock} 件
                </span>
              ) : (
                <span className="text-muted-foreground">
                  库存 {effectiveStock} 件
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-[3.5rem] items-center text-sm text-muted-foreground">
            请选择颜色和尺码以查看价格与库存
          </div>
        )}
      </div>

      {/* ================= 颜色 ================= */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">颜色</span>
          {selectedColor && (
            <span className="text-sm text-muted-foreground">{selectedColor}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {colors.map((c) => {
            const disabled = c.totalStock === 0
            const selected = c.color === selectedColor

            return (
              <Button
                key={c.color}
                type="button"
                variant={selected ? "default" : "outline"}
                size="sm"
                disabled={disabled}
                onClick={() => handleSelectColor(c.color)}
                className={cn(
                  "min-w-20",
                  disabled && "line-through opacity-50",
                )}
              >
                {c.color}
              </Button>
            )
          })}
        </div>
      </div>

      {/* ================= 尺码 ================= */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">尺码</span>
          {selectedSize && (
            <span className="text-sm text-muted-foreground">
              {selectedSize} 码
            </span>
          )}
        </div>

        {activeColor ? (
          <div className="flex flex-wrap gap-2">
            {activeColor.sizes.map((s) => {
              // 关键规则：没库存的规格置灰不可选
              const disabled = s.stock === 0
              const selected = s.size === selectedSize

              return (
                <Button
                  key={s.id}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  size="sm"
                  disabled={disabled}
                  onClick={() => handleSelectSize(s.size)}
                  title={disabled ? "该尺码已售罄" : `库存 ${s.stock} 件`}
                  className={cn(
                    "min-w-14",
                    disabled && "line-through opacity-40",
                  )}
                >
                  {s.size}
                </Button>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">请先选择颜色</p>
        )}
      </div>

      <Separator />

      {/* ================= 数量 + 加购 ================= */}
      <div className="space-y-4">
        {currentSku && effectiveStock > 0 && (
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium">数量</span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                disabled={quantity <= 1}
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                <Minus className="size-3.5" />
                <span className="sr-only">减少数量</span>
              </Button>

              <span className="w-12 text-center text-sm tabular-nums">
                {quantity}
              </span>

              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                disabled={quantity >= maxQuantity}
                onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
              >
                <Plus className="size-3.5" />
                <span className="sr-only">增加数量</span>
              </Button>
            </div>

            {maxQuantity < effectiveStock && (
              <span className="text-xs text-muted-foreground">
                单次最多 {maxQuantity} 件
              </span>
            )}
          </div>
        )}

        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={!canAddToCart || isPending}
          onClick={handleAddToCart}
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ShoppingCart className="size-4" />
          )}
          {currentSku && effectiveStock === 0 ? "已售罄" : "加入购物车"}
        </Button>

        {!currentSku && (
          <p className="text-center text-xs text-muted-foreground">
            请先选择颜色和尺码
          </p>
        )}
      </div>

      {/* 顺手把总数汇总展示，方便核对 */}
      {currentSku && effectiveStock > 0 && (
        <div className="flex items-center justify-between rounded-lg border p-3 text-sm">
          <span className="text-muted-foreground">合计</span>
          <Badge variant="secondary" className="text-sm font-semibold">
            {formatPrice(effectivePrice * quantity)}
          </Badge>
        </div>
      )}
    </div>
  )
}
