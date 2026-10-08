// ============================================================================
// 本地定时触发脚本（开发用）
//
// Windows 上没有 crontab，这个脚本用 setInterval 每隔一段时间 POST 一次
// 定时任务接口，效果等价于生产环境的 crontab。
//
// 【为什么这里是 setInterval，前面却说 setInterval 不好】
// 因为它跑在**独立进程**里。前面反对的是把 setInterval 塞进 Next.js 的
// 渲染进程（会被 serverless 冻结、会被热重载叠加），那是两回事。
//
// 用法：
//   1. 在 .env 里加上：CRON_ENABLED="true"
//   2. 另开一个终端：node scripts/cron-dev.mjs
//   3. 想停就 Ctrl+C
// ============================================================================

import { readFileSync } from "node:fs"

const BASE = process.env.BASE_URL ?? "http://localhost:3000"
const INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS ?? 60_000)

// 从 .env 里读密钥。这里手动解析而不装 dotenv —— 项目里只需要读两个值，
// 多一个依赖不划算
function readEnv(key) {
  if (process.env[key]) return process.env[key]

  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8")
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)"?`, "m"))
    return match?.[1]
  } catch {
    return undefined
  }
}

const secret = readEnv("CRON_SECRET")
const enabled = readEnv("CRON_ENABLED") === "true"

if (!secret) {
  console.error("❌ .env 里没有 CRON_SECRET，先补上再跑这个脚本")
  process.exit(1)
}

if (!enabled) {
  console.error(
    "❌ .env 里 CRON_ENABLED 不是 \"true\"。\n" +
      "   这个开关是为了防止你无意中一直挂着定时任务 —— 它会在后台改数据。\n" +
      "   确认要用就把它设成 true 再跑。",
  )
  process.exit(1)
}

async function tick() {
  const at = new Date().toLocaleTimeString("zh-CN")
  try {
    const res = await fetch(`${BASE}/api/cron/expire-orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    })
    const body = await res.json()

    if (!res.ok || !body.ok) {
      console.error(`[${at}] ❌ ${res.status}`, body)
      return
    }

    // 平时什么都不打印，只在真的取消了订单时才出声 ——
    // 每分钟刷一行「无事发生」会把有用的信息淹掉
    if (body.cancelled > 0) {
      console.log(
        `[${at}] ✅ 取消 ${body.cancelled} 笔超时订单，归还 ${body.restoredUnits} 件库存`,
      )
    }
  } catch (error) {
    console.error(`[${at}] ❌ 请求失败：`, error.message)
  }
}

console.log(`⏱  每 ${INTERVAL_MS / 1000} 秒调用一次 ${BASE}/api/cron/expire-orders`)
console.log("   （只在有订单被取消时才输出，Ctrl+C 停止）\n")

await tick()
setInterval(tick, INTERVAL_MS)
