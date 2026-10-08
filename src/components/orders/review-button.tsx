"use client"

import { useState, useTransition, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Loader2, MessageSquarePlus, Star } from "lucide-react"
import { toast } from "sonner"

import { createReviewAction } from "@/app/actions/review"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  RATING_LABEL,
  RATING_VALUES_DESC,
  REVIEW_MAX_CONTENT,
  REVIEW_MAX_IMAGES,
  REVIEW_MIN_CONTENT,
} from "@/lib/reviews"
import { cn } from "@/lib/utils"

// ============================================================================
// 「去评价」按钮 + 展开后的评价表单（客户端）
//
// 【为什么不做成弹窗】
// shadcn 的 Dialog 是基于 Portal 的浮层，在 Server Component 渲染出来的
// 订单列表里嵌一个浮层，会带来焦点管理、滚动锁定、SSR 水合一堆额外问题。
// 而这个表单只有三个字段，就地展开（点「去评价」在那一行下面铺开）
// 交互更直接，代码也少一半。多一个浮层并不会让体验更好。
//
// 【为什么用 useTransition 而不是 useActionState】
// 和 PayButton 一个理由：成功之后要 toast + 关掉表单 + router.refresh()，
// 这套「成功后做几件事」的流程用普通函数最自然。
// useActionState 是为「失败后要把用户填的内容渲染回去」设计的，
// 而这里失败了表单还开着，内容一个字都没丢。
//
// 【星级为什么用 state 而不是表单字段】
// 五个星形按钮不是原生 input，靠 state 记住选了第几颗。
// 提交时再把它塞进一个 hidden input —— 这样 FormData 里就是完整的
// 「星级 + 内容 + 图片」，action 那边不用为星级开一个特殊通道。
// ============================================================================

export function ReviewButton({ orderItemId }: { orderItemId: string }) {
  const [open, setOpen] = useState(false)
  const [rating, setRating] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    // 星级没选就别发请求了。HTML 的 required 管不了 hidden input，
    // 所以这条只能自己拦。服务端也会再拦一次（reviewSchema）
    if (rating === null) {
      setError("请先选择星级")
      return
    }

    // 【为什么要在这里就把 FormData 取出来】
    // 下面是个异步闭包，等它跑起来时事件早就派发完了，
    // event.currentTarget 会变成 null。趁现在把表单快照拿出来
    const formData = new FormData(event.currentTarget)
    setError(null)

    startTransition(async () => {
      const result = await createReviewAction(formData)

      if (!result.ok) {
        // 失败的原因是「已经评过了」「订单还没完成」这类 —— 用户手上的
        // 页面数据已经过时了，刷新一下让他看到真实状态
        setError(result.error)
        router.refresh()
        return
      }

      toast.success("评价已提交", { description: "感谢你的分享，它会帮到后面的人" })
      setOpen(false)
      setRating(null)
      // 让服务端组件重跑：这里显示「已评价」，详情页的评价区多一条
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <MessageSquarePlus className="size-4" />
        去评价
      </Button>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full space-y-3 rounded-lg border bg-muted/30 p-4 text-left"
    >
      <input type="hidden" name="orderItemId" value={orderItemId} />
      {/* 星级的真实载体。value 用 ?? "" 是因为 hidden input 不接受 null */}
      <input type="hidden" name="rating" value={rating ?? ""} />

      <div className="space-y-2">
        <Label>评分</Label>
        <div className="flex items-center gap-1">
          {/* 展示顺序是 1→5，和分布图那种 5→1 的排序相反 ——
              这里是「点第几颗」的选择器，从左到右递增才是直觉 */}
          {[...RATING_VALUES_DESC].reverse().map((value) => {
            const active = rating !== null && value <= rating
            return (
              <button
                key={value}
                type="button"
                onClick={() => setRating(value)}
                // 星形按钮没有文字，aria-label 就是它的可读名字。
                // 顺带也是 Playwright 定位它的唯一方式
                aria-label={`${value} 星`}
                aria-pressed={rating === value}
                className="rounded p-0.5 transition-colors hover:text-amber-500"
              >
                <Star
                  className={cn(
                    "size-5",
                    active
                      ? "fill-amber-400 text-amber-500"
                      : "text-muted-foreground",
                  )}
                />
              </button>
            )
          })}

          <span className="ml-1 text-sm text-muted-foreground">
            {rating === null ? "请选择" : `${rating} 星 · ${RATING_LABEL[rating]}`}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`review-content-${orderItemId}`}>评价</Label>
        <Textarea
          id={`review-content-${orderItemId}`}
          name="content"
          rows={3}
          required
          minLength={REVIEW_MIN_CONTENT}
          maxLength={REVIEW_MAX_CONTENT}
          placeholder="鞋码偏不偏、脚感怎么样、做工如何……写点对后来人有用的"
        />
        <p className="text-xs text-muted-foreground">
          至少 {REVIEW_MIN_CONTENT} 个字，最多 {REVIEW_MAX_CONTENT} 个字
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`review-images-${orderItemId}`}>
          图片链接（可选）
        </Label>
        <Textarea
          id={`review-images-${orderItemId}`}
          name="images"
          rows={2}
          // 和后台商品表单同一套「一行一个路径」的写法 ——
          // 学习项目不引入对象存储，上传通道就不做了
          placeholder={`每行一个图片地址，最多 ${REVIEW_MAX_IMAGES} 个`}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending} className="gap-1.5">
          {pending && <Loader2 className="size-4 animate-spin" />}
          {pending ? "提交中…" : "提交评价"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setOpen(false)
            setRating(null)
            setError(null)
          }}
        >
          取消
        </Button>
      </div>
    </form>
  )
}
