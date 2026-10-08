import { describe, expect, it } from "vitest"

import {
  MAX_IMAGES,
  parseImageLines,
  parseNonNegativeInt,
  parseYuanToCents,
  safeNext,
} from "@/lib/form"

// ============================================================================
// src/lib/form.ts —— 「不可信输入 → 可信值」的那几个转换
//
// 这几个函数是全项目最值得测的地方：它们又小、又被到处调用、
// 又经不起错 —— 金额错一分钱、跳转没挡住一个钓鱼站，都不会报错，
// 只会静默地出问题。
// ============================================================================

describe("parseYuanToCents —— 元 → 分", () => {
  it("整数元", () => {
    expect(parseYuanToCents("899")).toBe(89900)
    expect(parseYuanToCents("1")).toBe(100)
    expect(parseYuanToCents("0")).toBe(0)
  })

  it("带两位小数", () => {
    expect(parseYuanToCents("899.00")).toBe(89900)
    expect(parseYuanToCents("12.34")).toBe(1234)
    expect(parseYuanToCents("0.01")).toBe(1)
    expect(parseYuanToCents("0.99")).toBe(99)
  })

  it("只带一位小数时补零", () => {
    // "8.5" 是 8 元 5 角 = 850 分。补成 "50" 而不是当成 "5" 分
    expect(parseYuanToCents("8.5")).toBe(850)
    expect(parseYuanToCents("899.9")).toBe(89990)
    expect(parseYuanToCents("0.1")).toBe(10)
  })

  it("两边有空格也算数", () => {
    expect(parseYuanToCents("  899  ")).toBe(89900)
  })

  // --------------------------------------------------------------------------
  // 下面这组是这个函数存在的**全部理由**
  // --------------------------------------------------------------------------

  it("浮点数算不出来的那些值，这里必须是精确的", () => {
    // 用 parseFloat 的话：parseFloat("0.29") * 100 === 28.999999999999996
    expect(parseYuanToCents("0.29")).toBe(29)
    // 0.1 + 0.2 !== 0.3 的那个 0.1
    expect(parseYuanToCents("0.1")).toBe(10)
    // 1.005 是经典的 Math.round 也救不回来的例子
    expect(parseYuanToCents("1.01")).toBe(101)
    expect(parseFloat("1.005") * 100).not.toBe(100.5) // 证明这个坑真实存在
  })

  it("任意分值都能原样往返（不丢一分钱）", () => {
    // 属性测试：造 0 ~ 2000 分，转成「元」的字符串再解析回来，必须一模一样。
    // 单点断言只能覆盖我想得到的数字，往返测试能覆盖整整一段区间
    for (let cents = 0; cents <= 2000; cents++) {
      const yuan = (cents / 100).toFixed(2) // "0.29"
      expect(parseYuanToCents(yuan)).toBe(cents)
    }
  })

  it("拒绝一切非「纯数字」的写法", () => {
    // parseFloat 对这些是宽容的（"12abc" → 12、"1e3" → 1000），
    // 而我们宁可报错，也不要静默地按用户没想过的数字成交
    expect(parseYuanToCents("12abc")).toBeNull()
    expect(parseYuanToCents("1e3")).toBeNull()
    expect(parseYuanToCents("0x10")).toBeNull()
    expect(parseYuanToCents("Infinity")).toBeNull()
    expect(parseYuanToCents("NaN")).toBeNull()
    expect(parseYuanToCents("$899")).toBeNull()
    expect(parseYuanToCents("8,99")).toBeNull()
  })

  it("拒绝负数", () => {
    expect(parseYuanToCents("-5")).toBeNull()
    expect(parseYuanToCents("-0.01")).toBeNull()
  })

  it("小数位最多两位", () => {
    expect(parseYuanToCents("1.234")).toBeNull()
    expect(parseYuanToCents("1.2.3")).toBeNull()
  })

  it("小数点不能悬空", () => {
    expect(parseYuanToCents("1.")).toBeNull()
    expect(parseYuanToCents(".5")).toBeNull()
    expect(parseYuanToCents(".")).toBeNull()
  })

  it("整数部分最多 9 位", () => {
    expect(parseYuanToCents("999999999")).toBe(99_999_999_900)
    expect(parseYuanToCents("1000000000")).toBeNull() // 10 位，超出
  })

  it("空值一律返回 null", () => {
    expect(parseYuanToCents("")).toBeNull()
    expect(parseYuanToCents("   ")).toBeNull()
  })

  it("非字符串一律返回 null", () => {
    // 签名故意收 unknown：调用方可能直接传 formData.get() 的结果，
    // 它可能是 File 对象；也可能有人不小心传了数字
    expect(parseYuanToCents(899)).toBeNull()
    expect(parseYuanToCents(null)).toBeNull()
    expect(parseYuanToCents(undefined)).toBeNull()
    expect(parseYuanToCents({})).toBeNull()
    expect(parseYuanToCents([])).toBeNull()
  })
})

describe("parseImageLines —— 多行文本 → 图片数组", () => {
  it("按行拆分", () => {
    expect(parseImageLines("/a.svg\n/b.svg")).toEqual(["/a.svg", "/b.svg"])
  })

  it("同时认 \\n 和 \\r\\n", () => {
    // Windows 的 textarea 和从别处粘贴的内容可能是 CRLF
    expect(parseImageLines("/a.svg\r\n/b.svg")).toEqual(["/a.svg", "/b.svg"])
  })

  it("去掉每行两边的空格", () => {
    expect(parseImageLines("  /a.svg  \n\t/b.svg\t")).toEqual([
      "/a.svg",
      "/b.svg",
    ])
  })

  it("丢掉空行", () => {
    expect(parseImageLines("\n\n/a.svg\n\n\n/b.svg\n\n")).toEqual([
      "/a.svg",
      "/b.svg",
    ])
    expect(parseImageLines("")).toEqual([])
    expect(parseImageLines("   \n  \n ")).toEqual([])
  })

  it("去重，且保留首次出现的顺序", () => {
    expect(parseImageLines("/a.svg\n/b.svg\n/a.svg")).toEqual([
      "/a.svg",
      "/b.svg",
    ])
  })

  it("最多 MAX_IMAGES 张，多出来的截掉", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `/img-${i}.svg`)
    const result = parseImageLines(nine.join("\n"))

    expect(MAX_IMAGES).toBe(8)
    expect(result).toHaveLength(MAX_IMAGES)
    // 截掉的是末尾那张，前面的顺序不变
    expect(result).toEqual(nine.slice(0, 8))
    expect(result).not.toContain("/img-8.svg")
  })

  it("先按 MAX_IMAGES 截断，所以第 9 行重复前 8 行里的内容也进不来", () => {
    // 顺序很重要：如果先截断再去重，就会剩下 7 张
    const lines = ["/a.svg", "/b.svg", "/c.svg", "/d.svg", "/e.svg", "/f.svg", "/g.svg", "/h.svg"]
    expect(parseImageLines([...lines, "/a.svg"].join("\n"))).toEqual(lines)
  })

  it("非字符串返回空数组", () => {
    expect(parseImageLines(null)).toEqual([])
    expect(parseImageLines(undefined)).toEqual([])
    expect(parseImageLines(123)).toEqual([])
  })

  it("不校验路径合法性 —— 那是 zod 的活", () => {
    // 这个函数只管「拆分 + 清理」，长度上限交给 productSchema.images 把关。
    // 职责分开，出问题时才知道该改哪儿
    expect(parseImageLines("这不是一个路径")).toEqual(["这不是一个路径"])
  })
})

describe("parseNonNegativeInt —— 非负整数输入框", () => {
  it("正常解析", () => {
    expect(parseNonNegativeInt("0")).toBe(0)
    expect(parseNonNegativeInt("5")).toBe(5)
    expect(parseNonNegativeInt("999999")).toBe(999_999)
    expect(parseNonNegativeInt("007")).toBe(7)
  })

  it("把「没填」和「填了 0」区分开 —— 这是它存在的理由", () => {
    // Number("") === 0，所以直接用 Number() 的话，
    // 「库存留空」会被悄无声息地当成「库存设为 0」
    expect(Number("")).toBe(0) // 证明这个坑真实存在
    expect(parseNonNegativeInt("")).toBeNaN()
    expect(parseNonNegativeInt("   ")).toBeNaN()

    // 而真正的 0 必须能通过
    expect(parseNonNegativeInt("0")).toBe(0)
  })

  it("拒绝负号、小数、加号", () => {
    expect(parseNonNegativeInt("-1")).toBeNaN()
    expect(parseNonNegativeInt("1.5")).toBeNaN()
    expect(parseNonNegativeInt("+5")).toBeNaN()
    expect(parseNonNegativeInt("1e3")).toBeNaN()
  })

  it("拒绝非数字字符", () => {
    expect(parseNonNegativeInt("abc")).toBeNaN()
    expect(parseNonNegativeInt("5件")).toBeNaN()
    expect(parseNonNegativeInt(" 5 ")).toBe(5) // 但两边空格是可以的
  })

  it("非字符串返回 NaN", () => {
    expect(parseNonNegativeInt(null)).toBeNaN()
    expect(parseNonNegativeInt(undefined)).toBeNaN()
    expect(parseNonNegativeInt(5)).toBeNaN()
  })
})

// ============================================================================
// safeNext —— 防开放重定向
//
// 这组测试是这次补测试最值钱的部分。这个函数只有五行，
// 但写错了不会报任何错，只会静默地多出一条钓鱼路径。
// ============================================================================

describe("safeNext —— 防开放重定向", () => {
  it("放行正常的站内路径", () => {
    expect(safeNext("/cart")).toBe("/cart")
    expect(safeNext("/")).toBe("/")
    expect(safeNext("/products/abc123")).toBe("/products/abc123")
    expect(safeNext("/admin/orders?status=PAID")).toBe("/admin/orders?status=PAID")
  })

  it("挡掉绝对 URL", () => {
    expect(safeNext("https://evil.com")).toBe("/products")
    expect(safeNext("http://evil.com/login")).toBe("/products")
    expect(safeNext("HTTPS://EVIL.COM")).toBe("/products")
  })

  it("挡掉协议相对 URL（// 开头）", () => {
    // 浏览器把 "//evil.com" 当成「协议相对 URL」，等价于 https://evil.com。
    // 这是最容易被漏掉的一种，因为肉眼看它「以 / 开头」
    expect(safeNext("//evil.com")).toBe("/products")
    expect(safeNext("//evil.com/login")).toBe("/products")
  })

  it("挡掉反斜杠变体", () => {
    // WHATWG URL 解析把反斜杠当正斜杠处理，
    // 所以 "/\evil.com" 在浏览器眼里就是 "//evil.com"
    expect(safeNext("/\\evil.com")).toBe("/products")
    expect(safeNext("\\/evil.com")).toBe("/products")
    expect(safeNext("\\\\evil.com")).toBe("/products")
  })

  it("挡掉 javascript: 之类的伪协议", () => {
    expect(safeNext("javascript:alert(1)")).toBe("/products")
    expect(safeNext("data:text/html,<script>alert(1)</script>")).toBe("/products")
  })

  it("空值回落到首页", () => {
    expect(safeNext("")).toBe("/products")
    expect(safeNext(null)).toBe("/products")
    expect(safeNext(undefined)).toBe("/products")
  })

  it("非字符串回落到首页", () => {
    // formData.get() 拿到的可能是 File 对象，不能假设它是字符串
    expect(safeNext(123)).toBe("/products")
    expect(safeNext({})).toBe("/products")
  })

  it("返回值永远以单个 / 开头", () => {
    // 把这条当成不变量：无论输入什么，输出都是站内相对路径
    const inputs = [
      "/cart",
      "//evil.com",
      "https://evil.com",
      "/\\evil.com",
      "",
      "javascript:alert(1)",
      "evil.com",
      "/a/b/c",
    ]

    for (const input of inputs) {
      const result = safeNext(input)
      expect(result.startsWith("/")).toBe(true)
      expect(result.startsWith("//")).toBe(false)
    }
  })
})
