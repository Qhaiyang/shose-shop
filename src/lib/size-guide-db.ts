import { prisma } from "@/lib/prisma"
import type { SizeGuideView } from "@/lib/size-guide"

// ============================================================================
// 尺码建议的数据库查询（只在 Server Component / Server Action 里用）
//
// 纯逻辑（解析 / 匹配 / 格式化）在 size-guide.ts，那里不 import prisma，
// 客户端可以安全导入。查询单独放这个文件，和 products.ts 一个定位：
// 只负责「取数据」，不做 React 相关的事。
// ============================================================================

/** 某个分类的尺码表，按脚长从小到大排 */
export async function getSizeGuides(category: string): Promise<SizeGuideView[]> {
  return prisma.sizeGuide.findMany({
    where: { category },
    orderBy: { footLengthMin: "asc" },
  })
}

/** 全部分类的尺码表，后台只读展示用。先按分类、再按脚长排 */
export async function getAllSizeGuides(): Promise<SizeGuideView[]> {
  return prisma.sizeGuide.findMany({
    orderBy: [{ category: "asc" }, { footLengthMin: "asc" }],
  })
}
