"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, Loader2, Package } from "lucide-react"
import { toast } from "sonner"

import {
  bulkAdjustProductStockAction,
  bulkSetProductActiveAction,
  bulkUpdateProductPriceAction,
  type AdminBulkResult,
} from "@/app/actions/admin"
import {
  DeleteProductButton,
  ProductActiveToggle,
} from "@/components/admin/product-actions"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatPriceRange } from "@/lib/format"
import type { AdminProductRow } from "@/lib/products"
import { cn } from "@/lib/utils"

// ============================================================================
// 商品列表 + 批量操作
//
// 【为什么整张表都是客户端组件】
// 勾选状态要在「表头全选框」「每一行的复选框」「工具条上的按钮」之间共享。
// 这三块分处表格的不同位置，只把复选框做成客户端组件的话，
// 它们之间的状态就得靠 Context 或者全局 store 传 —— 多一层机制，
// 多一处可能不同步的地方（比如刷新后 store 里还留着已删商品的 id）。
//
// 让一个组件同时拥有「状态」和「所有读这个状态的 UI」，是最不容易出错的形状。
// 代价是这张表会进客户端 bundle，后台页面可以接受。
//
// 【为什么用原生 checkbox，不引 UI 库的 Checkbox】
// 原生 input[type=checkbox] 加 accent-color 就能跟着主题走，
// 而行内的批量选择框不需要遮罩、动画、受控焦点那一整套。
// 工程上少一个依赖就少一处要维护的东西 ——
// 和这个文件里用原生 <img> 而不引 next/image 是同一个判断。
// ============================================================================

export function ProductBatchTable({ products }: { products: AdminProductRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [priceOpen, setPriceOpen] = useState(false)
  const [stockOpen, setStockOpen] = useState(false)

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  // 【为什么不直接信 selectedIds.length】
  // 批量操作成功后 router.refresh() 会重新拉一遍列表，
  // 但 selectedIds 是客户端状态，不会跟着变。万一某个被勾的商品
  // 在别处被删了，它就会留在这里，让「已选 3 款」和表里的勾选状态对不上。
  // 所以每次都用当前列表过滤一遍 —— 表里看到的，就是真正会被操作的
  const selectedProducts = products.filter((p) => selectedSet.has(p.id))
  const selectedSkuCount = selectedProducts.reduce(
    (sum, product) => sum + product.skuCount,
    0,
  )

  const allSelected = products.length > 0 && selectedIds.length === products.length
  const someSelected = selectedIds.length > 0 && !allSelected

  // 【为什么「全选」要用 indeterminate 这个原生属性】
  // 勾了一部分时，表头的框既不是「全选」也不是「没选」。
  // 画成未勾选会让人以为一个都没选中；画成勾选又会误以为已全选。
  // 浏览器为这个中间态提供了 indeterminate（一条横线），
  // 但它只能通过 DOM 属性设置，没有对应的 HTML attribute，所以得用 ref
  const headerCheckbox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someSelected
  }, [someSelected])

  function toggleOne(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : products.map((product) => product.id))
  }

  /**
   * 跑一次批量操作的统一入口。
   *
   * 【为什么成功之后要清空勾选】
   * 操作完再点一次「下架」，大概率不是管理员想要的 ——
   * 他要的是「处理完这批，然后去处理下一批」。
   * 留着勾选状态，第二次点击就是一次误操作。
   */
  function runBatch(call: () => Promise<AdminBulkResult>, onSuccess?: () => void) {
    startTransition(async () => {
      const result = await call()

      if (!result.ok) {
        toast.error("批量操作失败", { description: result.error })
        return
      }

      toast.success(result.message)
      setSelectedIds([])
      onSuccess?.()
      // 服务端已经 revalidatePath 过了，这里再 refresh 一次是为了
      // 让当前这一屏立刻拿到新数据（价格区间、总库存这些列都会变）
      router.refresh()
    })
  }

  const noneSelected = selectedIds.length === 0

  return (
    <div className="space-y-3">
      {/* ---------------- 批量操作工具条 ---------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3">
        <div className="text-sm">
          {noneSelected ? (
            <span className="text-muted-foreground">
              勾选左侧的复选框，可以对多款商品做同一件事
            </span>
          ) : (
            <span>
              已选{" "}
              <span className="font-semibold tabular-nums">{selectedIds.length}</span>{" "}
              款商品
              <span className="ml-1 text-muted-foreground">
                （共 {selectedSkuCount} 个规格）
              </span>
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                className="ml-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                清空
              </button>
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={noneSelected || pending}
            onClick={() =>
              runBatch(() => bulkSetProductActiveAction(selectedIds, true))
            }
          >
            批量上架
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={noneSelected || pending}
            onClick={() =>
              runBatch(() => bulkSetProductActiveAction(selectedIds, false))
            }
          >
            批量下架
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={noneSelected || pending}
            onClick={() => setPriceOpen(true)}
          >
            批量改价
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={noneSelected || pending}
            onClick={() => setStockOpen(true)}
          >
            批量调库存
          </Button>

          {pending ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              处理中
            </span>
          ) : null}
        </div>
      </div>

      {/* ---------------- 表格 ---------------- */}
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  ref={headerCheckbox}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="全选"
                  className="size-4 cursor-pointer accent-primary align-middle"
                />
              </TableHead>
              <TableHead>商品</TableHead>
              <TableHead>分类</TableHead>
              <TableHead className="text-right">价格区间</TableHead>
              <TableHead className="text-right">规格</TableHead>
              <TableHead className="text-right">总库存</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {products.map((product) => {
              const checked = selectedSet.has(product.id)

              return (
                <TableRow
                  key={product.id}
                  // 选中行给一点底色：勾了十几行之后，
                  // 单看复选框很难一眼扫出选中了哪几行
                  className={cn(checked && "bg-muted/50")}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(product.id)}
                      aria-label={`选择 ${product.name}`}
                      className="size-4 cursor-pointer accent-primary align-middle"
                    />
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Thumbnail src={product.image} alt={product.name} />
                      <div>
                        <Link
                          href={`/admin/products/${product.id}`}
                          className="text-sm font-medium hover:underline"
                        >
                          {product.name}
                        </Link>
                        <div className="font-mono text-xs text-muted-foreground">
                          {product.id}
                        </div>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className="text-sm text-muted-foreground">
                    {product.category}
                  </TableCell>

                  <TableCell className="text-right tabular-nums">
                    {formatPriceRange(product.minPrice, product.maxPrice)}
                  </TableCell>

                  <TableCell className="text-right tabular-nums">
                    {product.skuCount === 0 ? (
                      <span className="text-destructive">0</span>
                    ) : (
                      product.skuCount
                    )}
                  </TableCell>

                  <TableCell className="text-right tabular-nums">
                    <div className="flex items-center justify-end gap-1.5">
                      {product.lowStockSkuCount > 0 ? (
                        <AlertTriangle
                          className="size-3.5 text-amber-600"
                          aria-label="有规格库存不足"
                        />
                      ) : null}
                      <span
                        className={cn(
                          product.lowStockSkuCount > 0 && "text-amber-700",
                        )}
                      >
                        {product.totalStock}
                      </span>
                    </div>
                    {product.lowStockSkuCount > 0 ? (
                      <div className="text-xs text-amber-700">
                        {product.lowStockSkuCount} 个规格告急
                      </div>
                    ) : null}
                  </TableCell>

                  <TableCell>
                    {product.isActive ? (
                      <Badge variant="secondary">在售</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        已下架
                      </Badge>
                    )}
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/admin/products/${product.id}`}
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                      >
                        编辑
                      </Link>

                      <ProductActiveToggle
                        productId={product.id}
                        isActive={product.isActive}
                      />

                      <DeleteProductButton
                        productId={product.id}
                        productName={product.name}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* ---------------- 批量改价 ---------------- */}
      <PriceDialog
        open={priceOpen}
        onOpenChange={setPriceOpen}
        selectedCount={selectedIds.length}
        skuCount={selectedSkuCount}
        pending={pending}
        onSubmit={(mode, value) =>
          runBatch(
            () => bulkUpdateProductPriceAction(selectedIds, mode, value),
            () => setPriceOpen(false),
          )
        }
      />

      {/* ---------------- 批量调库存 ---------------- */}
      <StockDialog
        open={stockOpen}
        onOpenChange={setStockOpen}
        selectedCount={selectedIds.length}
        skuCount={selectedSkuCount}
        pending={pending}
        onSubmit={(delta) =>
          runBatch(
            () => bulkAdjustProductStockAction(selectedIds, delta),
            () => setStockOpen(false),
          )
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 批量改价对话框
// ---------------------------------------------------------------------------

function PriceDialog({
  open,
  onOpenChange,
  selectedCount,
  skuCount,
  pending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedCount: number
  skuCount: number
  pending: boolean
  /** 第二个参数是**字符串**，由服务端解析 —— 见下面那段注释 */
  onSubmit: (mode: "percent" | "set", value: string) => void
}) {
  const [mode, setMode] = useState<"percent" | "set">("percent")
  const [direction, setDirection] = useState<"up" | "down">("up")
  const [percent, setPercent] = useState("10")
  const [yuan, setYuan] = useState("")

  // 【为什么价格输入框的 state 是 string 而不是 number】
  // 因为用户填的就是字符串。一旦在这里 Number() 一下，
  // 「899.005」会被悄悄变成 899.005 然后传给服务端，
  // 而服务端按「最多两位小数」的规则判它非法 —— 用户会觉得莫名其妙，
  // 他看到的输入框里明明还是自己打的那些字。
  //
  // 保持原样传到服务端、由 parseYuanToCents 按小数点拆成整数分，
  // 是唯一不会在中间某处偷偷改变用户输入的做法。
  // 项目里所有涉及金额的输入都遵守这一条。
  const percentNumber = Number(percent)
  const percentValid =
    /^\d{1,3}$/.test(percent) && percentNumber >= 1 && percentNumber <= 500
  const yuanValid = yuan.trim().length > 0
  const canSubmit =
    !pending && selectedCount > 0 && (mode === "percent" ? percentValid : yuanValid)

  function submit() {
    if (!canSubmit) return
    onSubmit(
      mode,
      mode === "percent"
        ? `${direction === "down" ? "-" : ""}${percent}`
        : yuan.trim(),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>批量改价</DialogTitle>
          <DialogDescription>
            将影响 {selectedCount} 款商品下的全部 {skuCount} 个规格。
            规格之间价格不同的话，百分比模式会各自按比例调整。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "percent", label: "按百分比调整" },
              { value: "set", label: "统一设为固定价" },
            ]}
          />

          {mode === "percent" ? (
            <div className="space-y-2">
              <Segmented
                value={direction}
                onChange={setDirection}
                options={[
                  { value: "up", label: "上调" },
                  { value: "down", label: "下调" },
                ]}
              />

              <div className="flex items-center gap-2">
                <Input
                  value={percent}
                  onChange={(event) => setPercent(event.target.value)}
                  inputMode="numeric"
                  className="w-24"
                  aria-label="百分比"
                />
                <span className="text-sm text-muted-foreground">
                  %（1 ~ 500，最多下调 90%）
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                value={yuan}
                onChange={(event) => setYuan(event.target.value)}
                placeholder="899.00"
                inputMode="decimal"
                className="w-32"
                aria-label="单价（元）"
              />
              <span className="text-sm text-muted-foreground">
                元，所有规格统一成这个价
              </span>
            </div>
          )}

          <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            只要有<strong className="font-medium">一个</strong>
            规格改完的价格低于 0.01 元或超过上限，整批都不会生效 ——
            不会出现「改了一半」的状态。
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            确认改价
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 批量调库存对话框
// ---------------------------------------------------------------------------

function StockDialog({
  open,
  onOpenChange,
  selectedCount,
  skuCount,
  pending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedCount: number
  skuCount: number
  pending: boolean
  /** delta > 0 入库，< 0 出库 */
  onSubmit: (delta: number) => void
}) {
  const [direction, setDirection] = useState<"in" | "out">("in")
  const [count, setCount] = useState("")

  const countNumber = Number(count)
  const countValid =
    /^\d{1,6}$/.test(count) && countNumber > 0 && countNumber <= 999_999
  const canSubmit = !pending && selectedCount > 0 && countValid

  function submit() {
    if (!canSubmit) return
    onSubmit(direction === "in" ? countNumber : -countNumber)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>批量调库存</DialogTitle>
          <DialogDescription>
            将对 {selectedCount} 款商品下的
            <strong className="font-medium">每一个</strong>规格（共 {skuCount} 个）
            各自{direction === "in" ? "增加" : "减少"}同样的数量。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Segmented
            value={direction}
            onChange={setDirection}
            options={[
              { value: "in", label: "入库（增加）" },
              { value: "out", label: "出库（减少）" },
            ]}
          />

          <div className="flex items-center gap-2">
            <Input
              value={count}
              onChange={(event) => setCount(event.target.value)}
              placeholder="10"
              inputMode="numeric"
              className="w-24"
              aria-label="件数"
            />
            <span className="text-sm text-muted-foreground">件</span>
          </div>

          <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {direction === "out" ? (
              <>
                只要有<strong className="font-medium">一个</strong>
                规格的库存不够扣，整批就都不会生效 —— 不会出现「扣了一半」的状态。
                库存只能增减、不能直接设成某个数，因为「设为 N」
                会把这期间买家买走的货悄悄补回来。
              </>
            ) : (
              <>
                入库是安全的：无论当前库存是多少，「加 N 件」这句话都成立。
                所以入库不会因为库存数字而失败。
              </>
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            确认调整
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

/** 二选一的分段按钮。比 <Select> 少一次点击，也不用为两个选项开下拉 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex rounded-lg border p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-3 py-1 text-sm transition-colors",
            value === option.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 列表缩略图。图片路径是管理员手填的，可能填错，所以要有兜底 */
function Thumbnail({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
        <Package className="size-4" />
      </div>
    )
  }

  return (
    // 用原生 <img> 而不是 next/image：
    // 图片路径由管理员手填，随时可能是站外地址，
    // next/image 需要为每个域名配 remotePatterns，配漏了就直接报错。
    // 后台列表的缩略图不值得为此引入这层配置
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className="size-10 shrink-0 rounded-lg border object-cover"
    />
  )
}
