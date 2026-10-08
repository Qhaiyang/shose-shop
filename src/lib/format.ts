// ============================================================================
// 展示层格式化工具
//
// 数据库里所有金额都是「分」(Int)，展示给用户时才转成「元」。
// 这个转换只发生在最后一刻（渲染时），业务计算全程用分，避免浮点误差。
// ============================================================================

/**
 * 分 → 带符号的完整价格
 * 89900 → "¥899.00"
 */
export function formatPrice(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

/**
 * 分 → 元的数字文本，**不带货币符号**
 * 89900 → "899"，89950 → "899.50"
 *
 * 【为什么单独有一个不带符号的】
 * 优惠券的文案是「满 800 减 100」这种把金额嵌进句子里的形式，
 * 前面挂个 ¥ 会变成「满 ¥800 减 ¥100」—— 中文里不这么写。
 * 需要符号的地方用 formatPrice / formatPriceShort，
 * 这个函数只负责「数字怎么显示」，符号交给调用方拼。
 */
export function formatYuan(cents: number): string {
  const yuan = cents / 100
  // 整数就不显示小数位，有零头才显示
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
}

/**
 * 分 → 省略小数的价格（价格区间用，更紧凑）
 * 89900 → "¥899"（整数元不显示小数）
 * 89950 → "¥899.50"（有零头就补满两位，不会写成 "¥899.5"）
 */
export function formatPriceShort(cents: number): string {
  return `¥${formatYuan(cents)}`
}

/**
 * 把价格区间格式化成展示文案
 * 只有一个价位时不显示成 "¥899 ~ ¥899"
 */
export function formatPriceRange(min: number, max: number): string {
  if (min === max) return formatPriceShort(min)
  return `${formatPriceShort(min)} ~ ${formatPriceShort(max)}`
}

/**
 * 解析 Product.images 字段
 *
 * 因为 SQLite 不支持标量数组，images 存的是 JSON 字符串。
 * 数据库里的内容不可信（可能被手工改坏），所以解析失败要兜底返回空数组，
 * 而不是让整个页面崩掉。
 */
export function parseImages(raw: string | null | undefined): string[] {
  if (!raw) return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 只保留字符串元素，过滤掉混进来的 null / 数字
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    console.warn("[parseImages] images 字段不是合法 JSON:", raw)
    return []
  }
}
