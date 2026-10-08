"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2, Ticket } from "lucide-react"
import { toast } from "sonner"

import { claimCouponAction } from "@/app/actions/coupon"
import { Button } from "@/components/ui/button"
import { couponFaceValue, couponLabel, couponThresholdText } from "@/lib/coupons"
// 【import type 是安全的，尽管 coupons-db.ts 里有 prisma】
// 类型在编译时就被抹掉了，不会在浏览器产物里留下 require ——
// 真正会让 next build 报 Can't resolve 'fs' 的是「运行时的 import」。
// coupons.ts 那边是真要用的函数，所以它必须自己干净（不碰 prisma）
import type { ClaimableCoupon } from "@/lib/coupons-db"
import { formatDateInput } from "@/lib/form"

// ============================================================================
// 领券入口（商品详情页 / 购物车页共用）
//
// 【为什么未登录也让他点，而不是把按钮灰掉】
// 灰按钮不解释原因，用户只会觉得「这张券有问题」。让他点，点完告诉他
// 「登录之后就能领」并把他送到登录页、登录完再送回来 —— 和收藏按钮
// 是同一套做法（见 favorite-button.tsx）。
//
// 【为什么领完不把这张券从列表里拿掉】
// 「领到手」的反馈必须是可见的：券还在那儿，只是按钮变成「已领 1 张」。
// 如果点完就消失，用户会怀疑自己到底领上没有 —— 而他要去 /my-coupons
// 才能确认，那是一次多余的跳转。
//
// 【为什么本地还要记一份 claimedMore】
// 领券成功后服务端的数据确实变了，但页面上的数字要等 router.refresh()
// 走完才更新。本地先 +1，按钮立刻变成「已领完」，不用等一个来回。
// 它只是**显示**用的乐观值：真正的「还能不能领」永远由服务端的
// INSERT ... WHERE 判（见 coupons-db.ts 的 claimCoupon），
// 所以就算这里算错了，也领不出第三张
// ============================================================================

type CouponClaimListProps = {
  coupons: ClaimableCoupon[]
  isLoggedIn: boolean
  /** 领券入口所在页面的路径，登录完回到这里 */
  nextPath: string
  title?: string
  description?: string
}

export function CouponClaimList({
  coupons,
  isLoggedIn,
  nextPath,
  title = "可以领的优惠券",
  description,
}: CouponClaimListProps) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [claimedMore, setClaimedMore] = useState<Record<string, number>>({})
  const [, startTransition] = useTransition()

  // 一张券都没有时整块不渲染。
  // 【为什么不是渲染一个「暂时没有可领的券」的空盒子】
  // 商品详情页的主线是「看鞋、加购」，空盒子会把用户从主线里拽出来
  // 看一个跟他此刻无关的信息。没有券就什么都不显示 —— 干净的减法
  if (coupons.length === 0) return null

  function handleClaim(couponId: string) {
    if (!isLoggedIn) {
      toast.info("登录之后就能领券了", {
        description: "券跟着账号走，换个设备也还在",
      })
      router.push(`/login?next=${encodeURIComponent(nextPath)}`)
      return
    }

    setPendingId(couponId)

    startTransition(async () => {
      const result = await claimCouponAction(couponId)
      setPendingId(null)

      if (!result.ok) {
        toast.error("没能领到", { description: result.error })
        // 失败也刷新：多半是这张券刚好被停用/抢完了，
        // 页面上那份数据已经旧了，重查一遍比让用户对着旧数据再点一次强
        router.refresh()
        return
      }

      setClaimedMore((prev) => ({ ...prev, [couponId]: (prev[couponId] ?? 0) + 1 }))
      toast.success("领取成功", {
        description: "已经放进「我的券」，下单时可以直接选它",
      })
      router.refresh()
    })
  }

  return (
    <section className="rounded-xl border p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 font-semibold">
            <Ticket className="size-4" />
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>

        {/* 领完总得有个地方看得到，否则「领取」这个动作像掉进了黑洞 */}
        <Link
          href="/my-coupons"
          className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          我的券
        </Link>
      </div>

      <ul className="space-y-2">
        {coupons.map(({ coupon, claimedCount: serverCount }) => {
          const claimedCount = serverCount + (claimedMore[coupon.id] ?? 0)
          // 未登录时不算「领完了」—— 他还没开始领，点了会被引导去登录
          const usedUp = isLoggedIn && claimedCount >= coupon.perUserLimit
          const pending = pendingId === coupon.id

          return (
            <li
              key={coupon.id}
              className="flex items-center gap-4 rounded-lg border border-dashed p-3"
            >
              {/* 券面：大字是「能省多少」，小字是门槛。
                  先给收益、再给条件 —— 用户扫券时先看值不值 */}
              <div className="w-16 shrink-0 text-center">
                <div className="text-lg leading-tight font-bold text-primary">
                  {couponFaceValue(coupon)}
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                  {couponThresholdText(coupon)}
                </div>
              </div>

              <div className="min-w-0 flex-1 border-l border-dashed pl-4">
                <p className="line-clamp-1 text-sm font-medium">
                  {couponLabel(coupon)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span className="font-mono">{coupon.code}</span>
                  {" · "}
                  {formatDateInput(coupon.endAt)} 前有效
                  {coupon.perUserLimit > 1
                    ? ` · 每人限领 ${coupon.perUserLimit} 张`
                    : ""}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <Button
                  type="button"
                  size="sm"
                  variant={usedUp ? "secondary" : "default"}
                  disabled={usedUp || pending}
                  onClick={() => handleClaim(coupon.id)}
                >
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {usedUp
                    ? "已领完"
                    : pending
                      ? "领取中…"
                      : isLoggedIn
                        ? "领取"
                        : "登录领取"}
                </Button>

                {/* 领过之后把张数写出来。没有这句话的话，
                    「已领完」和「这张券我一张都没领过」看起来是一样的 */}
                {claimedCount > 0 ? (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    已领 {claimedCount} 张
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
