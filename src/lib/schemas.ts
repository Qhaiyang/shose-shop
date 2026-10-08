// ============================================================================
// 所有 zod 校验规则
//
// 【为什么这些 schema 不放在各个 action 文件里】
// 和 src/lib/form.ts 是同一个理由，但这次是被**测试**逼出来的。
//
// Next 要求 "use server" 文件只能导出 async 函数。而 zod schema 是普通常量，
// 它必须是模块私有的 —— 于是就有了这个尴尬的局面：
//
//     const loginSchema = z.object({ ... })   // ← 定义在 actions/auth.ts 里
//
// 定义在这儿，外面看不见；想写单元测试就得把 actions/auth.ts import 进来，
// 而那个文件依赖 next/cache、next/navigation、Prisma 客户端，
// 脱离 Next 的请求上下文根本跑不起来。结果是**校验规则没法测**。
//
// 把 schema 挪到 lib 之后，规则变成了一个纯粹的、任何人都能 import 的值：
//   1. 测试可以直接 import 它，不需要启动 Next、不需要数据库
//   2. 「密码至少 8 位」这类规则只有一处定义，action 和测试看的是同一份
//
// 记住这条分界线的两种表现：
//   - 纯函数（元→分）      → 放 lib/form.ts
//   - 校验规则（这个字段合不合法）→ 放这里
//   action 只负责「鉴权 + 编排 + 把 schema 的结果翻译成 UI 状态」。
//
// 【为什么校验规则和错误文案写在一起】
// 因为它们是同一件事的两面：「密码至少 8 位」既是规则也是给用户看的话。
// 拆成两份迟早会对不上 —— 改了规则忘了改文案，用户就会看到一句
// 和自己的输入无关的提示。
// ============================================================================

import { z } from "zod"

import {
  BULK_MAX_PRODUCTS,
  COUPON_CODE_MAX_LENGTH,
  COUPON_CODE_MIN_LENGTH,
  COUPON_MAX_PERCENT,
  COUPON_MAX_PER_USER_LIMIT,
  COUPON_MAX_TOTAL_LIMIT,
  COUPON_TYPE,
  MAX_PRICE_CENTS,
  MAX_STOCK_DELTA,
  ORDER_NOTE_MAX_LENGTH,
  REFUND_ADMIN_NOTE_MAX_LENGTH,
  REFUND_DESCRIPTION_MAX_LENGTH,
  REFUND_REASON_VALUES,
} from "@/lib/constants"
import { normalizeCouponCode } from "@/lib/coupons"
import { MAX_IMAGES } from "@/lib/form"
import {
  REVIEW_MAX_CONTENT,
  REVIEW_MAX_IMAGES,
  REVIEW_MAX_RATING,
  REVIEW_MIN_CONTENT,
  REVIEW_MIN_RATING,
} from "@/lib/reviews"

// ---------------------------------------------------------------------------
// 认证（src/app/actions/auth.ts 使用）
// ---------------------------------------------------------------------------

/**
 * 邮箱字段：先 trim + 转小写，再校验格式。
 *
 * 【为什么用 .pipe() 而不是 z.email().trim()】
 * zod 的转换（trim/toLowerCase）和校验是按书写顺序执行的。
 * 写 z.email().trim() 的话，格式校验发生在 trim 之前 ——
 * 用户从别处粘贴进来带空格的邮箱 " foo@bar.com " 会直接被判为非法。
 * 先 z.string().trim().toLowerCase() 把值洗干净，再 pipe 给 z.email() 校验，
 * 才是我们想要的顺序。
 *
 * 【为什么要转小写】
 * 邮箱的用户名部分理论上区分大小写，但实际上没有邮件服务商这么做。
 * 统一转小写，避免 Foo@bar.com 和 foo@bar.com 注册出两个账号。
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "请输入有效的邮箱地址" }))

export const loginSchema = z.object({
  email: emailSchema,
  // 登录时不校验密码强度 —— 那会把「密码太短」这种信息泄露给攻击者，
  // 而且老用户的密码规则可能和新规则不一样。只要非空即可，对不对交给 bcrypt。
  password: z.string().min(1, { error: "请输入密码" }),
})

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: "昵称至少 2 个字符" })
    .max(20, { error: "昵称最多 20 个字符" }),
  email: emailSchema,
  password: z
    .string()
    .min(8, { error: "密码至少 8 位" })
    .max(72, { error: "密码最多 72 位" })
    // 72 是 bcrypt 的上限而不是随便定的：bcrypt 只取前 72 字节，
    // 更长的部分会被静默丢弃。不挡住的话，用户以为设了 100 位的强密码，
    // 实际生效的只有前 72 位
    .regex(/[a-zA-Z]/, { error: "密码需要包含字母" })
    .regex(/[0-9]/, { error: "密码需要包含数字" }),
})

// ---------------------------------------------------------------------------
// 购物车（src/app/actions/cart.ts 使用）
// ---------------------------------------------------------------------------

export const skuIdSchema = z.string().min(1)

// 数量上限 99 是业务决定：一件商品一次最多买 99 件，
// 免得有人填 999999 把库存一次性占满
export const quantitySchema = z.number().int().positive().max(99)

// 用组合而不是重新写一遍字面量 —— 否则「数量上限」这件事就有两个定义，
// 改了一处忘了另一处，两个入口的行为就悄悄分叉了
export const cartLineSchema = z.object({
  skuId: skuIdSchema,
  quantity: quantitySchema,
})

// ---------------------------------------------------------------------------
// 下单（src/app/actions/order.ts 使用）
// ---------------------------------------------------------------------------

/**
 * 订单备注：选填。
 *
 * 【为什么最后要 transform 成 null，而不是留着空串】
 * 表单里没填就是 ""，直接存进去的话，数据库里「没写备注」会同时有两种
 * 表示：NULL 和 ""。之后想查「有多少订单带备注」就得写
 * `note IS NOT NULL AND note != ''` —— 这种「两个空值」的坑会一直
 * 传染到每个查询里。归一成 NULL，判断就只剩 `note IS NOT NULL`。
 *
 * 放在 checkoutSchema 外面单独定义，是因为下单和「订单详情页改备注」
 * 走的是同一个规则 —— 两处各写一遍迟早会分叉（比如一处改了上限）。
 */
export const orderNoteSchema = z
  .string()
  .trim()
  .max(ORDER_NOTE_MAX_LENGTH, {
    error: `备注最多 ${ORDER_NOTE_MAX_LENGTH} 个字，写关键的就行`,
  })
  .transform((value) => (value === "" ? null : value))

export const checkoutSchema = z.object({
  address: z
    .string()
    .trim()
    .min(5, { error: "收货地址至少 5 个字" })
    .max(120, { error: "收货地址最多 120 个字" }),
  phone: z
    .string()
    .trim()
    // 只认大陆手机号：1 开头，第二位 3-9，共 11 位。
    // 用 \d 而不是 [0-9] 会顺带匹配全角数字和阿拉伯-印度数字，
    // 所以这里坚持用显式的字符类
    .regex(/^1[3-9]\d{9}$/, { error: "请输入有效的 11 位手机号" }),
  // 选填：买家不写备注是常态。
  // 【为什么还要 .optional().transform() 兜一层】
  // createOrderAction 会把缺失的字段补成空串再送进来，但 checkoutSchema
  // 的调用方不止那一个。直接构造对象来调（测试、脚本）时「根本没这个键」
  // 和「给了个空串」必须是同一个结果 —— 都是 null。
  // 不然「没写备注」在库里会变成 undefined 和 NULL 两种写法，
  // 而 orderNoteSchema 的注释里说好了只留一个表示
  note: orderNoteSchema.optional().transform((value) => value ?? null),
})

// ---------------------------------------------------------------------------
// 后台商品 / SKU（src/app/actions/admin.ts 使用）
// ---------------------------------------------------------------------------

export const productSchema = z.object({
  name: z
    .string()
    .min(1, { error: "商品名称不能为空" })
    .max(60, { error: "商品名称最多 60 个字" }),
  description: z
    .string()
    .min(1, { error: "商品描述不能为空" })
    .max(2000, { error: "商品描述最多 2000 个字" }),
  category: z
    .string()
    .min(1, { error: "分类不能为空" })
    .max(20, { error: "分类最多 20 个字" }),
  images: z
    .array(z.string().max(300, { error: "单个图片路径最多 300 个字符" }))
    .max(MAX_IMAGES, { error: `最多 ${MAX_IMAGES} 张图` }),
})

export const skuSchema = z.object({
  // 尺码不一定是纯数字 —— 衣服鞋子也可能是 XL / 42.5，
  // 所以用白名单字符而不是 \d+。白名单的好处是「只允许我想到的」，
  // 而不是「排除我想到的坏字符」——后者永远列不全
  size: z
    .string()
    .min(1, { error: "尺码不能为空" })
    .max(10, { error: "尺码最多 10 个字符" })
    .regex(/^[0-9A-Za-z.-]+$/, { error: "尺码只能包含数字、字母、小数点和横杠" }),
  color: z
    .string()
    .min(1, { error: "颜色不能为空" })
    .max(20, { error: "颜色最多 20 个字" }),
  stock: z
    .number({ error: "库存必须是数字" })
    .int({ error: "库存必须是整数" })
    .min(0, { error: "库存不能为负数" })
    .max(999_999, { error: "库存最多 999999" }),
})

// ---------------------------------------------------------------------------
// 后台批量操作（src/app/actions/admin.ts 使用）
//
// 【为什么这批规则也要放进 lib】
// 批量操作是「一次改很多东西」，所以它的校验比单个操作重要得多 ——
// 单条改错了只错一个，批量改错了错一片。而越重要的规则越需要测试。
// 放在 action 文件里就只能靠手工点页面来验，这里能直接把边界值喂进去。
// ---------------------------------------------------------------------------

/**
 * 一批商品的 id。
 *
 * 上限不是「技术上不行」，是**故意设的刹车**：
 * 批量操作全程在一个事务里，勾得越多，持有写锁的时间越长，
 * 期间所有买家下单都在排队。真需要改几千个商品，那是另一个功能
 * （后台任务 + 分批执行），不该由管理员点一下按钮触发。
 */
export const bulkProductIdsSchema = z
  .array(z.string().min(1).max(64))
  .min(1, { error: "请先勾选要操作的商品" })
  .max(BULK_MAX_PRODUCTS, {
    error: `一次最多操作 ${BULK_MAX_PRODUCTS} 款商品，请分批进行`,
  })

/**
 * 批量改价。
 *
 * 【为什么用 discriminatedUnion 而不是 value + 一个 mode 字段】
 * 两种模式下 value 的**含义完全不同**：
 *   percent 模式是「调整幅度」（-90 ~ 500，可以负数）
 *   set 模式是「新的单价」（1 分 ~ MAX_PRICE_CENTS，不能负数）
 * 如果用一个松散的 object 描述，就没法给它们各自不同的范围 ——
 * 只能取一个宽松的交集，于是「-50 元的单价」这种荒谬输入会被放进来。
 * 判别联合让每个分支有自己独立的规则，zod 还能根据 mode 自动收窄类型。
 */
export const bulkPriceSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("percent"),
    // 上限 +500% 是防手滑（多打一位数），下限 -90% 是硬约束：
    // 降价 100% 会让价格变成 0，等于白送 —— 那应该是下架，不是改价
    value: z
      .number({ error: "百分比必须是数字" })
      .int({ error: "百分比必须是整数" })
      .min(-90, { error: "最多降价 90%，再低就该直接下架了" })
      .max(500, { error: "最多上调 500%" }),
  }),
  z.object({
    mode: z.literal("set"),
    value: z
      .number({ error: "价格必须是数字" })
      .int({ error: "价格精度只到分" })
      .min(1, { error: "价格必须大于 0" })
      .max(MAX_PRICE_CENTS, { error: "价格超出上限，请检查是不是多打了一位" }),
  }),
])

/**
 * 批量调库存的增减量。
 *
 * 【为什么 0 是错误而不是「什么都不做」】
 * 和 adjustSkuStock 的理由一样：让它成功返回的话，界面会弹出
 * 「已给 12 个规格入库 0 件」—— 管理员以为改了什么，其实什么都没发生。
 * 把无效输入伪装成成功，比直接报错难查一百倍。
 */
export const bulkStockDeltaSchema = z
  .number({ error: "调整数量必须是数字" })
  .int({ error: "调整数量必须是整数" })
  .min(-MAX_STOCK_DELTA, { error: `单次最多出库 ${MAX_STOCK_DELTA} 件` })
  .max(MAX_STOCK_DELTA, { error: `单次最多入库 ${MAX_STOCK_DELTA} 件` })
  .refine((value) => value !== 0, { error: "调整数量不能是 0" })

// ---------------------------------------------------------------------------
// 商品评价（src/app/actions/review.ts 使用）
// ---------------------------------------------------------------------------

/**
 * 提交评价。
 *
 * 【为什么 rating 这里用 number 而不是直接收表单字符串】
 * 表单一律是字符串。但「"5" 是不是合法星级」这件事属于解析，不属于校验 ——
 * 解析放 src/lib/reviews.ts 的 parseRating（它有单元测试），
 * 校验放这里。两边各管一段，parseRating 返回 null 时 zod 会顺理成章地
 * 报出「请先选择星级」，不需要在 action 里再写一个 if。
 *
 * 【为什么图片共用 parseImageLines 却限制得更严】
 * 后台商品表单允许 8 张图，评价只允许 3 张 —— 买家随手拍的图不该比
 * 商品主图还多。用同一套「一行一个路径」的解析，只是上限不同，
 * 超过上限时**报错而不是静默截断**：用户以为传了 5 张，实际只发了 3 张，
 * 这种「悄悄少了几张」最难被发现。
 */
export const reviewSchema = z.object({
  rating: z
    .number({ error: "请先选择星级" })
    .int({ error: "星级必须是整数" })
    .min(REVIEW_MIN_RATING, { error: "请先选择星级" })
    .max(REVIEW_MAX_RATING, { error: "星级最多 5 星" }),
  content: z
    .string()
    .trim()
    .min(REVIEW_MIN_CONTENT, {
      error: `评价至少写 ${REVIEW_MIN_CONTENT} 个字，让后来的人能看到有用的信息`,
    })
    .max(REVIEW_MAX_CONTENT, { error: `评价最多 ${REVIEW_MAX_CONTENT} 个字` }),
  images: z
    .array(z.string().max(300, { error: "单个图片路径最多 300 个字符" }))
    .max(REVIEW_MAX_IMAGES, { error: `最多 ${REVIEW_MAX_IMAGES} 张图` }),
})

// ---------------------------------------------------------------------------
// 后台优惠券（src/app/actions/admin.ts 使用）
// ---------------------------------------------------------------------------

/**
 * 券码：字母数字下划线横杠，统一转大写后入库。
 *
 * 【为什么要限定字符集】
 * 券码将来是要被「念出来」「抄下来」「贴在纸上」的。中文券码没法口述，
 * 空格和标点会在复制粘贴时被弄丢。白名单比黑名单可靠 —— 和 skuSchema
 * 的 size 是同一个理由（见那里的注释）。
 */
export const couponCodeSchema = z
  .string()
  .trim()
  .min(COUPON_CODE_MIN_LENGTH, {
    error: `券码至少 ${COUPON_CODE_MIN_LENGTH} 位，太短的码别人随手就猜到了`,
  })
  .max(COUPON_CODE_MAX_LENGTH, { error: `券码最多 ${COUPON_CODE_MAX_LENGTH} 位` })
  .regex(/^[A-Za-z0-9_-]+$/, { error: "券码只能包含字母、数字、下划线和横杠" })
  // 大小写不敏感：用户念 "save10" 和 "SAVE10" 是同一张券。
  // 归一化规则只写在 normalizeCouponCode 一处，表单和查询共用
  .transform(normalizeCouponCode)

/**
 * 优惠券的发放参数。金额一律是「分」。
 *
 * 【为什么用 discriminatedUnion 按 type 分开写】
 * 和 bulkPriceSchema 是同一个理由，而且这里更尖锐：两种券的 value
 * **单位根本不同** —— FIXED 是「减免多少分」，PERCENT 是「减掉几个
 * 百分点」。用一个松散的 object 描述的话，value 只能取两者的并集
 * （1 ~ MAX_PRICE_CENTS），于是「9.9 折写成 value = 9900」这种
 * 输入会被放行 —— 那是一张「减 9900% 」的券。
 * 判別联合让每个分支有自己的范围，zod 还能自动收窄类型：
 * 校验通过后能在 PERCENT 分支里确定 maxDiscount 不是 null。
 *
 * 【为什么 maxDiscount 在 FIXED 分支写成 z.null() 而不是干脆不要这个键】
 * 表单是同一个表单，从前端看两种券的字段是同一批。如果 FIXED 分支里
 * 没有这个键，action 就得判断「现在是不是 PERCENT，要不要把 maxDiscount
 * 塞进去」—— 一个「漏传了也不报错」的分支。写成 z.null() 之后，
 * action 永远传这个键（满减券传 null），传错值会被当场拒绝。
 * 宁可在参数上多写一个 null，也不要一个会静默漏字段的分支。
 *
 * 【为什么这些不写进 .default()】
 * 喂进来的值来自表单，是「已经解析好的数字」。默认值属于解析层
 * （src/lib/form.ts 的 parseNonNegativeInt 负责空串），
 * 校验层只负责「这个值合不合法」。两边各管一段，混起来的话
 * 「没填」和「填了 0」又会分不清（这个坑在 parseNonNegativeInt
 * 的注释里详细写过）。
 */
/**
 * 两种券共用的字段。
 *
 * 【为什么要抽成一个对象再展开，而不是在两个分支里各写一遍】
 * 这些字段有 7 个，每个都带一段错误文案。抄两遍的话，改一处忘一处，
 * 两张券的校验规则就悄悄不一样了 —— 而且这种分叉没有任何测试能发现，
 * 因为两边「各自都是对的」。
 */
const couponSharedShape = {
  code: couponCodeSchema,
  minSpend: z
    .number({ error: "门槛金额必须是数字" })
    .int({ error: "金额精度只到分" })
    .min(0, { error: "门槛金额不能为负数" })
    .max(MAX_PRICE_CENTS, { error: "金额超出上限，请检查是不是多打了一位" }),
  startAt: z.date({ error: "请选择开始时间" }),
  endAt: z.date({ error: "请选择结束时间" }),
  totalLimit: z
    .number({ error: "发放总量必须是数字" })
    .int({ error: "发放总量必须是整数" })
    .min(1, { error: "发放总量至少是 1" })
    .max(COUPON_MAX_TOTAL_LIMIT, {
      error: "发放总量超出上限，请检查是不是多打了一位",
    }),
  perUserLimit: z
    .number({ error: "每人限领必须是数字" })
    .int({ error: "每人限领必须是整数" })
    .min(1, { error: "每人限领至少是 1" })
    .max(COUPON_MAX_PER_USER_LIMIT, {
      error: `每人限领最多 ${COUPON_MAX_PER_USER_LIMIT}`,
    }),
  isActive: z.boolean(),
}

export const couponSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...couponSharedShape,
      type: z.literal(COUPON_TYPE.FIXED),
      value: z
        .number({ error: "减免金额必须是数字" })
        .int({ error: "金额精度只到分" })
        .min(1, { error: "减免金额必须大于 0" })
        .max(MAX_PRICE_CENTS, { error: "金额超出上限，请检查是不是多打了一位" }),
      maxDiscount: z.null({ error: "满减券不需要填封顶金额" }),
    }),
    z.object({
      ...couponSharedShape,
      type: z.literal(COUPON_TYPE.PERCENT),
      // PERCENT 的 value 是「减掉的百分点」：10 表示 9 折，15 表示 8.5 折。
      // 上限 99 而不是 100，理由见 COUPON_MAX_PERCENT 的注释（减 100% = 白送）
      value: z
        .number({ error: "折扣百分比必须是数字" })
        .int({ error: "折扣百分比必须是整数，比如 9 折填 10" })
        .min(1, { error: "折扣百分比至少是 1" })
        .max(COUPON_MAX_PERCENT, {
          error: `折扣百分比最多 ${COUPON_MAX_PERCENT}，减 100% 就是白送了`,
        }),
      // PERCENT 必须封顶：不封顶的话，买台一万块的机器一张券就减一千
      maxDiscount: z
        .number({ error: "折扣券必须填封顶金额" })
        .int({ error: "金额精度只到分" })
        .min(1, { error: "封顶金额必须大于 0" })
        .max(MAX_PRICE_CENTS, { error: "金额超出上限，请检查是不是多打了一位" }),
    }),
  ])
  // ---- 下面两条是「字段之间」的规则，单看任何一个字段都发现不了 ----
  .refine((data) => data.endAt > data.startAt, {
    path: ["endAt"],
    error: "结束时间必须晚于开始时间",
  })
  // 每人限领 > 发放总量，几乎一定是把两个输入框填反了。
  // 放过去也不会出错（第 51 个人的第 51 次领取会先撞上总量限制），
  // 但那种「配置本身就没意义」的券会在半年后变成一句
  // 「为什么这张券没人领得到」的排查工单 —— 不如现在就拦住
  .refine((data) => data.perUserLimit <= data.totalLimit, {
    path: ["perUserLimit"],
    error: "每人限领不能超过发放总量",
  })

// ---------------------------------------------------------------------------
// 退款（src/app/actions/refund.ts 使用）
// ---------------------------------------------------------------------------

/**
 * 买家提交退款申请。
 *
 * 【为什么 reason 用 z.enum 而不是 z.string()】
 * 原因是下拉框，理论上只可能是那四个值。但表单是**可以被绕过的** ——
 * 手改一下 POST 体就能塞任何字符串进来。如果这里收自由文本，
 * 数据库里就会混进「size」「尺码」「SIZE 」这类同义不同形的值，
 * 「按原因统计退款」这个功能当场作废。用 z.enum 卡死取值，
 * 统计和文案映射（REFUND_REASON_LABEL）就都不用做脏数据兼容。
 *
 * 【为什么 description 是 optional 而不是 required】
 * 「尺码不合适」这种原因本身就说明白了，再逼着写一段话
 * 只会得到「不合适」三个字。但「其他」不写就什么信息都没有 ——
 * 这条字段之间的规则交给页面上的提示（required 由 UI 控制），
 * 校验层不拦。理由和 orderNoteSchema 一样：选填就是选填。
 */
export const refundRequestSchema = z.object({
  reason: z.enum(REFUND_REASON_VALUES, { error: "请选择退款原因" }),
  description: z
    .string()
    .trim()
    .max(REFUND_DESCRIPTION_MAX_LENGTH, {
      error: `补充说明最多 ${REFUND_DESCRIPTION_MAX_LENGTH} 个字`,
    })
    // 空串统一成 null。为什么不留 ""：数据库里 "" 和 NULL 是两种「没有」，
    // 页面判空时就得写两遍（!value || value === ""），漏一处就渲染出一个空行。
    // 这个取舍在 orderNoteSchema 的注释里写过，这里保持一致。
    .optional()
    .transform((value) => (value ? value : null)),
})

/**
 * 管理员拒绝退款时填的理由。
 *
 * 【为什么这里 min(1) 而买家说明不设下限】
 * 拒绝退款必须给理由，这不是体验问题而是纠纷问题：买家看到「已拒绝」
 * 却不知道凭什么，下一步只会来投诉。管理员多打十个字，客服少接一通电话。
 */
export const refundRejectionSchema = z.object({
  adminNote: z
    .string({ error: "请填写拒绝理由" })
    .trim()
    .min(1, { error: "请填写拒绝理由" })
    .max(REFUND_ADMIN_NOTE_MAX_LENGTH, {
      error: `拒绝理由最多 ${REFUND_ADMIN_NOTE_MAX_LENGTH} 个字`,
    }),
})
