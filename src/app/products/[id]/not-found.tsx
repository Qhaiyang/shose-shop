import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// 商品不存在或已下架时，notFound() 会渲染这个文件
export default function ProductNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <p className="text-5xl font-bold text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">商品不存在或已下架</h1>
      <p className="text-sm text-muted-foreground">
        这个商品可能已被删除，或者暂时下架了
      </p>
      {/* 注意：shadcn v4 的 Button 底层是 @base-ui/react，没有 asChild。
          要给 Link 套按钮样式，直接用 buttonVariants() 生成 class 更直接 */}
      <Link href="/products" className={cn(buttonVariants(), "mt-2")}>
        去看看其他商品
      </Link>
    </div>
  )
}
