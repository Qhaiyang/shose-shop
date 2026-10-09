"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MAX_IMAGES } from "@/lib/form"
import { moveItem } from "@/lib/images"

// ============================================================================
// 后台商品图片编辑器：增删 URL + 上下调整顺序
//
// 【为什么不用旧的「一行一个路径」文本框】
// 文本框能表达「图片有哪些」，但表达不了「顺序」—— 用户只能靠「第几行」
// 这种看不见摸不着的约定，改顺序还得整段剪切粘贴。改成列表之后每一行
// 就是一张图：能预览、能删、能上移下移，顺序一眼可见。
//
// 【值为什么是受控的（images + onChange），而不是自己攒一个 state 提交】
// 真正的表单状态（提交时序列化成什么）由 ProductForm 统一持有，
// 这个组件只是「编辑那个数组」的 UI。受控让「图片顺序」这件事
// 只有一个来源 —— ProductForm 里的 values.images。
// ============================================================================

export function ImageListEditor({
  images,
  onChange,
}: {
  images: string[]
  onChange: (images: string[]) => void
}) {
  // 待添加的 URL 只属于这个输入框自己，不进表单状态 —— 没点「添加」就不算数
  const [draft, setDraft] = useState("")

  function add() {
    const url = draft.trim()
    if (!url) return
    // 同样的路径贴两遍没意义。服务端的 parseImageLines 也会去重，
    // 这里提前拦一下，少一次「保存后才发现少了一张」的往返
    if (images.includes(url)) return
    if (images.length >= MAX_IMAGES) return

    onChange([...images, url])
    setDraft("")
  }

  return (
    <div className="space-y-3">
      {images.length > 0 ? (
        <ul className="space-y-2">
          {images.map((url, index) => (
            <li
              key={`${index}-${url}`}
              className="flex items-center gap-2 rounded-lg border p-2"
            >
              {/* 缩略图：让管理员确认路径真的指向一张图，而不是某个 404 */}
              <div className="size-14 shrink-0 overflow-hidden rounded-md border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- 本地图片 */}
                <img src={url} alt="" className="size-full object-cover" />
              </div>

              <code className="min-w-0 flex-1 truncate text-xs">{url}</code>

              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={index === 0}
                  onClick={() => onChange(moveItem(images, index, index - 1))}
                  title="上移"
                >
                  <ArrowUp className="size-4" />
                  <span className="sr-only">上移</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={index === images.length - 1}
                  onClick={() => onChange(moveItem(images, index, index + 1))}
                  title="下移"
                >
                  <ArrowDown className="size-4" />
                  <span className="sr-only">下移</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  onClick={() => onChange(images.filter((_, i) => i !== index))}
                  title="删除"
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">删除</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          还没有图片，用下面的输入框添加。
        </p>
      )}

      {/* ---------------- 添加新图 ---------------- */}
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="/shoes/prod_running-3.webp"
          className="font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!draft.trim() || images.length >= MAX_IMAGES}
          onClick={add}
        >
          <Plus className="size-4" />
          添加
        </Button>
      </div>

      {images.length >= MAX_IMAGES ? (
        <p className="text-xs text-muted-foreground">最多 {MAX_IMAGES} 张图</p>
      ) : null}
    </div>
  )
}
