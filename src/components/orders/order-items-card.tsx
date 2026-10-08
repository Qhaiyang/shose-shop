import { Separator } from "@/components/ui/separator"
import { couponLabel, type CouponRule } from "@/lib/coupons"
import { formatPrice } from "@/lib/format"
import type { OrderItemView } from "@/lib/orders"

// ============================================================================
// 订单商品清单（服务端组件）
//
// 买家看的订单详情和管理员看的订单详情，这一块长得完全一样 ——
// 都是「快照里的商品名 / 尺码 / 颜色 / 成交价 × 数量」。
// 抽出来只有一个目的：两边的金额和展示永远一致。
//
// 【为什么它是 Server Component】
// 没有交互，不需要 "use client"。不加这行指令，组件就留在服务端渲染，
// 不会往浏览器发一份 JS。
// ============================================================================

export function OrderItemsCard({
  items,
  totalAmount,
  itemsTotal,
  discountAmount = 0,
  coupon,
  itemAction,
}: {
  items: OrderItemView[]
  /** 实付（分）—— 已经扣掉了优惠 */
  totalAmount: number
  /**
   * 商品原价合计（分）。不传就当成没优惠，和实付相同。
   *
   * 【为什么原价要传进来，而不是拿 totalAmount 反推】
   * totalAmount 是「实付」，反推需要 discountAmount；而 discountAmount
   * 是券的账，将来可能还有别的减免（运费、活动）。让调用方把「原价」
   * 这个快照事实直接给出来，这个组件就不用知道任何折扣规则 ——
   * 它只管把三行数字摆好
   */
  itemsTotal?: number
  /** 优惠金额（分） */
  discountAmount?: number
  /** 用的哪张券，没用到就传 null。买家和管理员都看得到 */
  coupon?: CouponRule | null
  /**
   * 每一行右侧的附加操作（目前只有买家的「去评价」）。
   *
   * 【为什么是「传一个渲染函数」而不是「传一个 canReview 开关」】
   * 这个组件被买家和管理员两个页面共用。如果给它加一个 `canReview` 布尔值，
   * 就等于把「什么订单能评价」这条业务规则塞进了一个纯展示组件里 ——
   * 以后规则变了（比如加个评价期限），改的地方会是这里，而不是真正
   * 管业务的地方。传渲染函数则相反：规则留在页面（Server Component）里，
   * 这个组件只负责「把给我的东西画在右边」，管理员页什么都不传即可。
   */
  itemAction?: (item: OrderItemView) => React.ReactNode
}) {
  const originalTotal = itemsTotal ?? totalAmount
  const hasDiscount = discountAmount > 0

  return (
    <div className="rounded-xl border">
      <div className="border-b px-4 py-3 text-sm font-medium">
        商品清单（{items.length} 种）
      </div>

      {/*
        【为什么是 flex-wrap】
        「去评价」展开后的表单要占满整行，但它和商品信息、金额在同一层。
        让这个 flex 容器允许换行，展开的表单自带 w-full 就会自己掉到下一行，
        不需要把按钮和表单拆成两个位置（那样组件就得知道「按钮画哪儿、
        表单画哪儿」，等于把布局细节泄漏给调用方）。
      */}
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              {/*
                这里显示的是**下单时的快照**，不是关联查出来的商品名。
                商家改了名字、调了价格、甚至下架了这款鞋，
                用户翻看历史订单看到的仍然是当时买的东西。
              */}
              <p className="font-medium">{item.productName}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {item.color} / {item.size}码
                {item.skuCode && (
                  <span className="ml-2 text-xs">{item.skuCode}</span>
                )}
              </p>
            </div>

            <div className="shrink-0 text-right text-sm">
              <div className="tabular-nums">{formatPrice(item.price)}</div>
              <div className="text-muted-foreground">× {item.quantity}</div>
            </div>

            <div className="w-24 shrink-0 text-right font-medium tabular-nums">
              {formatPrice(item.price * item.quantity)}
            </div>

            {itemAction?.(item)}
          </li>
        ))}
      </ul>

      <Separator />

      {/*
        【为什么有优惠时要摊成三行，没优惠时只有一行】
        买家翻历史订单时最需要确认的是「这一单到底付了多少、为什么是这个数」。
        只给一个实付金额，他心里的账对不上（「我明明买了 899 的东西，
        怎么显示 799」）。三行摆出来：商品总额 → 优惠（减了多少）→ 实付，
        数字自己就把话说完了，客服也少一堆「这单怎么算的」。
        没用到券的订单保持原来的单行「合计」—— 多一个「优惠 -¥0.00」
        只是噪音。
      */}
      {hasDiscount ? (
        <div className="space-y-1.5 px-4 py-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">商品总额</span>
            <span className="tabular-nums">{formatPrice(originalTotal)}</span>
          </div>

          <div className="flex justify-between text-primary">
            <span className="min-w-0">
              优惠
              {/* 券的规则和券码都列出来：买家想知道「省的是哪张券」，
                  管理员要对账「这单核销的是哪张」。同一个展示覆盖两种需求；
                  如果券后来被删（onDelete: SetNull），这里只会显示
                  「优惠」两个字，金额仍然是当时冻结的那个数 */}
              {coupon ? (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {couponLabel(coupon)} ·{" "}
                  <span className="font-mono">{coupon.code}</span>
                </span>
              ) : null}
            </span>
            <span className="shrink-0 tabular-nums">
              -{formatPrice(discountAmount)}
            </span>
          </div>

          <Separator className="my-1" />

          <div className="flex items-baseline justify-between">
            <span className="font-medium">实付</span>
            <span className="text-2xl font-bold text-primary tabular-nums">
              {formatPrice(totalAmount)}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-baseline justify-between px-4 py-4">
          <span className="font-medium">合计</span>
          <span className="text-2xl font-bold text-primary">
            {formatPrice(totalAmount)}
          </span>
        </div>
      )}
    </div>
  )
}
