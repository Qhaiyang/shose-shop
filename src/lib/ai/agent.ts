// ============================================================================
// agent.ts：把「一次问答」拆成「模型想了想 → 调工具 → 看结果 → 再说」
//
// 【它到底在循环什么】
// 模型自己不会查库。它只会说两种话：要么「我想调 listMyOrders」，
// 要么「这是我的回答」。这个循环就是：把它要调的工具真跑一遍，
// 把结果塞回对话，再问它一次 —— 直到它开口回答。
//
//   用户问 → 模型：调 listMyOrders → 我们查库 → 结果塞回去
//          → 模型：调 getOrderDetail → 我们查库 → 结果塞回去
//          → 模型：你有一单还没付款……
//
// 【为什么 client 是参数而不是在函数里 getAiClient()】
// 和 createPaymentIntentForOrder(stripe, ...) 一样：生产传真的，
// 测试传 mock 的。测试就能在不花一分钱、不联网的情况下把整条链路跑通
// （包括「模型第一次要调工具、第二次才回答」这个多步过程）。
//
// 【为什么 userId 只在这里出现一次】
// 它是从参数进来的，被闭包带进每个 executors 调用，但**从不写进 messages**。
// 也就是说模型永远看不到它，也就永远不可能改它、或者把它说给用户听。
// 越权防线在这里的表现形式就是：userId 根本不在模型的世界里。
// ============================================================================

import { getAiClient, type AiClient, type AiMessage, type AiTool } from "./client"
import {
  executeGetOrderDetail,
  executeListMyOrders,
  getOrderDetailTool,
  listMyOrdersTool,
  type ToolResult,
} from "./tools"

/** 多轮对话里保存的一轮。只存人看得懂的内容，工具调用不留在历史里 */
export type AgentTurn = { role: "user" | "assistant"; content: string }

export type AgentReply = {
  /** 直接说给用户听的那段话 */
  text: string
  /** 这一轮按顺序调了哪些工具。出问题时先看它，比看日志快 */
  toolsUsed: string[]
  /** 把这一轮接上去之后的历史，下次接着聊就传它 */
  history: AgentTurn[]
}

// ============================================================================
// 系统提示词
//
// 这里每一句都是被某一种真实错觉逼出来的：
//
//   规则 1、3 防「编」——  模型没有订单记忆，不给它这条，它会根据
//                         「一般三天到」这种常识编一个答案出来，而且说得
//                         比真话还像真话。这是最难发现的一类错：格式全对。
//   规则 2    防「加工」—— 金额、时间、状态我们都已经在 tools.ts 里转成
//                         最终形态了，再让它换算一次就是画蛇添足，而且
//                         它换算的方式不可控（见 tools.ts 的设计点 1）。
//   规则 5    防「穿帮」—— 模型天然倾向把内部标识符念出来（"订单
//                         clyx8f2a..."），用户看不懂，还看着像出了 bug。
//   规则 6    防「解释」—— 查不到时它爱补一句原因（"可能是网络问题"），
//                         那是它编的。查不到就是查不到。
// ============================================================================

const SYSTEM_PROMPT = `你是「鞋栈」小店的订单客服助手，只负责回答和**当前登录用户自己的订单**有关的问题。

## 你会用的工具
- listMyOrders：查这个用户的订单列表，可以按状态筛。
- getOrderDetail：查某一单的详情（买了什么、金额、寄到哪、备注、各节点时间）。

## 铁律

1. **所有事实都必须来自工具返回的结果。**
   你不记得任何订单，也不知道任何单号、金额、地址、时间。凡是涉及用户订单的问题，
   你必须先调工具；没有工具结果，就说你不知道。

2. **工具返回什么就说什么，一个字都不要加工。**
   金额已经是格式化好的字符串（比如 "¥899.00"），原样念出来，不要换算、不要四舍五入、
   不要换算成"899 元"以外的任何写法。时间同理，不要改格式、不要算时差。
   状态是中文的（"待支付"），不要翻译回英文。

3. **绝不推测、绝不编造。**
   不要说"应该已经发货了"、"大概两三天到"、"估计明天到"这类话。
   工具结果里没有的信息，就直接说"这个我这边看不到"。

4. **只能查当前用户自己的订单。**
   你没有办法查别人的订单，也不要尝试。如果用户要你查别人的订单，
   就告诉他你只能查他自己的。

5. **不要暴露内部细节。**
   不要提工具的名字、不要提字段名、不要念订单 id（那串像 "clx8f2a..." 的东西）。
   对用户来说，这是人和人在对话，不是接口调试。

6. **查不到就直说查不到。**
   工具返回空列表或者空结果，那就是"没有"。说"你没有订单"或者"没找到这一单"。
   不要猜原因，不要反复道歉，不要建议用户"稍后重试"。

## 说话方式

- 中文，简短。一两句能说完就别写三段 —— 用户是在问事情，不是在看说明书。
- 用"你"称呼用户，语气自然，别像机器人。
- 金额、时间、单号这类具体信息必须准确，拿不准就少说。
- 用户问了和订单无关的事（商品推荐、退换货规则、闲聊），一句话说明你只管订单相关的事，
  然后把话题拉回来。`

// ============================================================================
// 工具注册表
//
// 声明和实现分开存放，靠名字对上：
//   - TOOLS 是喂给模型的（名字、说明、参数 schema）
//   - EXECUTORS 是我们这边的实现（拿 userId + 参数，去查库）
//
// 【为什么要显式对名字，而不是用一个数组装 {declaration, execute}】
// 因为模型只知道名字。它回来的是一个**字符串**，必须能在注册表里查到；
// 查不到要走「没有这个工具」这条路，而不是崩掉。用对象当表，这一步是
// 一次平凡的下标查找，不是一段需要维护的匹配逻辑。
// ============================================================================

const TOOLS: AiTool[] = [listMyOrdersTool, getOrderDetailTool]

const EXECUTORS: Record<
  string,
  (userId: string, input: unknown) => Promise<ToolResult>
> = {
  listMyOrders: executeListMyOrders,
  getOrderDetail: executeGetOrderDetail,
}

/**
 * 最多来回几轮。
 *
 * 【为什么必须有这个上限，而不是 while(true)】
 * 模型有可能陷进「再查一次、再查一次」的循环里出不来（尤其是工具一直返回
 * 同一个它不理解的空结果时）。没有上限就是一个能烧光额度、挂死请求的 bug。
 * 真实客服对话两三轮就结束了，5 是留了余量的值。
 */
const MAX_STEPS = 5

/** 循环用完还没等到回答时的兜底话术 */
const FALLBACK_TEXT = "抱歉，这个我这边一时查不清楚，你稍后再问我一次吧。"

// ============================================================================
// 主循环
// ============================================================================

export async function runOrderAgent(
  client: AiClient,
  userId: string,
  history: AgentTurn[],
  userMessage: string,
): Promise<AgentReply> {
  const messages: AiMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: userMessage },
  ]

  const toolsUsed: string[] = []

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.chat({ messages, tools: TOOLS })

    // 模型开口回答了 —— 循环结束
    if (response.kind === "text") {
      return {
        text: response.text,
        toolsUsed,
        history: [
          ...history,
          { role: "user", content: userMessage },
          { role: "assistant", content: response.text },
        ],
      }
    }

    // 模型要调工具。先把「助手发起了这些调用」记进对话 ——
    // 不记这一步，下一轮回来的 tool 消息就没有对应的发起方，
    // 接口会直接报错（tool 消息必须跟在发起它的 assistant 消息后面）
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: response.calls,
    })

    // 逐个执行。这里用 for 而不是 Promise.all：工具的执行结果要按
    // 模型给的顺序回给它，而且将来如果两个工具之间有依赖（先列表拿 id
    // 再查详情），并行会直接错。数量本来就是个位数，不值得为此引入并发
    for (const call of response.calls) {
      toolsUsed.push(call.name)

      const execute = EXECUTORS[call.name]
      const result: ToolResult = execute
        ? await execute(userId, call.arguments)
        : { ok: false, error: `没有名为 ${call.name} 的工具` }

      messages.push({
        role: "tool",
        content: JSON.stringify(result),
        toolCallId: call.id,
      })
    }
  }

  // 走到这里说明来回超过 MAX_STEPS 还没收敛。不抛异常：
  // 对话已经进行了一半，用户该看到一句人话，而不是一个 500
  return {
    text: FALLBACK_TEXT,
    toolsUsed,
    history: [
      ...history,
      { role: "user", content: userMessage },
      { role: "assistant", content: FALLBACK_TEXT },
    ],
  }
}

/** 单轮入口：不带历史地问一句。脚本和第一次对话用这个就够了 */
export function askOrderAgent(
  userId: string,
  userMessage: string,
  client: AiClient = getAiClient(),
): Promise<AgentReply> {
  return runOrderAgent(client, userId, [], userMessage)
}
