import type { Metadata } from "next"
import Link from "next/link"
import { Search, X } from "lucide-react"

import { ProductCard } from "@/components/product/product-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getAllCategories, getAllProducts } from "@/lib/products"
import {
  parseProductListQuery,
  type ProductSort,
} from "@/lib/product-query"
import { cn } from "@/lib/utils"

// ============================================================================
// 商品列表页 —— Server Component
//
// 直接在组件里 await 数据库查询，没有 API 路由这一层。
// 搜索 / 分类 / 排序三个条件都放进 URL，Server Component 读 searchParams
// 后直接查 Prisma，全程不需要客户端 JS。
// ============================================================================

export const metadata: Metadata = {
  title: "全部商品 | 鞋店",
  description: "浏览在售鞋款",
}

// 【重要】强制每次请求都重新渲染，不要静态预渲染。
// 详见文件里对 dynamic 的那段注释。
export const dynamic = "force-dynamic"

type ProductsPageProps = {
  searchParams: Promise<{ q?: string; category?: string; sort?: string }>
}

/** 排序选项，label 是给用户看的文案 */
const SORT_OPTIONS: { value: ProductSort; label: string }[] = [
  { value: "newest", label: "最新上架" },
  { value: "price_asc", label: "价格从低到高" },
  { value: "price_desc", label: "价格从高到低" },
]

/**
 * 拼列表链接。
 *
 * 【为什么和后台商品页用同一套「显式传条件」的思路】
 * 三个条件（q / category / sort）可以任意叠加。如果每个链接手写
 * "?q=xx&category=yy"，很快就会漏带一个 —— 典型症状是「点了价格排序，
 * 搜索词没了」。让所有链接都从这一个函数出来，条件只有一份。
 *
 * undefined 表示「不带这个条件」；sort 是默认值 newest 时不写进 URL，
 * 保持链接干净（和后台订单页 page=1 不写是同一个道理）
 */
function listHref(filters: {
  q?: string
  category?: string
  sort?: ProductSort
}): string {
  const query = new URLSearchParams()
  if (filters.q) query.set("q", filters.q)
  if (filters.category) query.set("category", filters.category)
  if (filters.sort && filters.sort !== "newest") query.set("sort", filters.sort)

  const qs = query.toString()
  return `/products${qs ? `?${qs}` : ""}`
}

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const params = await searchParams

  // URL 是用户可控的，先收窄再往下传。sort 落回默认、q/category 截断，
  // 都在 parseProductListQuery 里做完，这里拿到的就是干净值
  const { q, category, sort } = parseProductListQuery(params)

  const [products, categories] = await Promise.all([
    getAllProducts({ q, category, sort }),
    getAllCategories(),
  ])

  // 有没有任何一个筛选在生效 —— 决定要不要显示「清除筛选」那一行
  const hasFilter = Boolean(q || category)

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6 space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">全部商品</h1>
        <p className="text-muted-foreground">
          共 {products.length} 款在售鞋型
          {category ? ` · ${category}` : ""}
          {q ? ` · 搜索「${q}」` : ""}
        </p>
      </header>

      {/* ---------------- 搜索 ---------------- */}
      {/* 【为什么是 <form method="get">，而不是客户端组件 + onChange】
          条件放进 URL 白拿四个好处：刷新还在、链接可分享、前进后退正常、
          页面主体保持 Server Component。详见后台商品页那段长注释。

          【为什么要藏 hidden input】
          GET 表单提交时只提交表单里的字段，而 category / sort 是链接设的，
          不在表单里 —— 不带上它们，搜一次就等于把「只看某个分类 / 价格排序」
          悄悄清掉了。 */}
      <form
        method="get"
        action="/products"
        className="flex flex-wrap gap-2"
      >
        {category ? <input type="hidden" name="category" value={category} /> : null}
        {sort !== "newest" ? (
          <input type="hidden" name="sort" value={sort} />
        ) : null}

        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="搜商品名或描述"
          maxLength={40}
          className="w-64"
          aria-label="搜索商品"
        />

        <Button type="submit" variant="outline" className="gap-1.5">
          <Search className="size-4" />
          搜索
        </Button>
      </form>

      {/* ---------------- 分类 + 排序 ---------------- */}
      {/* 都做成链接而不是 <select>：和搜索一样把条件放进 URL。
          分类会动态出现「全部分类 + 数据库里 distinct 出来的每个分类」，
          排序固定三个选项。切换时都把另外两个条件一起带上 */}
      <div className="mt-4 flex flex-col gap-3">
        {/* 分类筛选 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">分类</span>
          <FilterTab href={listHref({ q, sort })} active={!category}>
            全部
          </FilterTab>
          {categories.map((c) => (
            <FilterTab
              key={c}
              href={listHref({ q, category: c, sort })}
              active={category === c}
            >
              {c}
            </FilterTab>
          ))}
        </div>

        {/* 价格排序 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">排序</span>
          {SORT_OPTIONS.map((option) => (
            <FilterTab
              key={option.value}
              href={listHref({ q, category, sort: option.value })}
              active={sort === option.value}
            >
              {option.label}
            </FilterTab>
          ))}
        </div>
      </div>

      {/* ---------------- 已生效的筛选（chip） ---------------- */}
      {/* 【为什么单独列出来、而不是让用户记住自己点了什么】
          条件多了之后，光看筛选栏看不出「现在到底是什么范围」。
          chip 一目了然，而且每个都能单独点 X 移除，不用动其它条件 */}
      {hasFilter ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {q ? (
            <Chip label={`搜索「${q}」`} href={listHref({ category, sort })} />
          ) : null}
          {category ? (
            <Chip label={`分类：${category}`} href={listHref({ q, sort })} />
          ) : null}
        </div>
      ) : null}

      {/* ---------------- 列表 ---------------- */}
      <div className="mt-6">
        {products.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            没有符合条件的商品
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

/** 筛选 / 排序的胶囊标签（链接） */
function FilterTab({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full border px-3 py-1.5 text-sm transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "hover:bg-muted",
      )}
    >
      {children}
    </Link>
  )
}

/** 已生效的筛选条件 chip，点 X 移除这一项（其余条件保留） */
function Chip({ label, href }: { label: string; href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={`移除筛选：${label}`}
    >
      {label}
      <X className="size-3.5" aria-hidden />
    </Link>
  )
}
