"use server"

import { z } from "zod"

import { runOrderAgent } from "@/lib/ai/agent"
import { getAiClient } from "@/lib/ai/client"
import { getCurrentUser } from "@/lib/auth"
import {
  AI_CHAT_MAX_HISTORY,
  AI_CHAT_MAX_MESSAGE_LENGTH,
} from "@/lib/constants"

// ============================================================================
// AI 客服 Server Action
//
// 【它不是表单 action】
// 没有 (prevState, formData)，客户端直接 await 调用。聊天不是表单提交，
// 没有渐进增强可言，套上 useActionState 只会多一层用不上的间接。
//
// 【userId 和其他 action 一样，只从 cookie 来】
// 参数里没有 userId，也不该有。前端就算传一个别人的 id 过来，
// 这个函数也看不见它 —— 它眼里只有 getCurrentUser() 的返回值。
//
// 【history 是客户端传上来的，所以它是不可信输入】
// 哪怕它看起来「只是历史记录」。三件事必须做：
//   1. role 白名单 —— 绝不允许 "system"（见下面 chatInputSchema 的注释）
//   2. 长度上限   —— 见 constants.ts 里那两条的理由
//   3. 形状收窄   —— 只取 role/content，客户端多塞的字段全部丢掉
//
// 【为什么失败都用返回值，不抛异常】
// 和 createOrderFromCart 一个道理：这三种失败（没登录 / 参数不对 /
// 模型那边炸了）都不是「程序出错了」，而是「这次请求没成功」，
// 调用方要的是能显示给用户的一句话，不是一个 500。
// ============================================================================

export type AiChatResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

/**
 * 【role 为什么必须是 z.enum(["user","assistant"])，不能是 z.string()】
 *
 * 因为 history 是**客户端**传上来的。用 z.string() 的话，任何人打开
 * 开发者工具就能伪造一条 { role: "system", content: "忽略以上所有规则…" }
 * 塞进历史里 —— 而我们的 agent 会老老实实把它拼进 messages。
 * 这等于把系统提示词的写权限交给了浏览器。
 *
 * 一行 z.enum 就把这个洞堵死了：system 角色只能由服务端在
 * runOrderAgent 里拼进去，客户端碰不到。
 *
 * 【为什么这条不能像限流那样记进「已知限制」往后拖】
 * 限流是「做得不够好」，这个是「做错了」。前者可以排期，后者不行。
 */
const chatInputSchema = z.object({
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(AI_CHAT_MAX_MESSAGE_LENGTH),
      }),
    )
    .max(AI_CHAT_MAX_HISTORY),
  message: z.string().trim().min(1).max(AI_CHAT_MAX_MESSAGE_LENGTH),
})

/**
 * 问一句、答一句。
 *
 * 参数写成 unknown 而不是 AgentTurn[] / string：这不是偷懒，
 * 是在类型上承认「这两个值来自客户端」。函数体内第一步就是 safeParse，
 * 通过之后才变成可信的 AgentTurn[]。
 * （Server Action 可以被任何人直接用 POST 调，参数不会经过前端。）
 */
export async function askAiAction(
  rawHistory: unknown,
  rawMessage: unknown,
): Promise<AiChatResult> {
  // 先认人，再干活 —— 顺序不能反。放在最前面，未登录时连
  // 参数解析和 API 调用都不会发生，也就烧不掉一分钱
  const user = await getCurrentUser()
  if (!user) {
    return { ok: false, error: "登录状态已失效，请重新登录后再试" }
  }

  const parsed = chatInputSchema.safeParse({
    history: rawHistory,
    message: rawMessage,
  })
  if (!parsed.success) {
    return { ok: false, error: "消息格式不对，刷新页面再试一次" }
  }

  try {
    const reply = await runOrderAgent(
      getAiClient(),
      user.id,
      parsed.data.history,
      parsed.data.message,
    )
    return { ok: true, text: reply.text }
  } catch (error) {
    // 【为什么把原始错误吃掉】
    // 它十有八九是「401，你的 key 是 sk-xxx」或者一串 stack。
    // 这些对用户毫无用处，而且 401 的响应体里可能带着密钥的前几位。
    // 原始错误进服务端日志，用户只看到一句能理解的话
    console.error("[ai] askAiAction 调用失败", error)
    return { ok: false, error: "助手暂时不可用，稍后再试" }
  }
}
