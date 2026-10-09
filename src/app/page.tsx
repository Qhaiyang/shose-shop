import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { ProductCard } from "@/components/product/product-card"
import { buttonVariants } from "@/components/ui/button"
import { getAllCategories, getAllProducts } from "@/lib/products"
import { cn } from "@/lib/utils"

// ============================================================================
// 首页
//
// 【为什么它是 Server Component、没有任何 "use client"】
// 三个区（Hero / 分类入口 / 热卖鞋型）全是静态展示，没有一处需要响应点击
// 之外的行为 —— 而点击也只是普通导航。<Link> 在 App Router 里天然是
// 客户端软跳转，不需要为此把整页变成客户端组件。所以这一页服务端渲染完
// HTML 就发出去，浏览器不下载任何属于本页的 JS。
//
// 【为什么查询直接写在这里，不新开一个 lib 函数】
// 复用的都是已有的 getAllProducts / getAllCategories，只是取前几个、
// 按分类归了一下组。为「取前 3 个」单独包一层 lib 函数属于过度设计。
// ============================================================================

// 【为什么要 force-dynamic】
// 和 /products 同一个理由：布局里读了 cookies()，页面本来就该每次请求重算；
// 显式写出来是防止构建期去连数据库预渲染 —— 构建机上没有库，会直接失败。
export const dynamic = "force-dynamic"

/** 首页「热卖鞋型」展示几款。种子里一共就 3 款，取 3 个刚好铺满一行 */
const FEATURED_COUNT = 3

export default async function HomePage() {
  // 两次查询互不依赖，并发发出，省一个往返
  const [products, categories] = await Promise.all([
    getAllProducts({ sort: "newest" }),
    getAllCategories(),
  ])

  const featured = products.slice(0, FEATURED_COUNT)

  // 【分类入口的缩略图从哪来】
  // 分类名来自数据库（getAllCategories 是 distinct 出来的，不写死），
  // 配图就取该分类下的一款商品主图 —— 这样以后加了新分类、换了商品图，
  // 首页跟着变，不需要回来改这个文件。
  // 该分类一款在售商品都没有时 cover 为 null，走占位底色。
  const categoryCards = categories.map((name) => ({
    name,
    cover: products.find((p) => p.category === name)?.image ?? null,
    count: products.filter((p) => p.category === name).length,
  }))

  return (
    <>
      {/* ==================== Hero ==================== */}
      <section className="border-b bg-muted/40">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:py-24">
          <div className="space-y-6">
            <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              把好鞋，
              <br />
              穿在脚下
            </h1>
            <p className="max-w-md text-lg text-muted-foreground">
              跑步、篮球、日常通勤 —— 三款精选鞋型，尺码齐全，现货直发。
            </p>
            {/* 注意：shadcn v4 的 Button 底层是 base-ui，没有 asChild。
                要给 Link 套按钮样式，用 buttonVariants() 生成 class 更直接
                （和 products/[id]/not-found.tsx 里的做法一致） */}
            <Link
              href="/products"
              className={cn(buttonVariants({ size: "lg" }), "gap-2")}
            >
              去逛逛
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="relative aspect-[4/3] overflow-hidden rounded-xl border bg-muted">
            {/* 和商品卡片同一个理由用原生 <img>：本地 WebP 不走 next/image
                的优化管线，少一层配置 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/hero.webp"
              alt="精选鞋款"
              className="size-full object-cover"
            />
          </div>
        </div>
      </section>

      {/* ==================== 分类入口 ==================== */}
      <section className="mx-auto w-full max-w-6xl px-4 py-14">
        <h2 className="text-2xl font-bold tracking-tight">按分类逛</h2>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {categoryCards.map(({ name, cover, count }) => (
            <Link
              key={name}
              href={`/products?category=${encodeURIComponent(name)}`}
              className="group relative overflow-hidden rounded-xl border"
            >
              <div className="relative aspect-[4/3] bg-muted">
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cover}
                    alt={name}
                    className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                ) : null}

                {/* 图上压字必须垫一层深色渐变，否则浅底照片上的白字看不清。
                    这是「压字遮罩」，不是动效 —— 不做 hover 才出现的花活 */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/20 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-4 text-white">
                  <p className="text-lg font-semibold">{name}</p>
                  <p className="text-sm text-white/85">{count} 款在售</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ==================== 热卖鞋型 ==================== */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-16">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-2xl font-bold tracking-tight">热卖鞋型</h2>
          <Link
            href="/products"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            查看全部
            <ArrowRight className="size-3.5" />
          </Link>
        </div>

        {/* 栅格和 /products 列表页保持一致，卡片直接复用 ProductCard，
            不另写一套首页专用的卡片 */}
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {featured.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </section>
    </>
  )
}
