"use client"

import { useState } from "react"
import { Ruler } from "lucide-react"

import { Input } from "@/components/ui/input"
import {
  MAX_FOOT_LENGTH_CM,
  MIN_FOOT_LENGTH_CM,
  parseFootLength,
  suggestSize,
  type SizeGuideView,
} from "@/lib/size-guide"

// ============================================================================
// 尺码助手：输入脚长 → 建议尺码
//
// 【为什么是 Client Component】
// 「输入脚长、实时出结果」是交互状态，Server Component 不能有 useState。
// 数据（本分类的尺码表）由详情页（Server Component）查好传进来，
// 这里只负责匹配 + 展示，不查任何数据 —— 和 ImageGallery 一个分工。
//
// 【为什么匹配在浏览器里做，而不是发一次 Server Action】
// 尺码表就这么几行，而且已经随页面传下来了。再发一次请求去问同一个
// 数据库，得到的答案一模一样，只是多了一次往返。匹配是纯函数，
// 放浏览器里即输即出，体验还更好。
// ============================================================================

export function SizeGuideAssistant({
  category,
  guides,
}: {
  category: string
  guides: SizeGuideView[]
}) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState("")

  const footLength = parseFootLength(raw)
  // 只有输入合法时才去匹配；输入为空或非法都直接走下面的提示分支
  const suggestion = footLength === null ? null : suggestSize(guides, footLength)

  return (
    <div className="rounded-xl border">
      {/* ---------------- 入口 ---------------- */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <Ruler className="size-4 text-muted-foreground" />
          尺码助手
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          {category} · 输入脚长推荐尺码
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t px-4 py-4">
          <div className="flex items-center gap-2">
            <Input
              inputMode="decimal"
              placeholder="例如 24.5"
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              aria-label="脚长（厘米）"
              className="max-w-40"
            />
            <span className="text-sm text-muted-foreground">cm</span>
          </div>

          {/* ---------------- 结果 ---------------- */}
          {raw.trim() === "" ? (
            <p className="text-sm text-muted-foreground">
              量一下脚长（站直、穿袜子量），输入后这里会给出建议尺码。
            </p>
          ) : footLength === null ? (
            <p className="text-sm text-destructive">
              请输入 {MIN_FOOT_LENGTH_CM}–{MAX_FOOT_LENGTH_CM} 之间的数字
              （cm）。
            </p>
          ) : suggestion ? (
            <p className="text-sm">
              建议尺码：
              <span className="ml-1 text-lg font-bold tabular-nums">
                {suggestion.suggestedSize}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                偏码请参考评价
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              这个分类还没有匹配的尺码，偏码请参考评价。
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
