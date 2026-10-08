// ============================================================================
// 一次跑完三层测试，最后给一张汇总表
//
// 用法：npm run test
//
// 【为什么要自己写这个脚本，而不是 `a && b && c`】
// `a && b && c` 有两个毛病：
//   1. 第一层挂了后面就不跑了 —— 但你往往想知道「到底哪几层坏了」
//   2. 跑完只看到三段刷屏的输出，没有「一共过了多少个用例」这种结论
//
// 所以这里按顺序跑完三层（不管中间失败与否），把完整输出打出来，
// 最后补一张汇总表。任何一层失败，脚本整体退出码就是 1，
// 这样 CI 里 `npm run test` 依然能正确地判定成败。
//
// 【为什么用 npm_execpath 而不是直接写 vitest / playwright 的路径】
// 是为了让 package.json 里的 test:unit / test:integration / test:e2e
// 保持唯一事实来源 —— 命令改了就改一处，这里不用跟着动。
// npm 在跑 scripts 时会把 npm CLI 的路径塞进 npm_execpath。
// ============================================================================

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))

/**
 * 从 runner 的输出里数出「过了几个、挂了几个」。
 *
 * 【为什么用正则解析而不是 JSON reporter】
 * 两个 runner 都能吐 JSON，但要各接一套 reporter 参数、再写两套解析代码 ——
 * 为了一个摘要不值当。这里抓的是它们默认输出里最稳的那两行：
 *     vitest      →  " Tests  113 passed (113)"
 *     playwright  →  "  1 passed (22.4s)"
 *
 * 【解析失败怎么办】
 * 返回空串，摘要那一列显示「见上方输出」。完整的输出本来就照打在上面了，
 * 摘要只是索引 —— 所以正则跟不上版本变化时，丢的只是便利，不是信息。
 */
function countDetail(output) {
  // 先把「汇总行」挑出来，再在汇总行里数数。
  // 不直接全文搜 `(\d+) passed` 是因为那样会误伤每个测试文件的明细行
  const summaryLines = output.split("\n").filter((line) => {
    // vitest：      "      Tests  113 passed (113)"
    //                "      Tests  2 failed | 77 passed (79)"
    if (/^\s*Tests\s+/.test(line)) return true
    // playwright：   "  1 passed (22.4s)" / "  1 failed"
    return /^\s*(?:Tests\s+)?\d+ (?:passed|failed)/.test(line)
  })

  const summary = summaryLines.join(" ")
  const passed = summary.match(/(\d+) passed/)
  const failed = summary.match(/(\d+) failed/)

  const parts = []
  if (passed) parts.push(`${passed[1]} 个通过`)
  if (failed) parts.push(`${failed[1]} 个失败`)

  return parts.join("，")
}

const LAYERS = [
  { order: "第一层", label: "单元测试", script: "test:unit" },
  { order: "第二层", label: "集成测试", script: "test:integration" },
  { order: "第三层", label: "E2E 端到端", script: "test:e2e" },
]

/** 跑一层，返回结果。失败也返回结果，不抛异常 */
function runLayer({ script }) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) {
    throw new Error(
      "找不到 npm_execpath。请用 `npm run test` 调用，不要直接 node 这个文件",
    )
  }

  const startedAt = Date.now()

  try {
    const stdout = execFileSync(process.execPath, [npmCli, "run", script], {
      cwd: ROOT,
      encoding: "utf8",
      // 不要 inherit：先把输出收起来，跑完统一排版
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, output: stdout, ms: Date.now() - startedAt }
  } catch (error) {
    // execFileSync 失败时，子进程的输出挂在 error 上
    const stdout = error.stdout ?? ""
    const stderr = error.stderr ?? ""
    return {
      ok: false,
      output: `${stdout}${stderr}`,
      ms: Date.now() - startedAt,
    }
  }
}

/** 毫秒 → "12.3s" / "680ms" */
function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * 按「显示宽度」补空格。
 *
 * String.prototype.padEnd 数的是**字符个数**，而终端里一个汉字占两列 ——
 * "单元测试".padEnd(8) 只会补 4 个空格，结果整张表歪掉。
 * 所以这里自己数：全角字符和 emoji 记 2 列，其余记 1 列。
 */
const WIDE_CHAR =
  /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|[☀-➿]|[\u{1f300}-\u{1faff}]/u

function pad(text, width) {
  let displayWidth = 0
  for (const char of text) {
    displayWidth += WIDE_CHAR.test(char) ? 2 : 1
  }
  return text + " ".repeat(Math.max(0, width - displayWidth))
}

const results = []

for (const layer of LAYERS) {
  console.log(`\n${"━".repeat(72)}`)
  console.log(`  ${layer.order} · ${layer.label}   （npm run ${layer.script}）`)
  console.log(`${"━".repeat(72)}\n`)

  const result = runLayer(layer)
  // 完整输出照打 —— 摘要只是索引，出问题时真正要看的是这里
  process.stdout.write(result.output)
  if (!result.output.endsWith("\n")) console.log()

  results.push({ ...layer, ...result })
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n${"═".repeat(72)}`)
console.log("  测试汇总")
console.log(`${"═".repeat(72)}`)
console.log(
  `  ${pad("层级", 20)}${pad("结果", 10)}${pad("耗时", 10)}用例`,
)
console.log(`  ${"─".repeat(68)}`)

let failed = 0
let totalMs = 0

for (const r of results) {
  if (!r.ok) failed++
  totalMs += r.ms

  const status = r.ok ? "✅ 通过" : "❌ 失败"
  const detail = r.ok ? countDetail(r.output) || "—" : "见上方输出"

  console.log(
    `  ${pad(`${r.order} ${r.label}`, 20)}${pad(status, 10)}${pad(formatMs(r.ms), 10)}${detail}`,
  )
}

console.log(`  ${"─".repeat(68)}`)
console.log(
  `  ${results.length - failed}/${results.length} 层通过    总耗时 ${formatMs(totalMs)}\n`,
)

if (failed > 0) {
  console.error(`  ⚠️  有 ${failed} 层没通过，退出码 1\n`)
  process.exit(1)
}
