import { describe, expect, it } from "vitest"

import {
  BULK_MAX_PRODUCTS,
  COUPON_CODE_MIN_LENGTH,
  MAX_PRICE_CENTS,
  MAX_STOCK_DELTA,
  ORDER_NOTE_MAX_LENGTH,
  REFUND_ADMIN_NOTE_MAX_LENGTH,
  REFUND_DESCRIPTION_MAX_LENGTH,
  REFUND_REASON,
  REFUND_REASON_VALUES,
} from "@/lib/constants"
import { MAX_IMAGES } from "@/lib/form"
import { REVIEW_MAX_CONTENT, REVIEW_MAX_IMAGES } from "@/lib/reviews"
import {
  bulkPriceSchema,
  bulkProductIdsSchema,
  bulkStockDeltaSchema,
  cartLineSchema,
  checkoutSchema,
  couponSchema,
  emailSchema,
  loginSchema,
  orderNoteSchema,
  productSchema,
  quantitySchema,
  refundRejectionSchema,
  refundRequestSchema,
  registerSchema,
  reviewSchema,
  skuIdSchema,
  skuSchema,
} from "@/lib/schemas"

// ============================================================================
// 所有 zod 校验规则 —— src/lib/schemas.ts
//
// 【为什么这一组测试特别重要】
// 这些 schema 是**唯一**挡住脏数据的地方。SQLite 没有 enum、没有长度限制、
// 没有类型约束，往 status 里塞 "FOO" 它也照存不误。
// 所以「用户能提交什么」这件事完全由这些规则决定 ——
// 规则错了，数据库里就会存进不该存的东西。
//
// 【顺带说一句为什么测试能 import 它们】
// 它们原来定义在 "use server" 文件里，根本没法被 import（详见 src/lib/schemas.ts）。
// 这个文件能存在，本身就是那次抽取的收益。
// ============================================================================

/** 取第一个错误信息，方便断言文案 */
function firstError(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues[0]?.message
}

describe("emailSchema", () => {
  it("接受合法邮箱", () => {
    expect(emailSchema.safeParse("user@shop.dev").success).toBe(true)
    expect(emailSchema.safeParse("a.b+c@sub.example.com").success).toBe(true)
  })

  it("先清洗再校验 —— 带空格的邮箱不该被判非法", () => {
    // 这是 .pipe() 存在的理由：写成 z.email().trim() 的话，
    // 格式校验发生在 trim 之前，" foo@bar.com " 会被直接拒掉
    const parsed = emailSchema.safeParse("  Foo@Bar.com  ")

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toBe("foo@bar.com")
  })

  it("统一转小写，避免注册出两个账号", () => {
    // Foo@bar.com 和 foo@bar.com 在数据库里必须是同一个邮箱，
    // 否则唯一约束挡不住「一个人注册两次」
    const upper = emailSchema.safeParse("ADMIN@SHOP.DEV")
    const lower = emailSchema.safeParse("admin@shop.dev")

    expect(upper.success && upper.data).toBe("admin@shop.dev")
    expect(lower.success && lower.data).toBe("admin@shop.dev")
  })

  it("拒绝非法格式", () => {
    expect(emailSchema.safeParse("not-an-email").success).toBe(false)
    expect(emailSchema.safeParse("@shop.dev").success).toBe(false)
    expect(emailSchema.safeParse("user@").success).toBe(false)
    expect(emailSchema.safeParse("").success).toBe(false)
    expect(emailSchema.safeParse("user @shop.dev").success).toBe(false)
  })

  it("错误文案是给用户看的中文", () => {
    expect(firstError(emailSchema.safeParse("bad"))).toBe("请输入有效的邮箱地址")
  })
})

describe("loginSchema", () => {
  it("只要非空就放行，不校验密码强度", () => {
    // 登录时不校验强度：那会把「密码太短」这种信息泄露给攻击者，
    // 而且老用户的密码规则可能和新规则不一样。对不对交给 bcrypt
    const parsed = loginSchema.safeParse({ email: "a@b.com", password: "x" })

    expect(parsed.success).toBe(true)
  })

  it("密码为空要拦下来", () => {
    const parsed = loginSchema.safeParse({ email: "a@b.com", password: "" })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toBe("请输入密码")
  })

  it("邮箱顺带被清洗成小写", () => {
    const parsed = loginSchema.safeParse({ email: " A@B.COM ", password: "x" })

    expect(parsed.success && parsed.data.email).toBe("a@b.com")
  })
})

describe("registerSchema", () => {
  const valid = {
    name: "张三",
    email: "user@shop.dev",
    password: "abcd1234",
  }

  it("接受合法输入", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true)
  })

  it("昵称长度 2 ~ 20", () => {
    expect(registerSchema.safeParse({ ...valid, name: "李" }).success).toBe(false)
    expect(registerSchema.safeParse({ ...valid, name: "李四" }).success).toBe(true)
    expect(
      registerSchema.safeParse({ ...valid, name: "一".repeat(20) }).success,
    ).toBe(true)
    expect(
      registerSchema.safeParse({ ...valid, name: "一".repeat(21) }).success,
    ).toBe(false)
  })

  it("昵称两边的空格会被去掉（所以 ' 李 ' 只有 1 个字）", () => {
    expect(registerSchema.safeParse({ ...valid, name: "  李  " }).success).toBe(false)
  })

  it("密码至少 8 位", () => {
    expect(registerSchema.safeParse({ ...valid, password: "abc123" }).success).toBe(false)
    expect(firstError(registerSchema.safeParse({ ...valid, password: "abc123" }))).toBe(
      "密码至少 8 位",
    )
  })

  it("密码最多 72 位 —— 因为 bcrypt 只认前 72 字节", () => {
    // 不挡住的话，用户以为设了 100 位强密码，实际生效的只有前 72 位
    const p72 = "a1" + "x".repeat(70)
    const p73 = "a1" + "x".repeat(71)

    expect(p72).toHaveLength(72)
    expect(p73).toHaveLength(73)
    expect(registerSchema.safeParse({ ...valid, password: p72 }).success).toBe(true)
    expect(registerSchema.safeParse({ ...valid, password: p73 }).success).toBe(false)
  })

  it("密码必须同时包含字母和数字", () => {
    // "abcdefgh" 有字母没数字 → 缺的是**数字**
    const noDigit = registerSchema.safeParse({ ...valid, password: "abcdefgh" })
    // "12345678" 有数字没字母 → 缺的是**字母**
    const noLetter = registerSchema.safeParse({ ...valid, password: "12345678" })

    expect(noDigit.success).toBe(false)
    expect(firstError(noDigit)).toBe("密码需要包含数字")
    expect(noLetter.success).toBe(false)
    expect(firstError(noLetter)).toBe("密码需要包含字母")
  })

  it("密码不做 trim —— 空格是合法密码字符", () => {
    // 密码里前前后后的空格是用户**故意**输的，
    // 悄悄 trim 掉会让他以后再也登不上
    const parsed = registerSchema.safeParse({
      ...valid,
      password: " abcd1234 ",
    })

    expect(parsed.success && parsed.data.password).toBe(" abcd1234 ")
  })
})

describe("checkoutSchema", () => {
  it("接受合法地址和手机号", () => {
    const parsed = checkoutSchema.safeParse({
      address: "北京市朝阳区某某路 1 号",
      phone: "13800138000",
    })

    expect(parsed.success).toBe(true)
  })

  it("地址长度 5 ~ 120", () => {
    expect(checkoutSchema.safeParse({ address: "北京", phone: "13800138000" }).success).toBe(
      false,
    )
    expect(
      checkoutSchema.safeParse({ address: "一".repeat(120), phone: "13800138000" }).success,
    ).toBe(true)
    expect(
      checkoutSchema.safeParse({ address: "一".repeat(121), phone: "13800138000" }).success,
    ).toBe(false)
  })

  it("手机号必须是 11 位大陆号码", () => {
    const phone = (value: string) =>
      checkoutSchema.safeParse({ address: "北京市朝阳区某路 1 号", phone: value }).success

    expect(phone("13800138000")).toBe(true)
    expect(phone("19912345678")).toBe(true)
    expect(phone("12800138000")).toBe(false) // 第二位不能是 2
    expect(phone("10800138000")).toBe(false) // 第二位不能是 1
    expect(phone("23800138000")).toBe(false) // 不能以 2 开头
    expect(phone("1380013800")).toBe(false) // 10 位
    expect(phone("138001380000")).toBe(false) // 12 位
    expect(phone("138 0013 8000")).toBe(false) // 带空格
    expect(phone("138-0013-8000")).toBe(false)
    expect(phone("+8613800138000")).toBe(false)
    expect(phone("")).toBe(false)
  })

  it("手机号里的全角数字要拦下来", () => {
    // 这就是为什么正则写 \d 而不是 [0-9] 之外还要小心：
    // 这里的 \d 在 JS 里只匹配 ASCII 数字，全角数字会被拒
    expect(checkoutSchema.safeParse({
      address: "北京市朝阳区某路 1 号",
      phone: "１３８００１３８０００",
    }).success).toBe(false)
  })
})

describe("skuSchema", () => {
  const valid = { size: "42", color: "曜石黑", stock: 10 }

  it("接受合法规格", () => {
    expect(skuSchema.safeParse(valid).success).toBe(true)
  })

  it("尺码可以是数字、字母、小数点和横杠", () => {
    // 鞋码有 42.5，衣服有 XL，所以要白名单而不是 \d+
    expect(skuSchema.safeParse({ ...valid, size: "42.5" }).success).toBe(true)
    expect(skuSchema.safeParse({ ...valid, size: "XL" }).success).toBe(true)
    expect(skuSchema.safeParse({ ...valid, size: "XXL-Plus" }).success).toBe(true)
  })

  it("尺码拒绝白名单外的字符", () => {
    // 白名单的好处是「只允许我想到的」，而不是「排除我想到的坏字符」
    expect(skuSchema.safeParse({ ...valid, size: "42#" }).success).toBe(false)
    expect(skuSchema.safeParse({ ...valid, size: "42 码" }).success).toBe(false)
    expect(skuSchema.safeParse({ ...valid, size: "<script>" }).success).toBe(false)
    expect(skuSchema.safeParse({ ...valid, size: "" }).success).toBe(false)
    expect(skuSchema.safeParse({ ...valid, size: "1".repeat(11) }).success).toBe(false)
  })

  it("颜色长度 1 ~ 20", () => {
    expect(skuSchema.safeParse({ ...valid, color: "" }).success).toBe(false)
    expect(skuSchema.safeParse({ ...valid, color: "黑" }).success).toBe(true)
    expect(skuSchema.safeParse({ ...valid, color: "黑".repeat(21) }).success).toBe(false)
  })

  it("库存必须是非负整数", () => {
    expect(skuSchema.safeParse({ ...valid, stock: 0 }).success).toBe(true)
    expect(skuSchema.safeParse({ ...valid, stock: 999_999 }).success).toBe(true)
    expect(skuSchema.safeParse({ ...valid, stock: -1 }).success).toBe(false)
    expect(skuSchema.safeParse({ ...valid, stock: 1.5 }).success).toBe(false)
    expect(skuSchema.safeParse({ ...valid, stock: 1_000_000 }).success).toBe(false)
  })

  it("库存收到 NaN（用户没填）时给的是「必须是数字」", () => {
    // parseNonNegativeInt 对空输入返回 NaN，就是为了走到这个分支 ——
    // 而不是被当成 0 悄悄存进去
    const parsed = skuSchema.safeParse({
      ...valid,
      stock: Number.NaN,
    })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toBe("库存必须是数字")
  })
})

describe("productSchema", () => {
  const valid = {
    name: "轻量透气跑步鞋",
    description: "适合日常慢跑",
    category: "跑步鞋",
    images: ["/shoes/a.svg"],
  }

  it("接受合法商品", () => {
    expect(productSchema.safeParse(valid).success).toBe(true)
  })

  it("名称、描述、分类都不能为空", () => {
    expect(productSchema.safeParse({ ...valid, name: "" }).success).toBe(false)
    expect(productSchema.safeParse({ ...valid, description: "" }).success).toBe(false)
    expect(productSchema.safeParse({ ...valid, category: "" }).success).toBe(false)
  })

  it("长度上限", () => {
    expect(productSchema.safeParse({ ...valid, name: "一".repeat(61) }).success).toBe(false)
    expect(productSchema.safeParse({ ...valid, description: "一".repeat(2001) }).success).toBe(
      false,
    )
    expect(productSchema.safeParse({ ...valid, category: "一".repeat(21) }).success).toBe(false)
  })

  it("图片最多 MAX_IMAGES 张", () => {
    const images = (n: number) => Array.from({ length: n }, (_, i) => `/a-${i}.svg`)

    expect(productSchema.safeParse({ ...valid, images: images(MAX_IMAGES) }).success).toBe(true)
    expect(productSchema.safeParse({ ...valid, images: images(MAX_IMAGES + 1) }).success).toBe(
      false,
    )
    // 图片可以是空数组 —— 新建商品时还没配图
    expect(productSchema.safeParse({ ...valid, images: [] }).success).toBe(true)
  })

  it("单个图片路径最多 300 字符", () => {
    const long = "/" + "a".repeat(300) // 301 字符
    expect(productSchema.safeParse({ ...valid, images: [long] }).success).toBe(false)
    expect(
      productSchema.safeParse({ ...valid, images: ["/" + "a".repeat(299)] }).success,
    ).toBe(true)
  })
})

describe("购物车相关 schema", () => {
  it("skuId 非空即可", () => {
    expect(skuIdSchema.safeParse("abc").success).toBe(true)
    expect(skuIdSchema.safeParse("").success).toBe(false)
  })

  it("数量是 1 ~ 99 的整数", () => {
    expect(quantitySchema.safeParse(1).success).toBe(true)
    expect(quantitySchema.safeParse(99).success).toBe(true)
    expect(quantitySchema.safeParse(0).success).toBe(false) // 要删请走删除接口
    expect(quantitySchema.safeParse(-1).success).toBe(false)
    expect(quantitySchema.safeParse(100).success).toBe(false)
    expect(quantitySchema.safeParse(1.5).success).toBe(false)
    expect(quantitySchema.safeParse("5").success).toBe(false) // 字符串不收，调用方负责转
  })

  it("cartLineSchema 由上面两个组合而成", () => {
    // 组合而不是重写一遍：数量上限只有一处定义
    expect(cartLineSchema.safeParse({ skuId: "abc", quantity: 2 }).success).toBe(true)
    expect(cartLineSchema.safeParse({ skuId: "", quantity: 2 }).success).toBe(false)
    expect(cartLineSchema.safeParse({ skuId: "abc", quantity: 0 }).success).toBe(false)
    expect(cartLineSchema.safeParse({ skuId: "abc", quantity: 100 }).success).toBe(false)
    expect(cartLineSchema.safeParse({ quantity: 2 }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 批量操作的校验规则
//
// 【为什么这批规则要测到边界值那么细】
// 批量操作是「一次改很多东西」，这里放过去一个脏值，
// 影响面是几十上百个 SKU。而且它的调用方是客户端组件，
// 谁都可以打开控制台用任意参数去调 —— 校验拦不住就等于没有校验。
// ---------------------------------------------------------------------------

describe("bulkProductIdsSchema：勾选的商品 id", () => {
  it("正常的 id 数组通过", () => {
    expect(bulkProductIdsSchema.safeParse(["a", "b", "c"]).success).toBe(true)
  })

  it("空数组被拒，并且给的是人话", () => {
    // 提示语是直接弹给管理员看的，不能是 zod 默认的英文
    const result = bulkProductIdsSchema.safeParse([])
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("请先勾选要操作的商品")
  })

  it("超过上限被拒", () => {
    // 上限不是技术限制，是刹车：批量操作全程持写锁，
    // 勾得越多，买家排队越久
    const justEnough = Array.from({ length: BULK_MAX_PRODUCTS }, (_, i) => `p${i}`)
    const tooMany = [...justEnough, "one-more"]

    expect(bulkProductIdsSchema.safeParse(justEnough).success).toBe(true)
    expect(bulkProductIdsSchema.safeParse(tooMany).success).toBe(false)
  })

  it("元素必须是字符串，空串和超长串都不收", () => {
    expect(bulkProductIdsSchema.safeParse([""]).success).toBe(false)
    expect(bulkProductIdsSchema.safeParse(["a".repeat(65)]).success).toBe(false)
    expect(bulkProductIdsSchema.safeParse([123]).success).toBe(false)
  })

  it("不是数组的一律拒绝", () => {
    // 客户端组件传什么进来都有可能，"abc" / {a:1} / null 都要挡住
    for (const bad of ["abc", { a: 1 }, null, undefined, 42]) {
      expect(bulkProductIdsSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe("bulkPriceSchema：批量改价", () => {
  it("百分比模式：正负都收，超出范围拒掉", () => {
    expect(bulkPriceSchema.safeParse({ mode: "percent", value: 10 }).success).toBe(true)
    expect(bulkPriceSchema.safeParse({ mode: "percent", value: -15 }).success).toBe(true)

    // -90 是硬下限：再低就是降到 0 或负数，那叫白送
    expect(bulkPriceSchema.safeParse({ mode: "percent", value: -90 }).success).toBe(true)
    expect(bulkPriceSchema.safeParse({ mode: "percent", value: -91 }).success).toBe(false)

    expect(bulkPriceSchema.safeParse({ mode: "percent", value: 500 }).success).toBe(true)
    expect(bulkPriceSchema.safeParse({ mode: "percent", value: 501 }).success).toBe(false)
  })

  it("百分比必须是整数", () => {
    expect(bulkPriceSchema.safeParse({ mode: "percent", value: 12.5 }).success).toBe(false)
  })

  it("固定价模式：单位是分，必须大于 0", () => {
    expect(bulkPriceSchema.safeParse({ mode: "set", value: 89900 }).success).toBe(true)
    // 0 和负数都不行 —— 0 元商品在系统里「能走通但没意义」，最难发现
    expect(bulkPriceSchema.safeParse({ mode: "set", value: 0 }).success).toBe(false)
    expect(bulkPriceSchema.safeParse({ mode: "set", value: -100 }).success).toBe(false)
  })

  it("固定价模式的上限是防手滑的", () => {
    expect(bulkPriceSchema.safeParse({ mode: "set", value: MAX_PRICE_CENTS }).success).toBe(true)
    expect(bulkPriceSchema.safeParse({ mode: "set", value: MAX_PRICE_CENTS + 1 }).success).toBe(false)
  })

  it("两种模式的范围是**各自独立**的", () => {
    // 【这条在验证 discriminatedUnion 真的起作用了】
    // 如果当初图省事用一个普通的 object 描述，
    // 就只能给 value 取一个宽松的交集，于是「-50 分的单价」
    // 和「负数的百分比当单价用」都会被放进来
    expect(bulkPriceSchema.safeParse({ mode: "set", value: -50 }).success).toBe(false)
    expect(bulkPriceSchema.safeParse({ mode: "percent", value: 99_999 }).success).toBe(false)
  })

  it("mode 只能是这两个值", () => {
    expect(bulkPriceSchema.safeParse({ mode: "multiply", value: 2 }).success).toBe(false)
    expect(bulkPriceSchema.safeParse({ value: 10 }).success).toBe(false)
  })
})

describe("bulkStockDeltaSchema：批量调库存的增减量", () => {
  it("正负整数都收", () => {
    expect(bulkStockDeltaSchema.safeParse(10).success).toBe(true)
    expect(bulkStockDeltaSchema.safeParse(-10).success).toBe(true)
  })

  it("0 被拒，而且理由是「不能是 0」", () => {
    // 让它通过的话，界面会弹「已给 12 个规格入库 0 件」——
    // 管理员以为改了什么，其实什么都没发生
    const result = bulkStockDeltaSchema.safeParse(0)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("调整数量不能是 0")
  })

  it("小数和非数字被拒", () => {
    expect(bulkStockDeltaSchema.safeParse(1.5).success).toBe(false)
    expect(bulkStockDeltaSchema.safeParse("10").success).toBe(false)
    expect(bulkStockDeltaSchema.safeParse(Number.NaN).success).toBe(false)
  })

  it("超过单次上限被拒", () => {
    expect(bulkStockDeltaSchema.safeParse(MAX_STOCK_DELTA).success).toBe(true)
    expect(bulkStockDeltaSchema.safeParse(MAX_STOCK_DELTA + 1).success).toBe(false)
    expect(bulkStockDeltaSchema.safeParse(-MAX_STOCK_DELTA - 1).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 商品评价
// ---------------------------------------------------------------------------

describe("reviewSchema：评价的校验规则", () => {
  /** 一份能通过的最小输入，每个用例只改其中一项 */
  const valid = { rating: 5, content: "鞋码标准，脚感很软", images: [] }

  it("正常的评价能通过", () => {
    expect(reviewSchema.safeParse(valid).success).toBe(true)
  })

  it("星级必须是 1~5 的整数", () => {
    for (const rating of [1, 3, 5]) {
      expect(reviewSchema.safeParse({ ...valid, rating }).success).toBe(true)
    }
    // 0 星和 6 星都不存在；3.5 星说明值不是从五个按钮里选的
    for (const rating of [0, 6, 3.5, -1]) {
      expect(reviewSchema.safeParse({ ...valid, rating }).success).toBe(false)
    }
  })

  it("星级没选时给的是「请先选择星级」而不是类型错误", () => {
    // parseRating 拿不准会返回 null，action 那边转成 undefined 传进来。
    // 用户看到的必须是「请先选择星级」这种能照着做的话，
    // 而不是「expected number, received undefined」
    const result = reviewSchema.safeParse({ ...valid, rating: undefined })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("请先选择星级")
  })

  it("内容太短被拒 —— 两个字的好评对后来人没有信息量", () => {
    const result = reviewSchema.safeParse({ ...valid, content: "好" })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toMatch(/至少写/)
  })

  it("内容超长被拒，且和常量保持一致", () => {
    expect(
      reviewSchema.safeParse({ ...valid, content: "a".repeat(REVIEW_MAX_CONTENT) })
        .success,
    ).toBe(true)
    expect(
      reviewSchema.safeParse({
        ...valid,
        content: "a".repeat(REVIEW_MAX_CONTENT + 1),
      }).success,
    ).toBe(false)
  })

  it("内容两端的空白先去掉再算长度", () => {
    // "  好  " 去空白后只剩一个字，不该因为它「看起来有 5 个字符」就放行
    expect(reviewSchema.safeParse({ ...valid, content: "   好   " }).success).toBe(
      false,
    )
  })

  it("图片超过上限被拒，而且是报错不是悄悄截断", () => {
    const images = Array.from(
      { length: REVIEW_MAX_IMAGES + 1 },
      (_, i) => `/shoes/x-${i}.svg`,
    )
    const result = reviewSchema.safeParse({ ...valid, images })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toMatch(/最多/)
  })

  it("图片不是数组被拒", () => {
    expect(
      reviewSchema.safeParse({ ...valid, images: "/shoes/a.svg" }).success,
    ).toBe(false)
  })
})

describe("orderNoteSchema：订单备注", () => {
  it("正常内容原样通过", () => {
    const result = orderNoteSchema.safeParse("请工作日送达")
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe("请工作日送达")
  })

  it("空串归一成 null，而不是留一个空字符串", () => {
    // 【为什么这条是整个 schema 里最该测的】
    // 归一成败在这一行：留着 "" 的话，数据库里「没写备注」会有两种表示
    // （NULL 和 ""），之后每个查「有没有备注」的地方都得写两个条件，
    // 迟早有一处漏掉
    const result = orderNoteSchema.safeParse("")
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBeNull()
  })

  it("只敲了空格也归一成 null", () => {
    // 用户点进输入框、随手敲了个空格又走了 —— 这在数据上就是「没写备注」。
    // 先 trim 再判空，顺序不能反
    const result = orderNoteSchema.safeParse("   \n  ")
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBeNull()
  })

  it("两端的空白被去掉，中间的保留", () => {
    const result = orderNoteSchema.safeParse("  放门口快递柜  ")
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe("放门口快递柜")
  })

  it("刚好到上限可以通过", () => {
    const note = "备".repeat(ORDER_NOTE_MAX_LENGTH)
    expect(orderNoteSchema.safeParse(note).success).toBe(true)
  })

  it("超出一个字就被拒，并且提示里带上上限", () => {
    const note = "备".repeat(ORDER_NOTE_MAX_LENGTH + 1)
    const result = orderNoteSchema.safeParse(note)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toContain(String(ORDER_NOTE_MAX_LENGTH))
  })

  it("先 trim 再算长度", () => {
    // 前后各加 50 个空格不该把一个合法备注顶出上限
    const note = ` ${"备".repeat(ORDER_NOTE_MAX_LENGTH)} `
    expect(orderNoteSchema.safeParse(note).success).toBe(true)
  })

  it("不是字符串的一律被拒", () => {
    // action 里会显式判一次类型，这里兜底
    expect(orderNoteSchema.safeParse(null).success).toBe(false)
    expect(orderNoteSchema.safeParse(undefined).success).toBe(false)
    expect(orderNoteSchema.safeParse(123).success).toBe(false)
  })
})

describe("checkoutSchema 里的备注（选填）", () => {
  const base = { address: "北京市朝阳区某某路 1 号", phone: "13800138000" }

  it("字段整个缺失也能下单，结果是 null", () => {
    // 【为什么这条最要紧】结算表单里如果哪天把 name 写错了，客户端就会
    // 把这个键整个漏掉。漏掉必须是「买家没写备注」，而不是「下不了单」——
    // 后者会让所有人在结算页卡住，而报错文案还指向不到真正的原因
    const parsed = checkoutSchema.safeParse(base)

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.note).toBeNull()
  })

  it("缺字段、空串、纯空白，三种写法结果一模一样", () => {
    // 归一化要是漏掉任何一种，库里「没写备注」就会有两种表示
    const missing = checkoutSchema.safeParse(base)
    const empty = checkoutSchema.safeParse({ ...base, note: "" })
    const blank = checkoutSchema.safeParse({ ...base, note: "  \n " })

    expect(missing.success && missing.data.note).toBeNull()
    expect(empty.success && empty.data.note).toBeNull()
    expect(blank.success && blank.data.note).toBeNull()
  })

  it("写了就带出来，两端的空白去掉", () => {
    const parsed = checkoutSchema.safeParse({ ...base, note: "  放门口快递柜  " })

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.note).toBe("放门口快递柜")
  })

  it("超长的备注在下单这一步就被拦住", () => {
    // 前端 maxLength 随手就能绕过去，真正管事的是这里
    const parsed = checkoutSchema.safeParse({
      ...base,
      note: "备".repeat(ORDER_NOTE_MAX_LENGTH + 1),
    })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toContain(String(ORDER_NOTE_MAX_LENGTH))
  })
})

// ============================================================================
// couponSchema —— 后台建券
//
// 【为什么这一组比别的 schema 测得更细】
// 别的表单填错了，用户最多是「加不进购物车」；券填错了，是**钱算错**。
// 而券的字段之间还互相牵制（value 的含义取决于 type，封顶只在折扣券上存在），
// 这种「一个字段的规则由另一个字段决定」的结构最容易出现
// 「看着拦住了、其实从另一个 type 绕过去」的漏洞。
// 所以下面每个分支都成对地测：合法的能过、不合法的被拦住。
// ============================================================================

const couponBase = {
  code: "SAVE100",
  minSpend: 80000,
  startAt: new Date("2026-10-01T00:00:00Z"),
  endAt: new Date("2026-11-01T00:00:00Z"),
  totalLimit: 100,
  perUserLimit: 1,
  isActive: true,
}

/** 一张合法的满减券：满 800 减 100 */
const fixedCoupon = {
  ...couponBase,
  type: "FIXED" as const,
  value: 10000,
  maxDiscount: null,
}

/** 一张合法的折扣券：9 折，最多减 50 */
const percentCoupon = {
  ...couponBase,
  type: "PERCENT" as const,
  value: 10,
  maxDiscount: 5000,
}

describe("couponSchema —— 满减券", () => {
  it("合法输入通过，且券码被转成大写", () => {
    const parsed = couponSchema.safeParse({ ...fixedCoupon, code: " save100 " })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.code).toBe("SAVE100")
      expect(parsed.data.value).toBe(10000)
    }
  })

  it("value 是 0 或负数 → 拒绝", () => {
    // 减 0 元的券没有任何意义，放进去只会让后台列表里多一条
    // 「为什么这张券减不掉钱」的谜题
    expect(couponSchema.safeParse({ ...fixedCoupon, value: 0 }).success).toBe(false)
    expect(couponSchema.safeParse({ ...fixedCoupon, value: -100 }).success).toBe(false)
  })

  it("value 必须是整数分，不能有小数", () => {
    // 39.99 元写成 3999 分。写成 3999.5 就说明调用方算错了单位
    expect(couponSchema.safeParse({ ...fixedCoupon, value: 3999.5 }).success).toBe(false)
  })

  it("value 超过价格上限 → 拒绝（防手滑多打一位）", () => {
    const parsed = couponSchema.safeParse({
      ...fixedCoupon,
      value: MAX_PRICE_CENTS + 1,
    })

    expect(parsed.success).toBe(false)
  })

  it("满减券填了封顶金额 → 拒绝，而不是静默忽略", () => {
    // 静默忽略的话，管理员以为「满减券也能封顶」，实际完全没生效
    const parsed = couponSchema.safeParse({ ...fixedCoupon, maxDiscount: 5000 })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toContain("满减券")
  })

  it("门槛可以是 0（无门槛券）", () => {
    expect(
      couponSchema.safeParse({ ...fixedCoupon, minSpend: 0 }).success,
    ).toBe(true)
  })

  it("门槛为负数 → 拒绝", () => {
    expect(
      couponSchema.safeParse({ ...fixedCoupon, minSpend: -1 }).success,
    ).toBe(false)
  })
})

describe("couponSchema —— 折扣券", () => {
  it("合法输入通过", () => {
    const parsed = couponSchema.safeParse(percentCoupon)

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.maxDiscount).toBe(5000)
  })

  it("value 只能是 1 ~ 99 的整数", () => {
    expect(couponSchema.safeParse({ ...percentCoupon, value: 1 }).success).toBe(true)
    expect(
      couponSchema.safeParse({ ...percentCoupon, value: 99 }).success,
    ).toBe(true)
    // 0 是「一点折扣都没有」，100 是「白送」—— 两头都该拦
    expect(couponSchema.safeParse({ ...percentCoupon, value: 0 }).success).toBe(false)
    expect(couponSchema.safeParse({ ...percentCoupon, value: 100 }).success).toBe(false)
  })

  it("value 有小数 → 拒绝（9 折填 10，不是 0.9）", () => {
    expect(couponSchema.safeParse({ ...percentCoupon, value: 0.9 }).success).toBe(false)
    expect(couponSchema.safeParse({ ...percentCoupon, value: 12.5 }).success).toBe(false)
  })

  it("value 超过 99 → 报错文案说清楚为什么", () => {
    const parsed = couponSchema.safeParse({ ...percentCoupon, value: 300 })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toContain("白送")
  })

  it("不填封顶金额 → 拒绝（折扣券必须封顶）", () => {
    expect(
      couponSchema.safeParse({ ...percentCoupon, maxDiscount: null }).success,
    ).toBe(false)
    // 键整个缺失也不行 —— 和 null 一样是「没封顶」
    // 用一个宽松类型 + delete：这样能真的把 key 抠掉，
    // 又不会留下一个「取出来却没用」的解构变量
    const withoutMaxDiscount: Record<string, unknown> = { ...percentCoupon }
    delete withoutMaxDiscount.maxDiscount
    expect(couponSchema.safeParse(withoutMaxDiscount).success).toBe(false)
  })

  it("封顶金额为 0 或负数 → 拒绝（永远减 0 的券）", () => {
    expect(
      couponSchema.safeParse({ ...percentCoupon, maxDiscount: 0 }).success,
    ).toBe(false)
    expect(
      couponSchema.safeParse({ ...percentCoupon, maxDiscount: -1 }).success,
    ).toBe(false)
  })

  it("两种券的 value 范围互不串门", () => {
    // 【这条是判别联合存在的全部理由】value = 10000 对满减券是天经地义的
    // （减 100 元），对折扣券却是「减 10000%」。如果两种券共用一套 value 规则，
    // 这个 10000 会被放进去，然后在下单时算出一笔负数订单
    expect(couponSchema.safeParse({ ...fixedCoupon, value: 10000 }).success).toBe(true)
    expect(couponSchema.safeParse({ ...percentCoupon, value: 10000 }).success).toBe(false)
  })
})

describe("couponSchema —— 字段之间", () => {
  it("结束时间必须晚于开始时间", () => {
    const parsed = couponSchema.safeParse({
      ...fixedCoupon,
      startAt: new Date("2026-11-01T00:00:00Z"),
      endAt: new Date("2026-10-01T00:00:00Z"),
    })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toContain("结束时间")
  })

  it("开始和结束是同一时刻 → 拒绝（这张券永远用不上）", () => {
    const same = new Date("2026-10-01T00:00:00Z")
    expect(
      couponSchema.safeParse({ ...fixedCoupon, startAt: same, endAt: same }).success,
    ).toBe(false)
  })

  it("每人限领不能超过发放总量", () => {
    // 这两个数填反了是高频手滑，且后果是「这张券谁都领不到」
    const parsed = couponSchema.safeParse({
      ...fixedCoupon,
      totalLimit: 10,
      perUserLimit: 11,
    })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toContain("每人限领")
  })

  it("两者相等是允许的（总共 10 张、每人限领 10 张）", () => {
    expect(
      couponSchema.safeParse({ ...fixedCoupon, totalLimit: 10, perUserLimit: 10 })
        .success,
    ).toBe(true)
  })

  it("发放总量 / 每人限领 至少是 1", () => {
    expect(
      couponSchema.safeParse({ ...fixedCoupon, totalLimit: 0 }).success,
    ).toBe(false)
    expect(
      couponSchema.safeParse({ ...fixedCoupon, perUserLimit: 0 }).success,
    ).toBe(false)
  })
})

describe("couponSchema —— 券码", () => {
  it("太短的券码被拒绝", () => {
    // 两三位数的券码等于没有校验，别人随手就试出来了
    const parsed = couponSchema.safeParse({ ...fixedCoupon, code: "A1" })

    expect(parsed.success).toBe(false)
    expect(firstError(parsed)).toContain(String(COUPON_CODE_MIN_LENGTH))
  })

  it("带空格或中文的券码被拒绝", () => {
    expect(couponSchema.safeParse({ ...fixedCoupon, code: "SAVE 100" }).success).toBe(false)
    expect(couponSchema.safeParse({ ...fixedCoupon, code: "满减一百" }).success).toBe(false)
  })

  it("下划线和横杠是允许的", () => {
    expect(couponSchema.safeParse({ ...fixedCoupon, code: "SAVE-100_A" }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 退款（第 7 步）
// ---------------------------------------------------------------------------

describe("refundRequestSchema —— 买家提交的退款申请", () => {
  it("四个原因都能过", () => {
    // 下拉框里就这四个值。少一个的话，对应的那个选项一点就报错
    for (const reason of REFUND_REASON_VALUES) {
      expect(
        refundRequestSchema.safeParse({ reason, description: "" }).success,
      ).toBe(true)
    }
  })

  it("不填原因被拒绝", () => {
    expect(refundRequestSchema.safeParse({ description: "太大了" }).success).toBe(
      false,
    )
    expect(
      refundRequestSchema.safeParse({ reason: "", description: "" }).success,
    ).toBe(false)
  })

  it("原因不在白名单里被拒绝 —— 表单是可以手工构造的", () => {
    // 【为什么这条最要紧】原因是下拉框，正常点不出别的值。但 Server Action
    // 是个可以被任意 POST 的接口，手写一个 reason=WHATEVER 就能塞进来。
    // 放过去的话，数据库里会混进同义不同形的值，
    // 「按原因统计退款」这个功能当场作废
    expect(
      refundRequestSchema.safeParse({ reason: "WHATEVER", description: "" })
        .success,
    ).toBe(false)
    expect(
      refundRequestSchema.safeParse({ reason: "size", description: "" }).success,
    ).toBe(false) // 大小写敏感
    expect(
      refundRequestSchema.safeParse({ reason: "尺码不合适", description: "" })
        .success,
    ).toBe(false) // 中文标签不是存储值
  })

  it("补充说明是选填：不填、填空串都变成 null", () => {
    // 【为什么要统一成 null 而不是留下 ""】数据库里 "" 和 NULL 是两种
    // 「没有」，页面判空时就得写两遍（!value || value === ""），
    // 漏一处就会渲染出一个空行
    const missing = refundRequestSchema.safeParse({ reason: REFUND_REASON.SIZE })
    expect(missing.success).toBe(true)
    if (missing.success) expect(missing.data.description).toBeNull()

    const blank = refundRequestSchema.safeParse({
      reason: REFUND_REASON.SIZE,
      description: "   ",
    })
    expect(blank.success).toBe(true)
    if (blank.success) expect(blank.data.description).toBeNull()
  })

  it("补充说明会 trim，超长被拒绝", () => {
    const parsed = refundRequestSchema.safeParse({
      reason: REFUND_REASON.OTHER,
      description: "  有点磨脚  ",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.description).toBe("有点磨脚")

    expect(
      refundRequestSchema.safeParse({
        reason: REFUND_REASON.OTHER,
        description: "啊".repeat(REFUND_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })

  it("正好卡在上限的长度是允许的", () => {
    // 边界值：max(N) 应该包含 N。差一位的 off-by-one
    // 会让用户对着一个「明明没超」的提示反复删字
    expect(
      refundRequestSchema.safeParse({
        reason: REFUND_REASON.OTHER,
        description: "啊".repeat(REFUND_DESCRIPTION_MAX_LENGTH),
      }).success,
    ).toBe(true)
  })
})

describe("refundRejectionSchema —— 管理员拒绝的理由", () => {
  it("填了就能过", () => {
    const parsed = refundRejectionSchema.safeParse({ adminNote: "已穿过，影响二次销售" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.adminNote).toBe("已穿过，影响二次销售")
  })

  it("空着 / 只有空格 被拒绝", () => {
    // 【为什么拒绝必须给理由】买家看到「已拒绝」却不知道凭什么，
    // 下一步只会来投诉。理由在这里是**功能的一部分**，不是客气话 ——
    // 所以校验层直接卡住，而不是靠前端标一个「建议填写」
    expect(refundRejectionSchema.safeParse({ adminNote: "" }).success).toBe(false)
    expect(refundRejectionSchema.safeParse({ adminNote: "   " }).success).toBe(false)
    expect(refundRejectionSchema.safeParse({}).success).toBe(false)
  })

  it("理由不会全是空格 —— trim 之后校验", () => {
    const parsed = refundRejectionSchema.safeParse({ adminNote: "  不符合条件  " })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.adminNote).toBe("不符合条件")
  })

  it("超长被拒绝", () => {
    expect(
      refundRejectionSchema.safeParse({
        adminNote: "啊".repeat(REFUND_ADMIN_NOTE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })
})
