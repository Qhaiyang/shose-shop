import { Ruler } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  formatFootLength,
  type SizeGuideView,
} from "@/lib/size-guide"
import { getAllSizeGuides } from "@/lib/size-guide-db"

// 权限校验在 src/app/admin/layout.tsx 里，这一页不用重复写
export const dynamic = "force-dynamic"

export const metadata = { title: "尺码表 | 管理后台" }

// ============================================================================
// 尺码表（只读展示）
//
// 目前只能看，不能增删改 —— 数据来自种子（prisma/seed.ts）。
// 先让管理员「看得见这张表长什么样」，确认字段和区间口径对了，
// 再做编辑功能，避免「做了编辑又要回头改表结构」。
// ============================================================================

export default async function SizeGuideAdminPage() {
  const guides = await getAllSizeGuides()

  // 按分类分组展示，比一张 18 行的大表更易读 —— 分类是这道表天然的
  // 阅读单元，管理员关心的也是「跑步鞋这一档」而不是混在一起的全部
  const groups = new Map<string, SizeGuideView[]>()
  for (const guide of guides) {
    const list = groups.get(guide.category) ?? []
    list.push(guide)
    groups.set(guide.category, list)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">尺码表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          脚长 → 建议尺码 的对照，详情页「尺码助手」按分类查这张表。目前只读展示，
          数据来自种子数据。
        </p>
      </div>

      {guides.length === 0 ? (
        <div className="rounded-xl border border-dashed py-24 text-center text-sm text-muted-foreground">
          还没有尺码数据，先跑一次 <code>npm run db:seed</code>。
        </div>
      ) : (
        Array.from(groups.entries()).map(([category, rows]) => (
          <section key={category} className="rounded-xl border p-5">
            <div className="mb-3 flex items-center gap-2">
              <Ruler className="size-4 text-muted-foreground" />
              <h2 className="font-semibold">{category}</h2>
              <span className="text-xs text-muted-foreground">
                {rows.length} 个尺码
              </span>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>建议尺码</TableHead>
                  <TableHead>脚长范围（cm）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-semibold tabular-nums">
                      {row.suggestedSize}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatFootLength(row.footLengthMin)} –{" "}
                      {formatFootLength(row.footLengthMax)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <p className="mt-2 text-xs text-muted-foreground">
              脚长落在 [下界, 上界) 时建议该尺码，等于上界的脚长算进下一码。
            </p>
          </section>
        ))
      )}
    </div>
  )
}
