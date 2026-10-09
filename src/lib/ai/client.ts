// ============================================================================
// AiClient：注入边界（对应 getStripe()）
//
// 【为什么这里多包一层，而不是像 Stripe 那样直接注入 vendor 对象】
// Stripe 敢直接注入原始 `Stripe` 类型，是因为它的返回（PaymentIntent）已经是
// 干净的领域对象，`.status` / `.client_secret` 直接读。DeepSeek 的原始返回不是——
// 是 choices[0].message 的嵌套，而且 tool_calls[].function.arguments 是个
// JSON 字符串。所以把「vendor 的脏形状」锁死在这一个文件里，对外只暴露
// 一个 chat() 和一份干净的返回。测试和 agent 都看不到 choices[0] 那坨。
//
// 【为什么用裸 fetch，不引 openai SDK】
// DeepSeek 的 API 是 OpenAI 兼容的，本质就是一个 POST /chat/completions。
// 30 行 fetch 能搞定的事，不引一个几百 KB、还把手线格式藏起来的依赖。
// 和「自己用 jose 签 JWT、不上 NextAuth」是同一个理由：学习项目要看得见每一步。
//
// 【DEEPSEEK_API_KEY 为什么绝不能加 NEXT_PUBLIC_ 前缀】
// 带 NEXT_PUBLIC_ 的变量会被打进浏览器 bundle。这个是服务端密钥，
// 只让 Server Action 侧读到；本文件只可能被服务端代码 import。
// ============================================================================

export type AiRole = "system" | "user" | "assistant" | "tool"

export type AiToolCall = {
  id: string
  name: string
  /** 已 JSON.parse 好的参数对象；agent 拿它过 zod */
  arguments: unknown
}

export type AiMessage = {
  role: AiRole
  content: string
  /** 仅 role === "tool" 时用：回给哪一次工具调用 */
  toolCallId?: string
  /** 仅 role === "assistant" 且那次发起了工具调用时用 */
  toolCalls?: AiToolCall[]
}

export type AiTool = {
  name: string
  description: string
  /** JSON Schema（zod 转出来的），原样喂给 DeepSeek */
  parameters: Record<string, unknown>
}

export type AiResponse =
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; calls: AiToolCall[] }

export type AiClient = {
  chat(req: { messages: AiMessage[]; tools: AiTool[] }): Promise<AiResponse>
}

const DEEPSEEK_BASE = "https://api.deepseek.com"
const DEEPSEEK_MODEL = "deepseek-chat"

// vendor 响应里我们只读这几个字段，其余一概不碰，所以类型只声明读到的部分
type DeepSeekMessage = {
  content?: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}
type DeepSeekResponse = { choices?: { message?: DeepSeekMessage }[] }

// 我们的形状 → 线上格式。role:tool 要带 tool_call_id，
// assistant 发起的工具调用要原样带回去（多轮对话靠它对齐）
function toWireMessage(m: AiMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.toolCallId) wire.tool_call_id = m.toolCallId
  if (m.toolCalls) {
    wire.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }))
  }
  return wire
}

function toWireTool(t: AiTool): Record<string, unknown> {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }
}

export function getAiClient(): AiClient {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY（写进 .env，别写进命令行参数或代码）")
  }

  return {
    async chat({ messages, tools }) {
      const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: messages.map(toWireMessage),
          tools: tools.length > 0 ? tools.map(toWireTool) : undefined,
        }),
      })

      if (!res.ok) {
        throw new Error(`DeepSeek 请求失败：${res.status} ${await res.text()}`)
      }

      const data = (await res.json()) as DeepSeekResponse
      const msg = data.choices?.[0]?.message
      if (!msg) {
        throw new Error(
          `DeepSeek 返回里没有 message：${JSON.stringify(data).slice(0, 200)}`,
        )
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          kind: "tool_calls",
          calls: msg.tool_calls.map((c) => ({
            id: c.id,
            name: c.function.name,
            arguments: JSON.parse(c.function.arguments),
          })),
        }
      }

      return { kind: "text", text: msg.content ?? "" }
    },
  }
}
