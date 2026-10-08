import Link from "next/link"
import { AlertTriangle, Package, Plus, Search, X } from "lucide-react"

import { ProductBatchTable } from "@/components/admin/product-batch"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LOW_STOCK_THRESHOLD } from "@/lib/constants"
import { getAdminProducts } from "@/lib/products"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

export const metadata = {
  title: "商品管理 | 管理后台",
}

type AdminProductsPageProps = {
  searchParams: Promise<{ active?: string; stock?: string; q?: string }>
}

/** 搜索关键词的长度上限。超过这个长度的输入基本可以断定不是真心在搜 */
const MAX_QUERY_LENGTH = 40

/**
 * 拼筛选链接。
 *
 * 【为什么不再手写 "?active=1" 这种字符串】
 * 筛选条件一旦超过一个，手写拼接就必然出问题 ——
 * 最典型的是「加了新条件，但某一处的链接忘了带上它」。
 * 让所有链接都从同一个函数出来，条件就只存在一份。
 *
 * undefined 表示「不加这个条件」，所以调用方要显式地把想保留的
 * 条件写进去（比如切换上下架时把当前的 lowStock 一起传进来）。
 */
function productsHref(filters: {
  active?: boolean
  lowStock?: boolean
  q?: string
}): string {
  const query = new URLSearchParams()
  if (filters.active !== undefined) query.set("active", filters.active ? "1" : "0")
  if (filters.lowStock) query.set("stock", "low")
  if (filters.q) query.set("q", filters.q)

  const qs = query.toString()
  return `/admin/products${qs ? `?${qs}` : ""}`
}

export default async function AdminProductsPage({
  searchParams,
}: AdminProductsPageProps) {
  const params = await searchParams

  // URL 是用户可控的，不能直接信。
  // 这里只认 "1" / "0" 两个值，其它一律当成「不筛选」——
  // 和订单页的 ?status= 是同一套处理思路（见 admin/orders/page.tsx）
  const active =
    params.active === "1" ? true : params.active === "0" ? false : undefined

  // 【为什么要截断长度，而不是原样传给数据库】
  // ?q= 后面能塞任意长的字符串。虽然 contains 生成的是参数化的 LIKE
  // （不会被注入），但一个几万字符的关键词会让 LIKE 白白扫一遍全表。
  // 商品名最多 60 个字，搜 40 个字已经是「他可能粘贴错东西了」的信号
  const q = (params.q ?? "").trim().slice(0, MAX_QUERY_LENGTH)

  // 低库存筛选。后台首页那张「低库存规格」卡片点进来就是这个
  const lowStock = params.stock === "low"

  // 【q 一定要传进来】
  // 漏掉它，页面会变成「标题写着『名称包含「跑鞋」』，表格里却是全部商品」——
  // 而且不报任何错。集成测试直接调 getAdminProducts 是发现不了这种
  // 「参数算出来了但没往下传」的 bug 的，只有真开一次页面才会露馅
  const products = await getAdminProducts({ active, lowStock, q })

  // 没有任何规格的商品在前台点了会显示售罄，是「建好了但没配完」的状态，
  // 单独提醒一下 —— 这是最容易忘的一步
  const incomplete = products.filter((product) => product.skuCount === 0)

  // 低库存视图下，把「涉及几个规格」也算出来显示。
  // 卡片上写的是 SKU 数，列表里却是商品数 —— 不解释清楚的话，
  // 管理员会以为两个数字有一个是错的
  const lowStockSkuTotal = products.reduce(
    (sum, product) => sum + product.lowStockSkuCount,
    0,
  )

  // 标题里把「当前是什么口径」说清楚。搜索时额外提一句关键词 ——
  // 否则搜完只剩 2 款商品，管理员会以为是数据丢了
  const scopeLabel =
    (lowStock
      ? `低库存商品：${products.length} 款（共 ${lowStockSkuTotal} 个规格库存低于 ${LOW_STOCK_THRESHOLD} 件）`
      : active === true
        ? `在售商品：${products.length} 款`
        : active === false
          ? `已下架商品：${products.length} 款`
          : `全部商品：${products.length} 款`) +
    (q ? ` · 名称包含「${q}」` : "")

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">商品管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">{scopeLabel}</p>
        </div>

        <Link
          href="/admin/products/new"
          className={cn(buttonVariants(), "gap-1.5")}
        >
          <Plus className="size-4" />
          新建商品
        </Link>
      </div>

      {/* ---------------- 未配置完的提醒 ---------------- */}
      {incomplete.length > 0 && active !== false ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <p className="font-medium">
              有 {incomplete.length} 款商品还没有任何规格，前台会显示成「售罄」
            </p>
            <p className="mt-0.5 text-amber-700">
              {incomplete.map((product) => product.name).join("、")}
              —— 点进去加「颜色 + 尺码」规格，买家的尺码选择就来自这里。
            </p>
          </div>
        </div>
      ) : null}

      {/* ---------------- 搜索 ---------------- */}
      {/*
        【为什么是 <form method="get">，不是客户端组件 + onChange】
        搜索条件放进 URL，白拿四个好处：
          1. 刷新页面搜索词还在
          2. 把链接发给别人，他看到的是同一批结果
          3. 浏览器前进/后退能正常用
          4. 不需要任何客户端 JS，这一页的主体仍然是 Server Component

        原生表单提交 = 一次整页导航。在后台这种以「查」为主的页面上，
        这个代价换来的是「URL 是唯一事实来源」，划算。
        想要不刷新的话再上客户端组件，但现在没有这个需求。

        【为什么要藏两个 hidden input】
        GET 表单提交时会把**表单里的所有**字段拼成 query，
        而当前 URL 上已有的 active / stock 不在表单里 —— 不带上它们，
        搜一次就等于把「只看在售」的筛选悄悄清掉了。
      */}
      <form method="get" action="/admin/products" className="flex flex-wrap gap-2">
        {active !== undefined ? (
          <input type="hidden" name="active" value={active ? "1" : "0"} />
        ) : null}
        {lowStock ? <input type="hidden" name="stock" value="low" /> : null}

        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="按商品名称搜索"
          maxLength={MAX_QUERY_LENGTH}
          className="w-56"
          aria-label="按商品名称搜索"
        />

        <Button type="submit" variant="outline" className="gap-1.5">
          <Search className="size-4" />
          搜索
        </Button>

        {q ? (
          // 清空搜索但要保住其他筛选条件 —— 所以是个链接，不是把输入框清空
          <Link
            href={productsHref({ active, lowStock })}
            className={cn(buttonVariants({ variant: "ghost" }), "gap-1.5")}
          >
            <X className="size-4" />
            清空搜索
          </Link>
        ) : null}
      </form>

      {/* ---------------- 筛选 ---------------- */}
      {/* 和订单页一样用链接做筛选：条件放进 URL，刷新不丢、能直接分享、不需要客户端 JS */}
      {/* 切换筛选时把 q 一起带上，否则「搜完再点筛选」搜索词就没了 */}
      <div className="flex flex-wrap gap-2">
        <FilterTab
          href={productsHref({ lowStock, q })}
          active={active === undefined}
        >
          全部
        </FilterTab>
        <FilterTab
          href={productsHref({ active: true, lowStock, q })}
          active={active === true}
        >
          在售
        </FilterTab>
        <FilterTab
          href={productsHref({ active: false, lowStock, q })}
          active={active === false}
        >
          已下架
        </FilterTab>

        <span className="mx-1 h-6 w-px self-center bg-border" aria-hidden />

        {/* 低库存是个独立维度，和上下架状态可以叠加：
            「在售 + 低库存」才是最该赶紧补货的那一批 */}
        <FilterTab
          href={productsHref({ active, lowStock: !lowStock, q })}
          active={lowStock}
        >
          低库存
        </FilterTab>
      </div>

      {/* ---------------- 列表 ---------------- */}
      {products.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
          <Package className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">没有符合条件的商品</p>
        </div>
      ) : (
        // 表格（含批量操作工具条）是客户端组件，原因见那个文件的开头
        <ProductBatchTable products={products} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小组件
//
// 缩略图和整张表格都搬去了 components/admin/product-batch.tsx ——
// 表格要支持勾选，必须是客户端组件，而 Thumbnail 只被它用。
// 这里只留页面自己的筛选标签。
// ---------------------------------------------------------------------------

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
