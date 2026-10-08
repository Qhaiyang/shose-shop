import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { CouponClaimList } from "@/components/coupon/coupon-claim-list"
import { FavoriteButton } from "@/components/product/favorite-button"
import { ImageGallery } from "@/components/product/image-gallery"
import { ProductReviews } from "@/components/product/product-reviews"
import { SizeGuideAssistant } from "@/components/product/size-guide-assistant"
import { SkuSelector } from "@/components/product/sku-selector"
import { getCurrentUser } from "@/lib/auth"
import { getClaimableCoupons } from "@/lib/coupons-db"
import { isFavorited } from "@/lib/favorites-db"
import { getProductDetail } from "@/lib/products"
import { getProductReviews } from "@/lib/reviews-db"
import { getSizeGuides } from "@/lib/size-guide-db"

// ============================================================================
// 商品详情页 —— Server Component
// ============================================================================

export const dynamic = "force-dynamic"

type PageProps_ = PageProps<"/products/[id]">

/**
 * 动态生成页面标题。
 * 注意 Next 16 里 params 是 Promise，metadata 函数里也要 await。
 */
export async function generateMetadata({
  params,
}: PageProps_): Promise<Metadata> {
  const { id } = await params
  const product = await getProductDetail(id)

  if (!product) return { title: "商品不存在 | 鞋店" }

  return {
    title: `${product.name} | 鞋店`,
    description: product.description,
  }
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: PageProps_) {
  // Next 16 里 params / searchParams 都是 Promise，必须 await
  const [{ id }, search] = await Promise.all([params, searchParams])

  // 评价区的翻页。这里不做校验 —— getProductReviews 内部会把
  // 非法值（"abc"、负数、0）统一洗成第 1 页，调用方不用重复操心。
  // 但它得在这里解析，因为「要查第几页」是页面这一层才知道的事
  //
  // 【为什么要判 Array.isArray】
  // Next 生成的 searchParams 类型是 string | string[] ——
  // ?reviewPage=1&reviewPage=2 这种重复参数会被解析成数组。
  // 取第一个就够了，后面的忽略
  const rawReviewPage = search.reviewPage
  const reviewPage = Number.parseInt(
    Array.isArray(rawReviewPage) ? (rawReviewPage[0] ?? "1") : (rawReviewPage ?? "1"),
    10,
  )

  // 查商品的同时查登录状态，两者互不依赖，并行发出去
  const [product, user] = await Promise.all([
    getProductDetail(id),
    getCurrentUser(),
  ])

  // 商品不存在、或已被后台下架 → 渲染 not-found 页面
  if (!product) {
    notFound()
  }

  // 下面两个查询都依赖 product（一个要分类、一个要 id），
  // 只能在拿到商品之后发，但彼此之间没有依赖，可以并行
  const [sizeGuides, reviews, favorited, claimableCoupons] = await Promise.all([
    // 尺码助手要用的「脚长 → 尺码」映射，按本商品分类查
    getSizeGuides(product.category),
    // 评价列表 + 评分分布
    getProductReviews(product.id, reviewPage),
    // 未登录就没得查（isFavorited 要 userId）。给 Promise.resolve(false)
    // 而不是让 Promise.all 去等一个条件分支，这样三个查询始终并行发出
    user ? isFavorited(user.id, product.id) : Promise.resolve(false),
    // 能领的券。未登录也查（传 null）—— 让游客看得到「这里能领券」，
    // 点了再引导去登录，比整块藏起来更能促成注册。
    // 【为什么不用商品价格过滤】「这张券买这双鞋够不够门槛」是结算时
    // 拿购物车金额判断的事（见 coupons-db.ts 的 getClaimableCoupons），
    // 商品页只管「有哪些券可以领」
    getClaimableCoupons(user?.id ?? null),
  ])

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      {/* 返回入口 */}
      <Link
        href="/products"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        返回商品列表
      </Link>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        {/* ==================== 左：图片轮播 ==================== */}
        <div>
          <ImageGallery images={product.images} productName={product.name} />
        </div>

        {/* ==================== 右：信息 + 选择器 ==================== */}
        <div className="space-y-6 lg:sticky lg:top-8 lg:self-start">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-normal">
                {product.category}
              </Badge>
              {product.totalStock === 0 && (
                <Badge variant="destructive">已售罄</Badge>
              )}
              {product.totalStock > 0 && product.totalStock < 10 && (
                <Badge variant="secondary">库存紧张</Badge>
              )}
            </div>

            <h1 className="text-3xl font-bold tracking-tight">
              {product.name}
            </h1>

            <p className="leading-relaxed text-muted-foreground">
              {product.description}
            </p>
          </div>

          <Separator />

          {/* SKU 选择器（客户端组件，负责颜色/尺码/数量的交互） */}
          <SkuSelector
            colors={product.colors}
            productId={product.id}
            productName={product.name}
            image={product.images[0] ?? null}
            isLoggedIn={user !== null}
          />

          {/* 收藏。放在「加入购物车」正下方而不是旁边：
              加购是主操作、收藏是次要操作，并排会让两个按钮权重一样大。
              它自己也是 w-full，和上面的加购按钮对齐成一条竖线 */}
          <FavoriteButton
            productId={product.id}
            initialFavorited={favorited}
            isLoggedIn={user !== null}
          />

          {/* 尺码助手：输入脚长推荐尺码 */}
          <SizeGuideAssistant
            category={product.category}
            guides={sizeGuides}
          />
        </div>
      </div>

      {/* ==================== 中：领券 ====================
          放在两栏网格**外面**、评价区前面。
          不放右栏的理由：券有几张是不确定的，塞进那一列会把
          lg:sticky 的区域撑得比屏幕还高，粘不住反而更别扭；
          整行铺开也让「满 800 减 100」这种信息一眼扫得完
          券一张都没有时组件自己返回 null，这里不用写条件 */}
      <div className="mt-14">
        <CouponClaimList
          coupons={claimableCoupons}
          isLoggedIn={user !== null}
          nextPath={`/products/${product.id}`}
          description="先领进兜里，下单时按订单金额选一张用"
        />
      </div>

      {/* ==================== 下：用户评价 ====================
          放在两栏网格**外面**：评价是长列表，塞进右栏会把左边那张大图
          拖成一条窄缝。整行铺开、和上面的图文分隔开，读起来更像一个
          独立的板块 */}
      <div className="mt-14 border-t pt-10">
        <ProductReviews productId={product.id} data={reviews} />
      </div>
    </div>
  )
}
