import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ExternalLink, Sparkles } from "lucide-react"

import { updateProductAction } from "@/app/actions/admin"
import {
  DeleteProductButton,
  ProductActiveToggle,
} from "@/components/admin/product-actions"
import { ProductForm } from "@/components/admin/product-form"
import { SkuPanel } from "@/components/admin/sku-panel"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { getAdminProductDetail } from "@/lib/products"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

type AdminProductDetailPageProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{ created?: string }>
}

export async function generateMetadata({ params }: AdminProductDetailPageProps) {
  const { id } = await params
  const product = await getAdminProductDetail(id)
  return { title: product ? `${product.name} | 管理后台` : "商品 | 管理后台" }
}

export default async function AdminProductDetailPage({
  params,
  searchParams,
}: AdminProductDetailPageProps) {
  const { id } = await params
  const query = await searchParams

  const product = await getAdminProductDetail(id)
  if (!product) notFound()

  // 刚新建完跳过来时会带上 ?created=1
  const justCreated = query.created === "1"

  return (
    <div className="mx-auto w-full max-w-4xl">
      <Link
        href="/admin/products"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 gap-1")}
      >
        <ArrowLeft className="size-4" />
        返回商品列表
      </Link>

      {/* ---------------- 新建成功后的引导 ---------------- */}
      {justCreated ? (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-green-600" />
          <div className="text-sm text-green-900">
            <p className="font-medium">商品创建成功，还差最后一步</p>
            <p className="mt-0.5 text-green-700">
              现在它一个规格都没有，前台会显示成「售罄」。
              往下拉，用「新增规格」把颜色和尺码配齐，买家才能下单。
            </p>
          </div>
        </div>
      ) : null}

      {/* ---------------- 标题 + 状态 ---------------- */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{product.name}</h1>
            {product.isActive ? (
              <Badge variant="secondary">在售</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                已下架
              </Badge>
            )}
          </div>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {product.id}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* 去看买家眼里的样子。下架了会 404，所以只在售时给这个入口 */}
          {product.isActive ? (
            <Link
              href={`/products/${product.id}`}
              target="_blank"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
            >
              <ExternalLink className="size-4" />
              查看前台页面
            </Link>
          ) : null}

          <ProductActiveToggle productId={product.id} isActive={product.isActive} />
        </div>
      </div>

      {/* ---------------- 商品信息 ---------------- */}
      <section className="mb-8 rounded-xl border p-5">
        <h2 className="mb-4 font-semibold">商品信息</h2>
        <ProductForm
          action={updateProductAction}
          productId={product.id}
          submitLabel="保存修改"
          defaultValues={{
            name: product.name,
            description: product.description,
            category: product.category,
            images: product.images,
          }}
        />
      </section>

      {/* ---------------- 规格（SKU） ---------------- */}
      <section className="mb-8">
        <div className="mb-4">
          <h2 className="font-semibold">
            规格（SKU）
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              共 {product.skus.length} 个
            </span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            每个「颜色 + 尺码」组合是一条 SKU，价格和库存都挂在它上面 ——
            买家买的是 SKU，不是商品。
          </p>
        </div>

        <SkuPanel
          productId={product.id}
          skus={product.skus}
          referencedByOrders={product.referencedByOrders}
        />
      </section>

      {/* ---------------- 危险操作 ---------------- */}
      <section className="rounded-xl border border-destructive/30 p-5">
        <h2 className="font-semibold text-destructive">危险操作</h2>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          {product.referencedByOrders > 0
            ? `这款商品已经被 ${product.referencedByOrders} 条订单项引用，服务端会拒绝删除。改用「下架」可以让它从前台消失，同时保住历史订单可追溯。`
            : "这款商品还没有被任何订单引用，可以删除。删除不可恢复。"}
        </p>

        <DeleteProductButton
          productId={product.id}
          productName={product.name}
          redirectTo="/admin/products"
          size="default"
        />
      </section>
    </div>
  )
}
