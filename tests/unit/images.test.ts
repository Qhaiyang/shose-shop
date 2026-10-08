import { describe, expect, it } from "vitest"

import { moveItem } from "@/lib/images"

// ============================================================================
// 图片数组「上移 / 下移」的纯函数 —— 单元测试
//
// moveItem 是图片编辑器每一次点 ↑ / ↓ 都要调的底层函数。它的正确性
// 只在「移动第一个 / 移动最后一个 / 越界」这些边界上才会出问题，
// 而这些边界在页面上恰好又是被禁用按钮挡住、最难手工触发的 ——
// 所以单独抽成纯函数，把边界一条条钉进测试。
// ============================================================================

const A = ["a", "b", "c", "d"]

describe("moveItem：把元素挪到新位置，返回新数组", () => {
  it("向后移（下移）：下标 1 挪到 2", () => {
    expect(moveItem(A, 1, 2)).toEqual(["a", "c", "b", "d"])
  })

  it("向前移（上移）：下标 2 挪到 1", () => {
    expect(moveItem(A, 2, 1)).toEqual(["a", "c", "b", "d"])
  })

  it("相邻交换：下标 0 挪到 1", () => {
    expect(moveItem(A, 0, 1)).toEqual(["b", "a", "c", "d"])
  })

  it("跨多格：第一个挪到最后", () => {
    expect(moveItem(A, 0, 3)).toEqual(["b", "c", "d", "a"])
  })

  it("最后一个挪到最前", () => {
    expect(moveItem(A, 3, 0)).toEqual(["d", "a", "b", "c"])
  })

  it("位置不变：返回**同一个**数组引用，什么都不做", () => {
    expect(moveItem(A, 1, 1)).toBe(A)
  })

  it("from 越界：返回同一个数组引用", () => {
    expect(moveItem(A, -1, 1)).toBe(A)
    expect(moveItem(A, 4, 1)).toBe(A)
  })

  it("to 越界：返回同一个数组引用", () => {
    expect(moveItem(A, 1, -1)).toBe(A)
    expect(moveItem(A, 1, 4)).toBe(A)
  })

  it("不修改原数组", () => {
    const original = [...A]
    moveItem(A, 0, 2)
    expect(A).toEqual(original)
  })
})
