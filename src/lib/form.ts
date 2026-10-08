// ============================================================================
// 表单输入的解析
//
// 【为什么这些函数不放在 actions/admin.ts 里】
// 因为那个文件的第一行是 "use server"。Next 要求这种文件**只能导出
// async 函数** —— 一个同步的纯函数放进去，构建时就会报错。
//
// 表面上看只是「挪个位置」，实际上带来两个实在的好处：
//   1. 纯函数能直接写测试。Server Action 依赖 next/cache、next/navigation
//      这些只有请求上下文里才有的东西，脱离 Next 根本调不起来
//   2. 「字符串 → 数字」这类容易出错、又反复被调用的转换，集中在一处，
//      改一次全都跟着改
//
// 记住这个分界：**action 负责鉴权和编排，纯逻辑放进 lib**。
// action 越薄，能出错的地方越少。
// ============================================================================

/** 一款商品最多几张图 */
export const MAX_IMAGES = 8

/**
 * 把用户输入的「元」转成数据库里的「分」。
 *
 * 【为什么不用 parseFloat(x) * 100】
 * 浮点数算不出这个：
 *     parseFloat("0.29") * 100  ===  28.999999999999996
 * 这次 Math.round 能救回来，换个数字就未必 —— 那是在赌，不是在算。
 *
 * 正确做法是**当成字符串处理**，自己拆小数点：
 *     "0.29" → "0" × 100 + "29" = 29
 * 全程只有整数参与运算，永远不会差一分钱。
 *
 * 金额这种东西，只要有一个环节用了浮点，整条链路就不可信了。
 * 所以这里连 parseFloat 都不让它出现。
 *
 * @param input 用户原始输入。故意收 unknown：调用方可能传进来 undefined，
 *              而一个宽容的签名能逼着每个分支都想清楚
 * @returns 解析失败返回 null，由调用方决定报什么错
 */
export function parseYuanToCents(input: unknown): number | null {
  if (typeof input !== "string") return null

  const trimmed = input.trim()
  // 只接受「纯数字」或「数字 + 一到两位小数」。
  // 写死格式比 parseFloat 那种宽容（"12abc" 也能变成 12）安全得多 ——
  // 用户输错时我们宁可报错，也不要静默地按一个他没想过的数字成交
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(trimmed)) return null

  const [yuan, fraction = ""] = trimmed.split(".")
  // padEnd 处理 "8.5" 这种只有一位小数的情况：小数位补成 "50" 分
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0"))
}

/**
 * 把多行文本解析成图片路径数组。
 *
 * 表单里让用户一行贴一个路径，比做一套上传 / 拖拽界面简单得多，
 * 也不需要引入对象存储。前台的图就是 public/shoes/ 下的本地 SVG，
 * 所以不强制 http(s)，相对路径更好用。
 */
export function parseImageLines(input: unknown): string[] {
  if (typeof input !== "string") return []

  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  // 去重：同一个路径贴两遍没意义，还会让前台的商品图轮播出现两张一样的。
  // 用 indexOf 判重对几十张图来说足够了，不值得为此建一个 Set
  const unique = lines.filter((line, index) => lines.indexOf(line) === index)

  return unique.slice(0, MAX_IMAGES)
}

/**
 * 解析 <input type="date"> 送来的日期字符串（"2026-10-31"）。
 *
 * 【为什么不能直接 new Date("2026-10-31")】
 * 那个写法会被当成 **UTC** 的零点，于是东八区（UTC+8）拿到的是
 * 10 月 31 日 08:00。看着是「差了几小时」，实际后果是：
 * 管理员填「10 月 31 日截止」，用户在北京时间 10 月 31 日早上 7 点
 * 用这张券会被判「已过期」。日期输入是**日历上的那一天**，
 * 不是某个绝对时刻 —— 所以必须用「年月日」分段构造成本地时间。
 *
 * 用 new Date(y, m, d) 构造还有一个好处：2 月 30 日、13 月这类
 * 不存在的日期会被 Date 自动进位/回绕（2 月 30 日变成 3 月 2 日）。
 * 所以我们先卡正则，再构造，最后还回过头对一次年月日 ——
 * 回绕过的值对不上，说明输入的是非法日期。
 *
 * @returns 解析失败返回 null（zod 会报「请选择开始/结束时间」）
 */
export function parseDateInput(input: unknown): Date | null {
  if (typeof input !== "string") return null

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) return null

  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))

  // 回绕检查：Date(2026, 1, 30) 会变成 3 月 2 日，这里的 30 ≠ 2，判非法
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null
  }

  return date
}

/** 把 Date 反向格式化成 <input type="date"> 认的 "YYYY-MM-DD"（本地时间） */
export function formatDateInput(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/**
 * 解析「非负整数」输入框。
 *
 * 【为什么要有这个函数】
 * Number("") 是 0，Number("  ") 也是 0。
 * 所以「库存留空」会被悄悄当成「库存 0」，用户以为自己填了 0，
 * 实际上是没填。这里返回 NaN，交给 zod 报「必须是数字」——
 * **把「缺失」和「0」区分开**，是表单处理里最常被忽略的一件事。
 */
export function parseNonNegativeInt(input: unknown): number {
  if (typeof input !== "string") return Number.NaN

  const trimmed = input.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/**
 * 把表单里带过来的 next 参数收窄成「安全的站内路径」。
 *
 * 【这是防开放重定向（open redirect）】
 * 如果直接 redirect(formData.get("next"))，攻击者可以构造这样的链接：
 *     https://你的站点/login?next=https://钓鱼站.com
 * 用户看到的是自己信任的域名，登录完却被弹到钓鱼站，很容易继续输密码。
 *
 * 只放行以单个 "/" 开头的相对路径。
 * 特别注意要挡掉 "//evil.com" —— 浏览器会把 // 开头的地址当成
 * 「协议相对 URL」，等价于 https://evil.com，同样能跳出去。
 *
 * 【为什么放在 form.ts】
 * 它和上面几个函数是同一类东西：把**不可信的输入**变成一个**可信的值**。
 * 唯一的区别是产出物不是数字或数组，而是一个路径。
 * 这个判据（输入可信吗）比分「是数字还是字符串」更有意义。
 *
 * 【为什么这个函数值得单独拎出来】
 * 它短到只有五行，但它是**安全控制**。这类代码的共同特点是：
 * 写错了不会有任何报错，只会静默地多出一条攻击路径。
 * 所以它必须能被测试覆盖 —— 见 tests/unit/form.test.ts。
 *
 * @param value 直接来自 formData.get("next")，故意收 unknown
 * @returns 永远是站内路径，拿不准就回落到首页
 */
export function safeNext(value: unknown): string {
  const raw = typeof value === "string" ? value : ""

  // 必须以 "/" 开头（排除 "https://evil.com"、"javascript:..." 这类）
  // 且不能以 "//" 开头（排除 "//evil.com" 这种协议相对 URL）
  // 反斜杠也要挡："\\/evil.com" 在部分浏览器里等价于 "//evil.com"
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/products"
  }

  return raw
}
