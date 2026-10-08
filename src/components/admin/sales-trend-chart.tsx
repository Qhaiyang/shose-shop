import { formatPriceShort } from "@/lib/format"
import type { SalesTrendPoint } from "@/lib/sales-trend"

// ============================================================================
// 近 7 天销售额趋势 —— 折线图
//
// 【为什么用原生 SVG，而不是引一个图表库】
// 折线图在这里就是「7 个点连成一条线」。为了它拉进 recharts / echarts
// 这种大依赖，等于为了一行 polyline 扛一整套图表引擎，跟这个项目
// 「刻意不用框架」的出发点相悖。SVG 几十行就能画清楚，还零依赖。
//
// 【为什么不是 Client Component】
// 这图没有任何交互（不 hover、不缩放），只是把服务端算好的 7 个数
// 画出来。没有 useState 就留在 Server Component 里渲染，少一次 JS 下载。
// 哪天要加 hover 提示、点某个点看当天明细，再改成 client 不迟。
// ============================================================================

function dayLabel(date: Date, isToday: boolean): string {
  if (isToday) return "今天"
  // 其余天显示 "月/日"，紧凑、不占地方
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function SalesTrendChart({ data }: { data: SalesTrendPoint[] }) {
  // 数据还没回来或为空时什么都不画（理论上 buildSalesTrend 永远返回 7 个点）
  if (data.length === 0) return null

  // 画布尺寸。viewBox 固定比例，实际宽高交给外层 CSS 撑满
  const W = 640
  const H = 240
  const PAD_LEFT = 48 // 左边留给 Y 轴金额刻度
  const PAD_TOP = 16
  const PAD_BOTTOM = 32 // 底部留给日期标签
  const PAD_RIGHT = 12

  const innerW = W - PAD_LEFT - PAD_RIGHT
  const innerH = H - PAD_TOP - PAD_BOTTOM

  // 纵轴最大刻度。兜底 1 分，避免 7 天全是 0 时除以 0
  const max = Math.max(...data.map((d) => d.revenue), 1)

  // 横轴按点等距铺开；纵轴是「值越大越靠上」
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0
  const x = (i: number) => PAD_LEFT + i * stepX
  const y = (v: number) => PAD_TOP + innerH - (v / max) * innerH

  const line = data.map((d, i) => `${x(i)},${y(d.revenue)}`).join(" ")
  // 面积填充：从折线两头下垂到坐标轴底部，围成一个多边形
  const area = [
    `${PAD_LEFT},${PAD_TOP + innerH}`,
    line,
    `${x(data.length - 1)},${PAD_TOP + innerH}`,
  ].join(" ")

  // Y 轴三档刻度：0、半、满
  const ticks = [0, 0.5, 1]

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="近 7 天销售额趋势"
    >
      {/* ---- 横向网格线 + 金额刻度 ---- */}
      {ticks.map((t) => {
        const value = t * max
        const yy = y(value)
        return (
          <g key={t}>
            <line
              x1={PAD_LEFT}
              y1={yy}
              x2={W - PAD_RIGHT}
              y2={yy}
              strokeDasharray="4 4"
              className="stroke-border"
            />
            <text
              x={PAD_LEFT - 8}
              y={yy + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {formatPriceShort(value)}
            </text>
          </g>
        )
      })}

      {/* ---- 面积 + 折线 + 数据点 ---- */}
      <polygon points={area} className="fill-primary/10" />
      <polyline
        points={line}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        className="stroke-primary"
      />
      {data.map((d, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(d.revenue)}
          r={3}
          className="fill-primary"
        />
      ))}

      {/* ---- 日期标签 ---- */}
      {data.map((d, i) => (
        <text
          key={i}
          x={x(i)}
          y={H - 10}
          textAnchor="middle"
          className="fill-muted-foreground text-[10px]"
        >
          {dayLabel(d.date, i === data.length - 1)}
        </text>
      ))}
    </svg>
  )
}
