// ============================================================================
// 尺码建议（脚长 → 尺码）—— 纯函数部分
//
// 【为什么这个文件不 import prisma】
// 详情页的尺码助手是 Client Component，它要在浏览器里直接调
// parseFootLength / suggestSize / formatFootLength。如果这里 import 了
// prisma，浏览器打包就会顺着把 better-sqlite3（Node 原生模块）拉进来，
// 构建直接报 "Can't resolve 'fs'"。
// 所以「纯逻辑」放这个文件（客户端可安全导入），「查数据库」放到
// size-guide-db.ts（只在 Server Component 里用）。
//
// 【为什么匹配逻辑抽成纯函数 suggestSize】
// 和 moveItem 一个道理：「脚长落在哪个区间」这种边界判断，只有写进
// 单元测试才记得全（区间下界、上界、正好卡在边界、落在区间外）。
// ============================================================================

export type SizeGuideView = {
  id: string
  category: string
  footLengthMin: number
  footLengthMax: number
  suggestedSize: string
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

/** 脚长输入的合理下限 / 上限（cm）。范围放宽一点，别误伤极端的成人脚长 */
export const MIN_FOOT_LENGTH_CM = 15
export const MAX_FOOT_LENGTH_CM = 35

/**
 * 把用户输入的脚长解析成数字（cm）。
 *
 * 【为什么不用 parseFloat】
 * parseFloat("24abc") 会静默变成 24 —— 用户本想删掉重打，结果按 24 算了。
 * 这里和白名单正则一个思路：只接受「纯数字 + 一到两位小数」，
 * 不符合就返回 null，由 UI 层告诉用户该怎么改。
 */
export function parseFootLength(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(trimmed)) return null

  const value = Number(trimmed)
  if (value < MIN_FOOT_LENGTH_CM || value > MAX_FOOT_LENGTH_CM) return null
  return value
}

/**
 * 把脚长显示成简洁字符串：24.5 → "24.5"，24.25 → "24.25"，24 → "24"。
 * 数据库里 Float 会把 24.0 读成 24，直接 String 会得到 "24" 而不是 "24.0"，
 * 这里用 toFixed 抹掉浮点尾数再转 Number，去掉多余的 0。
 */
export function formatFootLength(cm: number): string {
  return String(Number(cm.toFixed(2)))
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

/**
 * 在给定分类的尺码表里，找出脚长落进的那一行。
 *
 * 区间约定是半开区间 [footLengthMin, footLengthMax)：
 *   - 26.0 落进尺码 42 的 [25.75, 26.25)
 *   - 26.25 恰好落进下一码，不会两码都命中
 * 找不到（脚长太小 / 太大、或这个分类根本没配）就返回 null。
 */
export function suggestSize(
  guides: SizeGuideView[],
  footLength: number,
): SizeGuideView | null {
  return (
    guides.find(
      (g) => footLength >= g.footLengthMin && footLength < g.footLengthMax,
    ) ?? null
  )
}
