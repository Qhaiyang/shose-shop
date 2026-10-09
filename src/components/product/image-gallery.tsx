"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

// ============================================================================
// 商品详情图 —— 主图 + 缩略图轮播
//
// 【为什么是 Client Component】
// 「当前显示第几张」是交互状态，Server Component 不能有 useState。
// 数据（images）由服务端页面查好传进来，这里只负责「切换」这一件事，
// 不查任何数据。
//
// 【为什么轮播而不是像以前那样竖着全列出来】
// 多图竖排会让页面左半边拉得很长，第一屏全是图、买点全被挤下去。
// 电商详情页的通行做法是一张主图 + 一排缩略图，点缩略图切主图 ——
// 图再多也只占一个位置，顺序就是后台排好的顺序。
// ============================================================================

type ImageGalleryProps = {
  images: string[]
  productName: string
}

export function ImageGallery({ images, productName }: ImageGalleryProps) {
  const [index, setIndex] = useState(0)

  // 没有图时渲染占位。注意要放在 useState 之后 —— Hooks 的调用顺序不能变
  if (images.length === 0) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-xl border bg-muted text-muted-foreground">
        暂无图片
      </div>
    )
  }

  // 图片数量中途变了（比如服务端刷新后变少），把越界的下标夹回来。
  // 直接在渲染时 clamp，而不是用 useEffect 去修正 —— 那样会先闪一帧
  // 越界的空图，还撞 react-hooks/set-state-in-effect 那条 lint 规则
  const current = Math.min(index, images.length - 1)

  // 循环切换：到头了再点下一张回到第一张
  const go = (delta: number) => {
    setIndex((current + delta + images.length) % images.length)
  }

  return (
    <div className="space-y-3">
      {/* ---------------- 主图 ---------------- */}
      <div className="relative overflow-hidden rounded-xl border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- 本地图片，见 product-card.tsx 的说明 */}
        <img
          src={images[current]}
          alt={`${productName} 商品图 ${current + 1}`}
          className="aspect-square w-full object-cover"
        />

        {images.length > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="上一张"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border bg-background/80 p-1.5 shadow-sm backdrop-blur transition-colors hover:bg-background"
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="下一张"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border bg-background/80 p-1.5 shadow-sm backdrop-blur transition-colors hover:bg-background"
            >
              <ChevronRight className="size-5" />
            </button>
          </>
        ) : null}

        {/* 计数器：让用户知道自己在第几张，也方便核对顺序 */}
        <span className="absolute bottom-2 right-2 rounded-full bg-background/80 px-2 py-0.5 text-xs tabular-nums backdrop-blur">
          {current + 1} / {images.length}
        </span>
      </div>

      {/* ---------------- 缩略图 ---------------- */}
      {images.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((src, i) => (
            <button
              key={`${i}-${src}`}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`查看第 ${i + 1} 张图`}
              aria-current={i === current}
              className={cn(
                "size-16 shrink-0 overflow-hidden rounded-md border-2 transition-all",
                i === current
                  ? "border-primary"
                  : "border-transparent opacity-60 hover:opacity-100",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- 本地图片 */}
              <img src={src} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
