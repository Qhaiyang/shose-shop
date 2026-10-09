import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { formatPriceRange } from "@/lib/format"
import type { ProductListItem } from "@/lib/products"

// ============================================================================
// 商品卡片
//
// 这个组件没有交互状态，所以保持 Server Component 即可 —— 不写 "use client"。
// 页面在服务端把它渲染成 HTML 发给浏览器，客户端不需要为此加载任何 JS。
// 只有真正需要交互的（如 SkuSelector）才切成客户端组件。
// ============================================================================

export function ProductCard({ product }: { product: ProductListItem }) {
  return (
    <Link href={`/products/${product.id}`} className="group block">
      <Card className="gap-0 overflow-hidden p-0 transition-[box-shadow,border-color] hover:border-foreground/20 hover:shadow-lg">
        {/* 图片区 */}
        <div className="relative aspect-square overflow-hidden bg-muted">
          {product.image ? (
            // 这里用原生 <img> 而不是 next/image：图片是 public/shoes/ 下的
            // 本地文件，原生标签不需要在 next.config.ts 配任何东西，也不会
            // 在构建期给每张图生成多套尺寸产物。代价是没有自动的 srcset 和
            // 懒加载 —— 卡片图本来就压到 100KB 以内，这个取舍划得来
            // （哪天要换成 next/image，先看 next.config.ts 里有没有 images 配置）
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.image}
              alt={product.name}
              className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
              暂无图片
            </div>
          )}

          {/* 售罄角标：所有 SKU 库存都为 0 时才显示 */}
          {product.soldOut && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
              <Badge variant="secondary" className="text-base">
                已售罄
              </Badge>
            </div>
          )}
        </div>

        {/* 信息区 */}
        <div className="space-y-2 p-4">
          <Badge variant="outline" className="font-normal">
            {product.category}
          </Badge>

          <h3 className="line-clamp-2 font-medium leading-snug group-hover:text-primary">
            {product.name}
          </h3>

          <div className="flex items-baseline justify-between pt-1">
            <span className="text-xl font-bold tabular-nums text-primary">
              {formatPriceRange(product.minPrice, product.maxPrice)}
            </span>
            <span className="text-xs text-muted-foreground">
              {product.skuCount} 个规格
            </span>
          </div>
        </div>
      </Card>
    </Link>
  )
}
