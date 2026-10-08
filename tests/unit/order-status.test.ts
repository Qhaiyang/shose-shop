import { describe, expect, it } from "vitest"

import {
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TRANSITIONS,
  ORDER_STATUS_VALUES,
  REFUNDABLE_STATUSES,
  canTransition,
  isNoteEditable,
  isRefundable,
  orderStatusSchema,
  shouldRestoreStock,
  type OrderStatus,
} from "@/lib/constants"

// ============================================================================
// 订单状态机 —— src/lib/constants.ts
//
// 状态机是整个项目里最该被测试覆盖的东西：它是**白名单**。
// 白名单的特点是「漏掉一个」比「多一个」危险得多 ——
// 如果 PAID → COMPLETED 被误放进白名单，用户就能跳过发货环节。
// 所以下面既测「该放行的放行」，也测「该拦的拦」。
// ============================================================================

describe("订单状态的枚举本身", () => {
  it("七个状态，值和键一致", () => {
    // 【为什么这条要把整个数组抄一遍，而不是只断言 length === 7】
    // 长度对不上只说明「数量变了」，看不出来变的是哪个。
    // 抄一遍之后，往 ORDER_STATUS 里加/删/改任何一个状态，
    // 这条都会红，而且 diff 里直接看得见是哪一个 ——
    // 状态机的枚举是整个项目里最不该被悄悄改动的东西
    expect(ORDER_STATUS_VALUES).toEqual([
      "PENDING_PAYMENT",
      "PAID",
      "SHIPPED",
      "COMPLETED",
      "CANCELLED",
      "REFUNDING",
      "REFUNDED",
    ])
    expect(ORDER_STATUS.PENDING_PAYMENT).toBe("PENDING_PAYMENT")
  })

  it("每个状态都有中文标签", () => {
    // 漏一个的话页面上会显示 undefined
    for (const status of ORDER_STATUS_VALUES) {
      expect(ORDER_STATUS_LABEL[status]).toBeTruthy()
    }
    expect(ORDER_STATUS_LABEL.PENDING_PAYMENT).toBe("待支付")
    expect(ORDER_STATUS_LABEL.COMPLETED).toBe("已完成")
  })

  it("流转表覆盖了所有状态（没有漏配的状态）", () => {
    // 如果新加一个状态却忘了往流转表里加，
    // canTransition 的 `?? false` 会把它悄悄变成「哪儿都去不了」
    for (const status of ORDER_STATUS_VALUES) {
      expect(ORDER_STATUS_TRANSITIONS[status]).toBeDefined()
      expect(Array.isArray(ORDER_STATUS_TRANSITIONS[status])).toBe(true)
    }
  })

  it("流转表里不会出现未知状态", () => {
    const known = new Set<string>(ORDER_STATUS_VALUES)

    for (const targets of Object.values(ORDER_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(known.has(target)).toBe(true)
      }
    }
  })
})

describe("canTransition —— 合法流转", () => {
  const legal: [OrderStatus, OrderStatus][] = [
    ["PENDING_PAYMENT", "PAID"],
    ["PENDING_PAYMENT", "CANCELLED"],
    ["PAID", "SHIPPED"],
    ["PAID", "CANCELLED"],
    ["SHIPPED", "COMPLETED"],
    // ---- 第 7 步新增 ----
    // 三个「已经收了钱」的状态都能申请退款
    ["PAID", "REFUNDING"],
    ["SHIPPED", "REFUNDING"],
    ["COMPLETED", "REFUNDING"],
    // 批准
    ["REFUNDING", "REFUNDED"],
    // 拒绝：退回申请前的状态。这三条不是「正常流转」，
    // 而是撤销上一次流转 —— 只有 rejectRefund 会走
    ["REFUNDING", "PAID"],
    ["REFUNDING", "SHIPPED"],
    ["REFUNDING", "COMPLETED"],
  ]

  it.each(legal)("%s → %s 允许", (from, to) => {
    expect(canTransition(from, to)).toBe(true)
  })
})

describe("canTransition —— 非法流转", () => {
  it("不能跳过支付直接发货", () => {
    expect(canTransition("PENDING_PAYMENT", "SHIPPED")).toBe(false)
  })

  it("不能跳过发货直接完成", () => {
    expect(canTransition("PENDING_PAYMENT", "COMPLETED")).toBe(false)
    expect(canTransition("PAID", "COMPLETED")).toBe(false)
  })

  it("已发货的订单不能再取消（货已经在路上了）", () => {
    expect(canTransition("SHIPPED", "CANCELLED")).toBe(false)
  })

  it("终态不能再往外流转", () => {
    // 【第 7 步之后终态从两个变成了两个，但成员换了】
    // COMPLETED 曾经是终态，现在不是了 —— 收了货也能退。
    // 现在的终态是 CANCELLED 和 REFUNDED：钱要么没进来，要么已经退出去了，
    // 这两个状态下不该再有下一个动作
    for (const to of ORDER_STATUS_VALUES) {
      expect(canTransition("CANCELLED", to)).toBe(false)
      expect(canTransition("REFUNDED", to)).toBe(false)
    }
  })

  it("已完成的订单只能去退款，不能去别的地方", () => {
    // 【为什么这条要单独写】COMPLETED 从终态变成非终态，是最容易被
    // 「顺手」放行的地方：既然能往外走了，很容易一不小心让
    // COMPLETED → SHIPPED 之类的组合也过。这里把出口钉死成唯一一个
    const allowed = ORDER_STATUS_VALUES.filter((to) => canTransition("COMPLETED", to))
    expect(allowed).toEqual([ORDER_STATUS.REFUNDING])
  })

  it("不能倒退", () => {
    expect(canTransition("PAID", "PENDING_PAYMENT")).toBe(false)
    expect(canTransition("SHIPPED", "PAID")).toBe(false)
    expect(canTransition("COMPLETED", "SHIPPED")).toBe(false)
  })

  it("退款流程不能跳过管理员", () => {
    // 买家只能把订单推进 REFUNDING，推进到 REFUNDED 是**管理员**的动作。
    // 如果这里放行了，买家点一下「申请退款」钱就退回去了
    expect(canTransition("PAID", "REFUNDED")).toBe(false)
    expect(canTransition("SHIPPED", "REFUNDED")).toBe(false)
    expect(canTransition("COMPLETED", "REFUNDED")).toBe(false)
  })

  it("没付钱的订单不能退款", () => {
    // 待支付的订单该走取消（钱还没收），已取消的更没什么可退的
    expect(canTransition("PENDING_PAYMENT", "REFUNDING")).toBe(false)
    expect(canTransition("CANCELLED", "REFUNDING")).toBe(false)
    // 已经在退款流程里的订单不能重复申请
    expect(canTransition("REFUNDING", "REFUNDING")).toBe(false)
    expect(canTransition("REFUNDED", "REFUNDING")).toBe(false)
  })

  it("状态不能原地不动", () => {
    // X → X 必须被拦掉，否则「重复点支付」会被当成一次合法流转
    for (const status of ORDER_STATUS_VALUES) {
      expect(canTransition(status, status)).toBe(false)
    }
  })

  it("非法组合一共就这些 —— 用穷举把白名单钉死", () => {
    // 7 个状态两两组合共 49 种，其中只有 12 种合法。
    // 把全部 49 种都断言一遍，就等于把白名单抄了一份到测试里 ——
    // 以后有人偷偷往流转表里加一条，这里立刻会红。
    //
    // 【为什么这条断言是整份测试里最重要的】
    // 上面那些「该拦的拦」用例只能证明**我想到的**非法组合被拦住了。
    // 这条穷举证明的是「没有别的非法组合能溜过去」——
    // 判据来自这份清单，而清单是人手写的，改它就得在 diff 里过一遍
    const expectedLegal = new Set([
      "PENDING_PAYMENT→PAID",
      "PENDING_PAYMENT→CANCELLED",
      "PAID→SHIPPED",
      "PAID→CANCELLED",
      "SHIPPED→COMPLETED",
      "PAID→REFUNDING",
      "SHIPPED→REFUNDING",
      "COMPLETED→REFUNDING",
      "REFUNDING→REFUNDED",
      "REFUNDING→PAID",
      "REFUNDING→SHIPPED",
      "REFUNDING→COMPLETED",
    ])

    // 自检：清单里每一条都必须是真合法的。写漏、写错一个词
    // 都会让下面那条循环在两边同时出错而"看起来很对"
    for (const pair of expectedLegal) {
      const [from, to] = pair.split("→") as [OrderStatus, OrderStatus]
      expect(canTransition(from, to)).toBe(true)
    }
    expect(expectedLegal.size).toBe(12)

    for (const from of ORDER_STATUS_VALUES) {
      for (const to of ORDER_STATUS_VALUES) {
        expect(canTransition(from, to)).toBe(expectedLegal.has(`${from}→${to}`))
      }
    }
  })

  it("未知状态一律拦掉，不抛异常", () => {
    // 数据库里读出来的 status 是 String，可能是任何脏数据。
    // 这里要的是「安全地返回 false」，而不是让整个页面崩掉
    expect(canTransition("FOO" as OrderStatus, "PAID")).toBe(false)
    expect(canTransition("PENDING_PAYMENT", "FOO" as OrderStatus)).toBe(false)
    expect(canTransition("" as OrderStatus, "" as OrderStatus)).toBe(false)
  })
})

describe("shouldRestoreStock —— 取消订单时要不要还库存", () => {
  it("已扣库存但还没真正卖出去的状态，要还", () => {
    // 下单那一刻就扣了库存，所以只要还没发货，取消就得还回去
    expect(shouldRestoreStock("PENDING_PAYMENT")).toBe(true)
    expect(shouldRestoreStock("PAID")).toBe(true)
  })

  it("货已经在路上的状态，不还", () => {
    // 发货后再取消属于售后问题，不是库存问题 ——
    // 这时候把库存加回去，会让同一件货被卖两次
    expect(shouldRestoreStock("SHIPPED")).toBe(false)
    expect(shouldRestoreStock("COMPLETED")).toBe(false)
    expect(shouldRestoreStock("CANCELLED")).toBe(false)
  })

  it("退款相关的状态在这里一律是 false —— 这个函数管不着退款", () => {
    // 【这条是第 7 步最容易踩的坑，所以专门钉一条】
    // REFUNDING 的订单**最后确实要还库存**（批准退款时），
    // 但那个决定不是这个函数做的 —— 这个函数只回答
    // 「取消订单时要不要还」。批准退款时调用方根本不问它，直接还。
    //
    // 如果哪天有人图省事，在批准退款那里写成
    // `if (shouldRestoreStock(order.status)) ...`，order.status 是
    // REFUNDING，这个函数返回 false，库存就永远还不回去了 ——
    // 而且测试全绿、页面正常，只有仓库发现货对不上账。
    // 这条断言把「这个函数对退款状态没有发言权」写死在测试里
    expect(shouldRestoreStock("REFUNDING")).toBe(false)
    expect(shouldRestoreStock("REFUNDED")).toBe(false)
  })
})

describe("isNoteEditable —— 什么时候还能改订单备注", () => {
  it("还没发货的两个状态可以改", () => {
    // 订单还没出去，改一句话不影响任何已经发生的事
    expect(isNoteEditable(ORDER_STATUS.PENDING_PAYMENT)).toBe(true)
    expect(isNoteEditable(ORDER_STATUS.PAID)).toBe(true)
  })

  it("发货之后就锁住", () => {
    // 【为什么这条最要紧】备注是给打包的人看的。货一发出去，
    // 面单和包裹都定下来了，这时候还允许改，只会留下一份
    // 「订单上写着请工作日送、可包裹昨天就发了」的错记录
    expect(isNoteEditable(ORDER_STATUS.SHIPPED)).toBe(false)
    expect(isNoteEditable(ORDER_STATUS.COMPLETED)).toBe(false)
    // 已取消的订单更没什么好交代的了
    expect(isNoteEditable(ORDER_STATUS.CANCELLED)).toBe(false)
  })

  it("每个状态一个不落都有明确答案", () => {
    // 【为什么要遍历一遍】将来有人又加了一个状态，忘了更新这个函数的话，
    // 它会默认落到 false —— 那是安全的默认值，
    // 但这条断言会提醒你「有个新状态需要你明确表态」。
    // 第 7 步加 REFUNDING / REFUNDED 时这条确实亮了一下，
    // 确认它们该是 false 之后才把白名单保持原样
    for (const status of ORDER_STATUS_VALUES) {
      expect(typeof isNoteEditable(status)).toBe("boolean")
    }
    // 白名单就是这两个，不多不少
    const editable = ORDER_STATUS_VALUES.filter(isNoteEditable)
    expect(editable).toEqual([
      ORDER_STATUS.PENDING_PAYMENT,
      ORDER_STATUS.PAID,
    ])
  })

  it("退款中的订单不能再改备注", () => {
    // 【为什么这条要单独写】退款处理中时，买家最想干的事可能就是
    // 在备注里补一句「其实是因为尺码小了」—— 但那句话是给打包的人看的，
    // 而这一单正在被审核要不要退，打包的人根本不该动它。
    // 该说的话在退款申请的「补充说明」里说，那条信息会送到管理员面前
    expect(isNoteEditable(ORDER_STATUS.REFUNDING)).toBe(false)
    expect(isNoteEditable(ORDER_STATUS.REFUNDED)).toBe(false)
  })
})

describe("isRefundable —— 哪些状态能申请退款", () => {
  it("收了钱的三个状态都能退", () => {
    // 已发货、已完成也能退：这正是「退款」和「取消」的区别 ——
    // 取消只发生在发货前，退款是售后
    expect(isRefundable(ORDER_STATUS.PAID)).toBe(true)
    expect(isRefundable(ORDER_STATUS.SHIPPED)).toBe(true)
    expect(isRefundable(ORDER_STATUS.COMPLETED)).toBe(true)
  })

  it("没付钱 / 已经结束了的状态不能退", () => {
    // 待支付该走「取消」；已取消、已退款是终态；退款中不能重复申请
    expect(isRefundable(ORDER_STATUS.PENDING_PAYMENT)).toBe(false)
    expect(isRefundable(ORDER_STATUS.CANCELLED)).toBe(false)
    expect(isRefundable(ORDER_STATUS.REFUNDING)).toBe(false)
    expect(isRefundable(ORDER_STATUS.REFUNDED)).toBe(false)
  })

  it("这份白名单和状态机是一致的，不是另抄的一份", () => {
    // 【为什么值得写这条】「能申请退款的状态」这个规则在两个地方表达：
    //   1. REFUNDABLE_STATUSES 数组（页面拿它决定显不显示按钮）
    //   2. ORDER_STATUS_TRANSITIONS 里指向 REFUNDING 的那些边
    //      （SQL 的 WHERE 条件最终由它演化而来）
    // 两处不一致的表现是：页面上出现按钮，点了却报「不能申请退款」。
    // 这条断言把两者钉在一起，谁改了忘了另一边都会红
    const canReachRefunding = ORDER_STATUS_VALUES.filter((from) =>
      canTransition(from, ORDER_STATUS.REFUNDING),
    )
    expect([...REFUNDABLE_STATUSES].sort()).toEqual(canReachRefunding.sort())
  })
})

describe("orderStatusSchema —— 把 String 收窄成 OrderStatus", () => {
  it("接受合法状态", () => {
    for (const status of ORDER_STATUS_VALUES) {
      const parsed = orderStatusSchema.safeParse(status)
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data).toBe(status)
    }
  })

  it("拒绝脏数据", () => {
    // 这是从 URL 的 ?status= 读进来时的第一道关
    expect(orderStatusSchema.safeParse("FOO").success).toBe(false)
    expect(orderStatusSchema.safeParse("paid").success).toBe(false) // 大小写敏感
    expect(orderStatusSchema.safeParse("").success).toBe(false)
    expect(orderStatusSchema.safeParse(" PAID").success).toBe(false) // 不做 trim
    expect(orderStatusSchema.safeParse(null).success).toBe(false)
    expect(orderStatusSchema.safeParse(undefined).success).toBe(false)
    expect(orderStatusSchema.safeParse(123).success).toBe(false)
  })

  it("从 URL 读参数时，脏值会被挡在外面", () => {
    // searchParams.get("status") 返回 string | null，
    // 用户手工把 ?status=../../etc/passwd 敲进地址栏也没关系
    const fromUrl = "../../etc/passwd"
    const parsed = orderStatusSchema.safeParse(fromUrl)

    expect(parsed.success).toBe(false)
  })
})
