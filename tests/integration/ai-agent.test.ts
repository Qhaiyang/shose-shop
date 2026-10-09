import { beforeEach, describe, expect, it } from "vitest"

import { runOrderAgent } from "@/lib/ai/agent"
import type { AiClient, AiMessage, AiResponse, AiTool } from "@/lib/ai/client"
import { createOrderFromCart } from "@/lib/orders"
import { addToCart, makeShop, resetDb, resetSeq } from "./helpers/db"

// ============================================================================
// Agent 循环 —— 集成测试
//
// 【模型是假的，库是真的】
// 和 Stripe 那边一模一样的分工：真库 + mock 掉那个「要花钱、要联网、
// 结果还不稳定」的外部依赖。这里 mock 的是 AiClient —— 喂一段**写死的
// 剧本**（第 1 步说「我要调 listMyOrders」，第 2 步说「这是我的回答」），
// 看这个循环能不能正确地把工具跑一遍、把结果接回对话。
//
// 【为什么这样测是有效的，而不是「自欺欺人」】
// 这个文件的被测对象是**循环本身**（消息怎么拼、结果怎么回填、轮数怎么
// 封顶），不是模型有多聪明。模型的聪明程度本来就不可测 —— 但「工具调用
// 的结果有没有被正确塞回 role:"tool" 那条消息」是完全可以测的，
// 而且一旦拼错，接口会直接报错。这就是注入边界买到的东西。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

const ADDRESS = "北京市朝阳区测试路 1 号"
const PHONE = "13800138000"

/**
 * 一个按剧本回答的假 AiClient。
 *
 * 剧本用完之后一直重复最后一条 —— 这样「模型陷进循环里出不来」
 * 那个用例只要给一条永远返回工具调用的剧本就行，不用堆一长串。
 */
function scriptedClient(script: AiResponse[]) {
  const seen: { messages: AiMessage[]; tools: AiTool[] }[] = []
  let step = 0

  const client: AiClient = {
    async chat(req) {
      // 必须深拷一份：循环会继续往 messages 里 push，
      // 存引用的话，回头看第 1 步的 messages 会看到第 3 步的样子
      seen.push(structuredClone(req))
      const response = script[Math.min(step, script.length - 1)]
      step += 1
      return response
    },
  }

  return { client, seen }
}

const callListMyOrders: AiResponse = {
  kind: "tool_calls",
  calls: [{ id: "call_1", name: "listMyOrders", arguments: {} }],
}

describe("runOrderAgent：循环本身", () => {
  it("模型直接回答（不调工具）→ 一步结束，toolsUsed 为空", async () => {
    const { client, seen } = scriptedClient([{ kind: "text", text: "你好" }])

    const reply = await runOrderAgent(client, "u_whatever", [], "在吗")

    expect(reply.text).toBe("你好")
    expect(reply.toolsUsed).toEqual([])
    // 只问了一次模型
    expect(seen).toHaveLength(1)
  })

  it("模型先要工具、再回答 → 工具真的查了库，结果被拼进 role:\"tool\" 那条消息", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 1)
    const created = await createOrderFromCart(userId, {
      address: ADDRESS,
      phone: PHONE,
    })
    // 用 if 收窄而不是 expect(created.ok).toBe(true) —— 后者在运行时能用，
    // 但 tsc 不认，两个 union 分支上的 orderNo 取不到
    if (!created.ok) throw new Error(`下单失败：${created.error}`)

    const { client, seen } = scriptedClient([
      callListMyOrders,
      { kind: "text", text: "你有一笔待支付的订单。" },
    ])

    const reply = await runOrderAgent(client, userId, [], "我的单到哪了")

    expect(reply.text).toBe("你有一笔待支付的订单。")
    expect(reply.toolsUsed).toEqual(["listMyOrders"])
    expect(seen).toHaveLength(2)

    // 第二次请求带上去的应该是四段：system / user / assistant(发起调用) / tool(结果)
    const second = seen[1].messages
    expect(second.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ])

    // assistant 那条必须原样带上下它发起的调用 —— 少了它，
    // 后面的 tool 消息就没有「发起方」，接口会直接报错
    expect(second[2].toolCalls).toEqual([
      { id: "call_1", name: "listMyOrders", arguments: {} },
    ])

    // tool 那条必须带上同一个 id，且内容是**真的查过库**的结果
    expect(second[3].toolCallId).toBe("call_1")
    const payload = JSON.parse(second[3].content) as {
      ok: boolean
      data: { orders: { orderNo: string }[] }
    }
    expect(payload.ok).toBe(true)
    expect(payload.data.orders).toHaveLength(1)
    expect(payload.data.orders[0].orderNo).toBe(created.orderNo)
  })

  it("模型报了个不存在的工具名 → 回一句「没有这个工具」，不崩、不中断循环", async () => {
    const { client, seen } = scriptedClient([
      {
        kind: "tool_calls",
        calls: [{ id: "call_9", name: "deleteAllOrders", arguments: {} }],
      },
      { kind: "text", text: "这个我做不了。" },
    ])

    const reply = await runOrderAgent(client, "u_whatever", [], "帮我删掉所有订单")

    expect(reply.text).toBe("这个我做不了。")
    expect(reply.toolsUsed).toEqual(["deleteAllOrders"])

    const payload = JSON.parse(seen[1].messages.at(-1)!.content) as {
      ok: boolean
      error: string
    }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain("deleteAllOrders")
  })

  it("模型陷进「一直要调工具」的循环 → 到上限就收手，返回兜底话术而不是挂死", async () => {
    // 剧本只有一条，会被一直重复 —— 相当于模型永远不开口回答
    const { client } = scriptedClient([callListMyOrders])

    const reply = await runOrderAgent(client, "u_whatever", [], "我的单到哪了")

    expect(reply.text).toContain("稍后")
    expect(reply.toolsUsed).toHaveLength(5) // MAX_STEPS
  })

  it("userId 从头到尾不出现在喂给模型的消息里", async () => {
    const { userId, sku } = await makeShop({ price: 89900, stock: 10 })
    await addToCart(userId, sku.id, 1)
    await createOrderFromCart(userId, { address: ADDRESS, phone: PHONE })

    const { client, seen } = scriptedClient([
      callListMyOrders,
      { kind: "text", text: "查到了。" },
    ])

    await runOrderAgent(client, userId, [], "我的单到哪了")

    // 这是越权防线在这里的形态：模型根本不知道 userId 是什么，
    // 所以它不可能改它、也不可能把它说给用户听
    for (const request of seen) {
      expect(JSON.stringify(request.messages)).not.toContain(userId)
    }
  })
})

describe("runOrderAgent：历史", () => {
  it("带历史时，历史原样排在 system 之后，返回值里接上了本轮", async () => {
    const { client, seen } = scriptedClient([{ kind: "text", text: "在的。" }])

    const reply = await runOrderAgent(
      client,
      "u_whatever",
      [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
      ],
      "我的单到哪了",
    )

    expect(seen[0].messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ])
    expect(reply.history).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
      { role: "user", content: "我的单到哪了" },
      { role: "assistant", content: "在的。" },
    ])
  })
})
