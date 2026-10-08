import { describe, expect, it } from "vitest"

import { startOfDay, startOfTomorrow, todayRange } from "@/lib/dates"

// ============================================================================
// 自然日边界 —— 单元测试
//
// 【为什么这些用例都要自己指定 now】
// 不指定的话，测试跑起来的时刻就是「现在」。那样有两个问题：
//   1. 跨零点那一瞬间跑，结果会飘 —— 一个偶尔红的测试比没有测试更糟，
//      它会让你开始怀疑所有失败
//   2. 「月/年/闰年边界」这种用例根本没法写
// 所以设计 API 时就把 now 留成了参数（默认 new Date()），
// 测试传死值，生产不用管。
// ============================================================================

describe("startOfDay：抹到当天 00:00", () => {
  it("把一个下午的时刻抹到当天零点", () => {
    const at = new Date(2026, 2, 15, 14, 37, 12, 456)
    const start = startOfDay(at)

    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(2) // 0-based，2 就是 3 月
    expect(start.getDate()).toBe(15)
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(start.getSeconds()).toBe(0)
    expect(start.getMilliseconds()).toBe(0)
  })

  it("本来就是零点的时刻，保持不变", () => {
    const at = new Date(2026, 5, 1, 0, 0, 0, 0)
    expect(startOfDay(at).getTime()).toBe(at.getTime())
  })

  it("不修改传进来的对象", () => {
    // 【为什么这条一定要测】
    // 如果 startOfDay 里写的是 date.setHours(...) 而不是 new Date(date)，
    // 它就会**把调用方手里的那个 Date 改掉**。
    // 这种 bug 特别难查：出错的地方和造成错误的地方隔着好几个函数，
    // 而且症状是「某个我没碰过的变量值变了」。
    // 日期工具一律「只读入参、返回新对象」，这条用例把它钉住
    const original = new Date(2026, 0, 10, 15, 30)
    const before = original.getTime()

    startOfDay(original)

    expect(original.getTime()).toBe(before)
  })
})

describe("startOfTomorrow：明天 00:00", () => {
  it("比 startOfDay 正好晚一天", () => {
    const at = new Date(2026, 2, 15, 14, 0)
    const day = 24 * 60 * 60 * 1000

    expect(startOfTomorrow(at).getTime() - startOfDay(at).getTime()).toBe(day)
  })

  it("月末：1 月 31 日的明天是 2 月 1 日", () => {
    // 手写 if (date > 28) 之类的话，这种地方必错
    const at = new Date(2026, 0, 31, 9, 0)
    const tomorrow = startOfTomorrow(at)

    expect(tomorrow.getMonth()).toBe(1) // 2 月
    expect(tomorrow.getDate()).toBe(1)
  })

  it("年末：12 月 31 日的明天是次年 1 月 1 日", () => {
    const at = new Date(2026, 11, 31, 23, 59, 59, 999)
    const tomorrow = startOfTomorrow(at)

    expect(tomorrow.getFullYear()).toBe(2027)
    expect(tomorrow.getMonth()).toBe(0)
    expect(tomorrow.getDate()).toBe(1)
  })

  it("闰年：2028 年 2 月 28 日的明天是 2 月 29 日", () => {
    // 2028 能被 4 整除且不是整百年 → 闰年
    const at = new Date(2028, 1, 28, 12, 0)
    const tomorrow = startOfTomorrow(at)

    expect(tomorrow.getMonth()).toBe(1)
    expect(tomorrow.getDate()).toBe(29)
  })

  it("平年：2026 年 2 月 28 日的明天是 3 月 1 日", () => {
    const at = new Date(2026, 1, 28, 12, 0)
    const tomorrow = startOfTomorrow(at)

    expect(tomorrow.getMonth()).toBe(2) // 3 月
    expect(tomorrow.getDate()).toBe(1)
  })
})

describe("todayRange：左闭右开的区间", () => {
  it("区间跨度正好 24 小时", () => {
    const { gte, lt } = todayRange(new Date(2026, 6, 20, 8, 0))
    expect(lt.getTime() - gte.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it("今天 00:00:00.000 落在区间内", () => {
    // 左端点是「闭」的：零点整那一刻属于今天
    const now = new Date(2026, 6, 20, 8, 0)
    const { gte, lt } = todayRange(now)

    const midnight = new Date(2026, 6, 20, 0, 0, 0, 0)
    expect(midnight.getTime()).toBeGreaterThanOrEqual(gte.getTime())
    expect(midnight.getTime()).toBeLessThan(lt.getTime())
  })

  it("23:59:59.999 落在区间内，明天 00:00:00.000 落在区间外", () => {
    // 【这条是整个文件里最该记住的】
    // 如果右端点写成 lte 23:59:59，那么 23:59:59.500 下的单
    // 今天不认、明天也不认 —— 凭空消失。
    // 左闭右开就刚好接上：今天 [00:00, 24:00) + 明天 [00:00, 24:00) = 不重不漏
    const now = new Date(2026, 6, 20, 8, 0)
    const { gte, lt } = todayRange(now)

    const lastMs = new Date(2026, 6, 20, 23, 59, 59, 999)
    const nextMidnight = new Date(2026, 6, 21, 0, 0, 0, 0)

    expect(lastMs.getTime()).toBeLessThan(lt.getTime())
    expect(lastMs.getTime()).toBeGreaterThanOrEqual(gte.getTime())

    // 明天零点正好是右端点，不属于今天
    expect(nextMidnight.getTime()).toBe(lt.getTime())
  })

  it("昨天 23:59:59.999 落在区间外", () => {
    const now = new Date(2026, 6, 20, 8, 0)
    const { gte } = todayRange(now)

    const lastNight = new Date(2026, 6, 19, 23, 59, 59, 999)
    expect(lastNight.getTime()).toBeLessThan(gte.getTime())
  })

  it("连续两天的区间首尾相接，不重不漏", () => {
    // 这是「左闭右开」在数学上唯一要满足的性质
    const today = todayRange(new Date(2026, 6, 20, 8, 0))
    const tomorrow = todayRange(new Date(2026, 6, 21, 8, 0))

    expect(today.lt.getTime()).toBe(tomorrow.gte.getTime())
  })

  it("不传参数时用「现在」，区间包住当前这一秒", () => {
    const before = Date.now()
    const { gte, lt } = todayRange()
    const after = Date.now()

    expect(before).toBeGreaterThanOrEqual(gte.getTime())
    expect(after).toBeLessThan(lt.getTime())
  })
})
