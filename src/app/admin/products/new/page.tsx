import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createProductAction } from "@/app/actions/admin"
import { ProductForm } from "@/components/admin/product-form"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// 权限校验在 src/app/admin/layout.tsx 里
export const dynamic = "force-dynamic"

export const metadata = {
  title: "新建商品 | 管理后台",
}

export default function NewProductPage() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <Link
        href="/admin/products"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mb-4 gap-1")}
      >
        <ArrowLeft className="size-4" />
        返回商品列表
      </Link>

      <h1 className="text-2xl font-bold tracking-tight">新建商品</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        先填商品信息，保存后再加「颜色 + 尺码」规格。
        没有规格的商品在前台会显示成「售罄」，所以保存后会自动跳到规格那一页。
      </p>

      <div className="rounded-xl border p-5">
        {/*
          这一页本身是服务端组件，表单是客户端组件 —— 这是很常见的搭配：
          页面级的东西（路由、数据获取、权限）留在服务端，
          只有需要交互的那一块下沉到客户端。

          注意这里没有传 productId：新建时还没有 id，隐藏字段不存在，
          createProductAction 也就不会去读它。
        */}
        <ProductForm action={createProductAction} submitLabel="创建商品" />
      </div>
    </div>
  )
}
