"use client"

import { useState, useTransition } from "react"
import { Loader2, Pencil, StickyNote } from "lucide-react"
import { toast } from "sonner"

import { updateOrderNoteAction } from "@/app/actions/order"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ORDER_NOTE_MAX_LENGTH } from "@/lib/constants"

// ============================================================================
// 订单备注卡片（买家视角）
//
// 【两种状态】
//   - 可编辑（待支付 / 已支付）：显示原文 + 「修改」按钮，点开变成 textarea
//   - 只读（已发货 / 已完成 / 已取消）：只显示原文，没有按钮
//
// 【为什么 editable 由外面传进来，而不是在这个组件里判断状态】
// 「哪个状态能改」是业务规则，定义在 src/lib/constants.ts 的
// isNoteEditable。它是纯函数，服务端算一次就够了 ——
// 客户端再算一遍就意味着规则有两个副本，迟早会分叉。
// 这个组件只负责「画出来」和「调 action」。
//
// 【为什么改完不需要 router.refresh()】
// 和 FavoriteButton 一样：新的备注就在组件自己的 state 里，
// 这一页别的地方（状态徽章、商品清单、时间轴）都不会因为一句备注而变。
// 服务端那边确实 revalidatePath 了，但那是给**后台**那一页用的 ——
// 管理员打开订单详情时得看到最新那句交代。
// ============================================================================

type OrderNoteCardProps = {
  orderId: string
  /** 服务端归一化过的备注：没写就是 null */
  initialNote: string | null
  /** 这个状态下还允许改吗（isNoteEditable 的结果，服务端算好） */
  editable: boolean
  /** 状态中文名，只用来拼「订单已发货，备注不能再改了」这句话 */
  statusLabel: string
}

export function OrderNoteCard({
  orderId,
  initialNote,
  editable,
  statusLabel,
}: OrderNoteCardProps) {
  const [note, setNote] = useState(initialNote)
  // 编辑态里那份「还没保存的草稿」。单独存是因为用户可能点了修改、
  // 改了一半又取消 —— 取消时要把草稿丢掉、回到 note
  const [draft, setDraft] = useState(initialNote ?? "")
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function openEditor() {
    // 每次重新打开都从「已保存的内容」起草，
    // 而不是接着上次取消时留下的那半句话
    setDraft(note ?? "")
    setError(null)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setError(null)
  }

  function save() {
    // 先把草稿取出来：它在 startTransition 的异步回调里是个闭包，
    // 单独存一份局部常量，下面用的是哪一份就一目了然
    const next = draft

    startTransition(async () => {
      const result = await updateOrderNoteAction(orderId, next)

      if (!result.ok) {
        // 最常见的失败是「打开页面的时候还没发货，点保存时已经发了」——
        // 这不是 bug，是状态真的变了，所以原样把服务端的话显示出来
        setError(result.error)
        return
      }

      // 【这里自己再归一化一次，是故意的重复吗？不是】
      // 服务端 orderNoteSchema 已经做过同样的事，但它的结果没有回来
      // （action 只返回 ok/error）。在客户端重做一遍这个「trim 后为空
      // 就是 null」的规则，是为了让本地 state 和服务端存的东西一致 ——
      // 否则用户清空备注后，这里显示的空状态和数据库里的 NULL 对不上，
      // 下次刷新会跳一下
      const saved = next.trim() === "" ? null : next.trim()
      setNote(saved)
      setDraft(saved ?? "")
      setEditing(false)
      setError(null)
      toast.success(saved === null ? "备注已清空" : "备注已保存", {
        description: "打包的同事会看到这句话",
      })
    })
  }

  return (
    <div className="mt-6 space-y-3 rounded-xl border p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 font-medium">
          <StickyNote className="size-4 text-muted-foreground" />
          订单备注
        </h2>

        {editable && !editing && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1"
            onClick={openEditor}
          >
            <Pencil className="size-3.5" />
            {note ? "修改" : "添加"}
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <Label htmlFor="order-note" className="sr-only">
            订单备注
          </Label>
          <Textarea
            id="order-note"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            // maxLength 是体验优化（别让人白写一堆再被打回来），
            // 真正的上限在服务端，前端限制随手就能绕过
            maxLength={ORDER_NOTE_MAX_LENGTH}
            placeholder="例如：请工作日送达、放门口快递柜"
            aria-invalid={!!error}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={pending}
              className="gap-1.5"
            >
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {pending ? "保存中…" : "保存"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancel}
              disabled={pending}
            >
              取消
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {draft.length} / {ORDER_NOTE_MAX_LENGTH}
            </span>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : note ? (
        // whitespace-pre-wrap：备注里的换行是用户有意敲的，不能压成一行
        <p className="whitespace-pre-wrap text-muted-foreground">{note}</p>
      ) : (
        <p className="text-muted-foreground">
          {editable
            ? "还没有备注。有什么要交代的可以写在这里，打包的同事会看到。"
            : "这笔订单没有备注。"}
        </p>
      )}

      {/* 只读、而且**确实写了备注**时，说明一句为什么改不了了。
          不说的话，用户会以为是页面出了问题、找不到编辑入口 */}
      {!editable && note && (
        <p className="text-xs text-muted-foreground">
          订单{statusLabel}，备注不能再修改。还有要交代的请联系客服。
        </p>
      )}
    </div>
  )
}
