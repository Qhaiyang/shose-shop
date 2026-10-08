import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, TicketPercent } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { getCurrentUser } from "@/lib/auth"
import {
  couponFaceValue,
  couponLabel,
  couponThresholdText,
  myCouponStatus,
  MY_COUPON_STATUS,
  type MyCouponStatus,
} from "@/lib/coupons"
import { getMyCoupons, type MyCoupon } from "@/lib/coupons-db"
import { formatDateInput } from "@/lib/form"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "我的券 | 鞋店",
}

// ---------------------------------------------------------------------------
// 三个 tab
//
// 【为什么用 URL 参数而不是 useState】
// 和订单/商品列表一样：tab 是「页面状态」，不是「组件状态」。
// 放在 URL 里，刷新不丢、能分享、能前进后退 —— 而且页面保持
// 服务端渲染，不用为了记住「点了哪个 tab」把整棵子树变成客户端组件。
// ---------------------------------------------------------------------------

const TABS = [
  { key: "unused", label: "未使用" },
  { key: "used", label: "已使用" },
  { key: "expired", label: "已过期" },
] as const

type TabKey = (typeof TABS)[number]["key"]

/**
 * 这个 tab 收哪些状态。
 *
 * 【为什么「已停用」的券放进「已过期」那一栏】
 * 对用户来说这两件事的**结果**是一样的：这张券用不了了。
 * 为「被管理员停用」单独开第四个 tab，用户会问「什么叫停用」——
 * 状态本身还是标出来的（卡片上有个「已停用」的角标），
 * 但归档到「用不了的券」这一栏更符合他找券的方式：
 * 「我那张能用的券去哪了」→ 翻未使用；「这张怎么没了」→ 翻已过期
 */
function tabStatuses(tab: TabKey): MyCouponStatus[] {
  if (tab === "used") return [MY_COUPON_STATUS.USED]
  if (tab === "unused") return [MY_COUPON_STATUS.UNUSED]
  return [MY_COUPON_STATUS.EXPIRED, MY_COUPON_STATUS.DISABLED]
}

type MyCouponsPageProps = {
  searchParams: Promise<{ tab?: string }>
}

export default async function MyCouponsPage({ searchParams }: MyCouponsPageProps) {
  const user = await getCurrentUser()
  if (!user) redirect("/login?next=/my-coupons")

  const [params, myCoupons] = await Promise.all([
    searchParams,
    getMyCoupons(user.id),
  ])

  // 非法的 tab 值（?tab=xxx）一律当成第一个，不报错也不 404 ——
  // 这是个纯展示参数，为它抛错反而会让用户以为是网站坏了
  const tab: TabKey = TABS.some((t) => t.key === params.tab)
    ? (params.tab as TabKey)
    : "unused"

  const now = new Date()

  // 每张券算一次状态，同时按 tab 分组统计数量（角标要用）
  const withStatus = myCoupons.map((item) => ({
    item,
    status: myCouponStatus(item.coupon, item.usedAt, now),
  }))

  const countOf = (key: TabKey) =>
    withStatus.filter((row) => tabStatuses(key).includes(row.status)).length

  const visible = withStatus.filter((row) => tabStatuses(tab).includes(row.status))

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">我的券</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {myCoupons.length} 张 · 下单时在结算页选一张用
        </p>
      </div>

      {/* ---------------- tab ---------------- */}
      <div className="mb-6 flex gap-1 border-b">
        {TABS.map(({ key, label }) => {
          const active = key === tab
          const count = countOf(key)

          return (
            <Link
              key={key}
              href={`/my-coupons?tab=${key}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-4 py-2 text-sm transition-colors",
                active
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {/* 数量为 0 时不显示角标：一列「已使用 0」看着像功能坏了 */}
              {count > 0 ? (
                <span className="ml-1 text-xs text-muted-foreground">{count}</span>
              ) : null}
            </Link>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyTab tab={tab} />
      ) : (
        <ul className="space-y-3">
          {visible.map(({ item, status }) => (
            <CouponCard key={item.userCouponId} item={item} status={status} now={now} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 一张券的卡片。
 *
 * 【为什么按状态换掉右下角那块】
 *   unused  → 「去用」的入口（链接到商品列表）
 *   used    → 「哪一单用的」的入口（链接到那笔订单）
 *   expired → 只能解释为什么用不了（有效期 / 已停用）
 * 一张用过的券上摆个「去使用」按钮是骗人的，所以按状态换掉右下角那块。
 */
function CouponCard({
  item,
  status,
  now,
}: {
  item: MyCoupon
  status: MyCouponStatus
  now: Date
}) {
  const { coupon } = item
  const dimmed = status !== MY_COUPON_STATUS.UNUSED

  return (
    <li
      className={cn(
        "flex items-center gap-4 rounded-xl border p-4",
        // 用不了的券整体降饱和度：一眼扫过去就知道哪些还能用，
        // 不用逐张去读右边的小字
        dimmed && "bg-muted/30",
      )}
    >
      <div className="w-16 shrink-0 text-center">
        <div
          className={cn(
            "text-lg leading-tight font-bold",
            dimmed ? "text-muted-foreground" : "text-primary",
          )}
        >
          {couponFaceValue(coupon)}
        </div>
        <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
          {couponThresholdText(coupon)}
        </div>
      </div>

      <div className="min-w-0 flex-1 border-l border-dashed pl-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{couponLabel(coupon)}</span>
          <StatusBadge status={status} coupon={coupon} now={now} />
        </div>

        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-mono">{coupon.code}</span>
          {" · "}
          {formatDateInput(coupon.startAt)} ~ {formatDateInput(coupon.endAt)}
        </p>

        <p className="mt-0.5 text-xs text-muted-foreground">
          领于 {item.claimedAt.toLocaleString("zh-CN")}
          {item.usedAt ? ` · 用于 ${item.usedAt.toLocaleString("zh-CN")}` : ""}
        </p>
      </div>

      <div className="shrink-0">
        {status === MY_COUPON_STATUS.UNUSED ? (
          <Link
            href="/products"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1")}
          >
            去使用
            <ArrowRight className="size-3.5" />
          </Link>
        ) : status === MY_COUPON_STATUS.USED && item.orderId ? (
          // 【为什么要链到订单】用户看到「已使用」时下一个问题必然是
          // 「用在哪一单了」。让他自己去订单列表里翻，等于把这个问题
          // 又还给他 —— 券和订单的关系明明就存在 orderId 里
          <Link
            href={`/orders/${item.orderId}`}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1")}
          >
            查看订单
            <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </div>
    </li>
  )
}

/**
 * 状态角标。
 *
 * 【为什么「未开始」的券也归到未使用、但要单独标出来】
 * 它确实还没用、也确实还能用（只是要等），归到「未使用」是对的；
 * 但用户点进去发现结算页里没有它，会以为丢了一张券。
 * 标一个「X 月 X 日起可用」他立刻就懂了。
 */
function StatusBadge({
  status,
  coupon,
  now,
}: {
  status: MyCouponStatus
  coupon: { startAt: Date }
  now: Date
}) {
  if (status === MY_COUPON_STATUS.USED) {
    return <Badge variant="secondary">已使用</Badge>
  }
  if (status === MY_COUPON_STATUS.EXPIRED) {
    return <Badge variant="outline">已过期</Badge>
  }
  if (status === MY_COUPON_STATUS.DISABLED) {
    // 和「已过期」分开说：过期是自然的，停用是运营的决定。
    // 页面下方那句解释文案也跟着这张角标走
    return <Badge variant="outline">已停用</Badge>
  }
  if (now < coupon.startAt) {
    return <Badge variant="outline">未开始</Badge>
  }
  return null
}

function EmptyTab({ tab }: { tab: TabKey }) {
  const text: Record<TabKey, { title: string; hint: string }> = {
    unused: {
      title: "还没有可用的券",
      hint: "商品详情页和购物车页都有领券入口，领完会出现在这里",
    },
    used: {
      title: "还没用过券",
      hint: "结算时选中一张券，下单后它就会挪到这一栏",
    },
    expired: {
      title: "没有过期的券",
      hint: "用不掉的券（过期或被停用）会归档到这里",
    },
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
      <TicketPercent className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{text[tab].title}</p>
        <p className="text-xs text-muted-foreground">{text[tab].hint}</p>
      </div>
      {tab === "unused" ? (
        <Link href="/products" className={cn(buttonVariants({ size: "sm" }), "mt-1")}>
          去逛逛
        </Link>
      ) : null}
    </div>
  )
}
