// ============================================================================
// E2E 的启动包装：补上 PATH，然后调 playwright
//
// 用法：npm run test:e2e（不要直接调 playwright）
//
// 【为什么需要这一层】
// 跑测试的流程里，Playwright 会在结束时杀掉它自己起的 next dev。
// 在 Windows 上它是靠 `taskkill /pid X /T /F` 干的 —— 而且失败时**不报错**，
// 只是默默什么也没发生。
//
// 问题出在 Git Bash：它的 PATH 里默认没有 C:\Windows\System32，
// 于是 taskkill 根本找不到。后果不是「报个错」，而是：
//   - 测试结果已经打印出来了（"1 passed"）
//   - 但 Playwright 还在等那个没被杀掉的 dev server 退出，进程一直不结束
//   - 端口 3100 被一个孤儿进程占着，下一次跑又失败
// 看起来就像「测试卡死了」，实际原因藏得极深。
//
// 这里在调 Playwright 之前，把 System32 补到 PATH **末尾**。
// 注意是末尾不是开头 —— 放开头的话，System32 里的 bash.exe（WSL 启动器）
// 会盖掉 Git Bash 自己的 bash，那是另一个坑。
//
// Windows 上 System32 本来就在标准 PATH 里，所以这只影响像 Git Bash
// 这类「PATH 被裁过」的终端；对 PowerShell / cmd 完全是无操作。
// ============================================================================

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))

function pathWithSystem32() {
  if (process.platform !== "win32") return process.env.PATH ?? ""

  const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  const current = process.env.PATH ?? ""
  const parts = current.split(path.delimiter)

  // 已经有了就别重复加（PowerShell 里就是这种情况）
  if (parts.some((p) => p.toLowerCase() === system32.toLowerCase())) return current

  return current + path.delimiter + system32
}

const child = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules", "@playwright", "test", "cli.js"), "test"],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PATH: pathWithSystem32() },
  },
)

// 原样转发退出码，让 `npm run test:e2e` 的成败和 Playwright 一致
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1))
})
