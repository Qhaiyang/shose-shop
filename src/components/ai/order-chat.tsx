"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, MessageCircle, Send } from "lucide-react"

import { askAiAction } from "@/app/actions/ai"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AI_CHAT_MAX_HISTORY,
  AI_CHAT_MAX_MESSAGE_LENGTH,
} from "@/lib/constants"

// ============================================================================
// 订单助手悬浮球（客户端）
//
// 【未登录时这个组件根本不会被渲染】
// 判断在 src/app/layout.tsx 里做（那边是服务端，本来就已经拿到了 user）。
// 这样做省掉了一整类 UI 分支，但**不能**因此就在服务端放行 ——
// Server Action 有一个稳定的 action id，可以被任何人直接 POST 调，
// 不看这个组件渲染没渲染。UI 这层是「不给用户添堵」，action 那层才是防线。
//
// 【输入框为什么是非受控的】
// 和结算表单同一套做法：不把每敲一个字都灌进 React state。
// 提交时从 FormData 里读一次，成功后再 form.reset() 清空。
// 聊天框本来也不需要「边打字边做别的事」，受控没有收益。
//
// 【为什么没有流式】
// 一期就是「发出去 → 等一句话回来」。所以那段「正在查你的订单…」
// 不是装饰：一次请求要等两次工具调用往返，3–10 秒很正常，
// 没有这句提示用户会以为界面卡死了。
// ============================================================================

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
}

const GREETING = "你好，我是订单助手。可以问我「我的单到哪了」。"

export function OrderChat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 【为什么防重复提交用的是 ref 不是 pending】
   * pending 是 state，进不了本次事件处理函数的闭包 —— 用户连按两下时，
   * 第二次回调读到的还是 false。ref 是同步的，立刻就能挡住。
   * 这和「非渲染值别进 state」是同一条规矩的另一面。
   *
   * （按钮的 disabled={pending} 是给用户看的，不是防线。）
   */
  const submitting = useRef(false)
  const endRef = useRef<HTMLDivElement>(null)

  // 新消息进来、或者「正在查」出现时，把视口带到底部。
  // 这里是直接写 DOM，不 setState —— 在 effect 里同步 setState 会被 lint 拦
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [messages, pending, open])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return

    const form = event.currentTarget
    const text = String(new FormData(form).get("message") ?? "").trim()
    if (text === "") return

    submitting.current = true

    // 先把用户这句显示出来 —— 别等服务器回复才显示，那样点一下像没反应
    const withUser: ChatMessage[] = [
      ...messages,
      { id: crypto.randomUUID(), role: "user", content: text },
    ]
    setMessages(withUser)
    setPending(true)
    setError(null)
    form.reset()

    // 发给服务端的是「这句话之前」的历史，最多带最近 AI_CHAT_MAX_HISTORY 条。
    // 超出部分在这里砍掉，而不是留给服务端报「历史太长」——
    // 长对话应该继续聊下去，不该突然开始报错
    const history = withUser
      .slice(0, -1)
      .slice(-AI_CHAT_MAX_HISTORY)
      .map(({ role, content }) => ({ role, content }))

    try {
      const result = await askAiAction(history, text)

      if (result.ok) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: result.text },
        ])
      } else {
        // 失败时用户那句话**留在列表里**：他刚打的字不能凭空消失。
        // 错误显示在下面，他可以直接再问一次
        setError(result.error)
      }
    } finally {
      setPending(false)
      submitting.current = false
    }
  }

  return (
    <>
      {open && (
        <div
          className="fixed right-4 bottom-20 z-50 flex h-[26rem] w-[min(22rem,calc(100vw-2rem))] flex-col rounded-lg border bg-background shadow-lg"
          role="dialog"
          aria-label="订单助手"
        >
          <div className="border-b px-3 py-2 text-sm font-medium">订单助手</div>

          <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
            <p className="text-muted-foreground">{GREETING}</p>

            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "user" ? "flex justify-end" : "flex justify-start"
                }
              >
                <p
                  className={
                    message.role === "user"
                      ? "max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground whitespace-pre-wrap"
                      : "max-w-[85%] rounded-lg bg-muted px-3 py-2 whitespace-pre-wrap"
                  }
                >
                  {message.content}
                </p>
              </div>
            ))}

            {pending && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                正在查你的订单…
              </p>
            )}

            {error && <p className="text-destructive">{error}</p>}

            {/* 滚动锚点：scrollIntoView 打在它身上 */}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 border-t p-3"
          >
            <Input
              name="message"
              maxLength={AI_CHAT_MAX_MESSAGE_LENGTH}
              placeholder="问点什么…"
              autoComplete="off"
              disabled={pending}
            />
            <Button
              type="submit"
              size="icon"
              disabled={pending}
              aria-label="发送"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </form>
        </div>
      )}

      <Button
        type="button"
        size="icon"
        className="fixed right-4 bottom-4 z-50 rounded-full shadow-lg"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "收起订单助手" : "打开订单助手"}
        aria-expanded={open}
      >
        <MessageCircle className="size-5" />
      </Button>
    </>
  )
}
