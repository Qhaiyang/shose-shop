import { beforeEach, describe, expect, it } from "vitest"

import { getAllSizeGuides, getSizeGuides } from "@/lib/size-guide-db"
import { prisma, resetDb, resetSeq } from "./helpers/db"

// ============================================================================
// 尺码建议查询 —— 集成测试
//
// suggestSize 的匹配逻辑在单元测试里钉死了，这里测的是「查数据库」那半边：
// 按分类过滤、按脚长排序、全量排序顺序。
// ============================================================================

beforeEach(async () => {
  await resetDb()
  resetSeq()
})

/** 造一行尺码映射。默认用 ASCII 分类名，排序结果才确定（中文按 Unicode
 *  码点排，断言写起来又脆又难读，这里不测它） */
async function makeGuide(
  category: string,
  suggestedSize: string,
  footLengthMin: number,
) {
  return prisma.sizeGuide.create({
    data: {
      category,
      suggestedSize,
      footLengthMin,
      footLengthMax: footLengthMin + 0.5,
    },
  })
}

describe("getSizeGuides：按分类取尺码表", () => {
  it("只返回该分类，且按脚长升序", async () => {
    await makeGuide("running", "40", 24.75)
    await makeGuide("running", "39", 24.25)
    await makeGuide("basketball", "42", 25.75)

    const rows = await getSizeGuides("running")

    // 别的分类没混进来，脚长小的在前
    expect(rows.map((r) => r.suggestedSize)).toEqual(["39", "40"])
  })

  it("没有数据的分类返回空数组", async () => {
    await makeGuide("running", "40", 24.75)

    expect(await getSizeGuides("casual")).toEqual([])
  })
})

describe("getAllSizeGuides：全量查询", () => {
  it("先按分类、再按脚长排序", async () => {
    await makeGuide("running", "40", 24.75)
    await makeGuide("basketball", "42", 25.75)
    await makeGuide("running", "39", 24.25)

    const rows = await getAllSizeGuides()

    expect(
      rows.map((r) => `${r.category}:${r.suggestedSize}`),
    ).toEqual(["basketball:42", "running:39", "running:40"])
  })
})
