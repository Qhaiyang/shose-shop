"use client"

import { useActionState, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import {
  adjustSkuStockAction,
  createSkuAction,
  deleteSkuAction,
  updateSkuPriceAction,
  type SkuFormState,
  type SkuFormValues,
} from "@/app/actions/admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { AdminSkuRow } from "@/lib/products"
import { formatPrice } from "@/lib/format"

// ============================================================================
// SKU 管理面板（客户端）
//
// 【为什么这一整块是客户端组件，而不是页面直接渲染】
// 因为每个 SKU 那一行都要有自己的输入框和按钮状态：
// 「这一行正在保存价格」不能把整个表格都变成 loading。
// 服务端组件没法持有这种「按行」的状态，所以把交互部分收拢到这里，
// 页面本身仍然是服务端组件（数据在服务端查好再传进来）。
//
// 【传进来的 skus 必须是可序列化的】
// 服务端 → 客户端的 props 要过 RSC 的序列化，Date、函数、类实例都不行。
// AdminSkuRow 里全是 string / number，所以可以直接传。
// ============================================================================

export function SkuPanel({
  productId,
  skus,
  referencedByOrders,
}: {
  productId: string
  skus: AdminSkuRow[]
  /** 有多少条订单项引用了这些 SKU，用来解释「为什么删不掉」 */
  referencedByOrders: number
}) {
  return (
    <div className="space-y-5">
      {/* ---------------- 现有规格 ---------------- */}
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>货号</TableHead>
              <TableHead>颜色</TableHead>
              <TableHead>尺码</TableHead>
              <TableHead className="w-[190px]">价格</TableHead>
              <TableHead className="w-[210px]">库存</TableHead>
              <TableHead className="w-[70px] text-right">删除</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {skus.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  还没有规格。没有规格的商品在前台显示为「售罄」，用下面的表单加一个。
                </TableCell>
              </TableRow>
            ) : (
              skus.map((sku) => <SkuRow key={sku.id} sku={sku} />)
            )}
          </TableBody>
        </Table>
      </div>

      {referencedByOrders > 0 ? (
        <p className="text-xs text-muted-foreground">
          这些规格已经被 {referencedByOrders} 条订单项引用，
          所以不能删除 —— 删了订单里就追溯不到买的是哪一双了。
          不想卖的话，回到商品信息里点「下架」。
        </p>
      ) : null}

      {/* ---------------- 新增规格 ---------------- */}
      <CreateSkuForm productId={productId} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 一行 SKU
// ---------------------------------------------------------------------------

function SkuRow({ sku }: { sku: AdminSkuRow }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // 价格：用字符串存，因为「用户正在输入的中间状态」（比如 "89."）
  // 不是一个合法的数字，用 number 存会把光标和内容搞乱
  const [priceInput, setPriceInput] = useState((sku.price / 100).toFixed(2))
  // 库存调整量，默认 1 件
  const [delta, setDelta] = useState("1")

  // 服务端返回的价格和本地不一致（比如别人刚改过），说明本地这份过期了。
  // 渲染期间比对并重置 —— React 官方推荐的「根据 props 调整 state」写法，
  // 比 useEffect 少一次多余的渲染，也不会闪一下旧值
  const [lastPrice, setLastPrice] = useState(sku.price)
  if (lastPrice !== sku.price) {
    setLastPrice(sku.price)
    setPriceInput((sku.price / 100).toFixed(2))
  }

  function savePrice() {
    startTransition(async () => {
      const result = await updateSkuPriceAction(sku.id, priceInput)

      if (!result.ok) {
        toast.error("改价失败", { description: result.error })
        // 失败多半是因为这个 SKU 已经不在了，或者输入格式不对。
        // 刷新让页面回到服务端的真实状态
        router.refresh()
        return
      }

      toast.success("价格已更新", { description: formatPrice(result.price ?? 0) })
      router.refresh()
    })
  }

  function adjustStock(sign: 1 | -1) {
    const magnitude = Number(delta)
    if (!Number.isInteger(magnitude) || magnitude <= 0) {
      toast.error("调整数量要是正整数")
      return
    }

    startTransition(async () => {
      // 入库传正数、出库传负数。底层用条件更新保证不会扣成负数
      const result = await adjustSkuStockAction(sku.id, sign * magnitude)

      if (!result.ok) {
        toast.error(sign > 0 ? "入库失败" : "出库失败", {
          description: result.error,
        })
        router.refresh()
        return
      }

      toast.success(sign > 0 ? "已入库" : "已出库", {
        description: `现在库存 ${result.stock} 件`,
      })
      router.refresh()
    })
  }

  function remove() {
    // 删除是不可逆的，而且会连带影响前台的购买入口，所以问一句。
    // confirm() 很丑，但对后台这种低频、高危的操作够用 ——
    // 换成自绘弹窗要额外处理焦点锁定和 Esc，收益不大
    if (!window.confirm(`确定删除「${sku.color} / ${sku.size}码」这个规格吗？`)) {
      return
    }

    startTransition(async () => {
      const result = await deleteSkuAction(sku.id)

      if (!result.ok) {
        toast.error("删除失败", { description: result.error })
        return
      }

      toast.success("规格已删除")
      router.refresh()
    })
  }

  const priceChanged = priceInput !== (sku.price / 100).toFixed(2)

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{sku.skuCode}</TableCell>
      <TableCell className="text-sm">{sku.color}</TableCell>
      <TableCell className="text-sm tabular-nums">{sku.size}</TableCell>

      {/* ---------------- 价格 ---------------- */}
      <TableCell>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground">
              ¥
            </span>
            <Input
              value={priceInput}
              onChange={(event) => setPriceInput(event.target.value)}
              // 回车直接保存，省得每次都去点那个小对勾
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  if (priceChanged) savePrice()
                }
              }}
              inputMode="decimal"
              disabled={pending}
              className="pl-5 text-right tabular-nums"
              aria-label={`${sku.color} ${sku.size} 码的价格（元）`}
            />
          </div>

          <Button
            size="icon-sm"
            variant="outline"
            onClick={savePrice}
            // 没改动就不给点，避免无意义的写库和一条无意义的日志
            disabled={pending || !priceChanged}
            title="保存价格"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
          </Button>
        </div>
      </TableCell>

      {/* ---------------- 库存 ---------------- */}
      <TableCell>
        <div className="flex items-center gap-1.5">
          {/* 当前库存是只读展示，不提供「直接改成 N」的输入框 ——
              理由见 actions/admin.ts 里 adjustSkuStockAction 的长注释：
              绝对赋值会和买家的下单扣减抢，静默地把卖出去的货补回来 */}
          <span
            className={
              sku.stock === 0
                ? "w-12 shrink-0 text-right font-medium tabular-nums text-destructive"
                : "w-12 shrink-0 text-right font-medium tabular-nums"
            }
          >
            {sku.stock}
          </span>

          <Input
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            inputMode="numeric"
            disabled={pending}
            className="w-14 text-right tabular-nums"
            aria-label={`${sku.color} ${sku.size} 码的调整数量`}
          />

          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => adjustStock(1)}
            disabled={pending}
            title="入库（增加库存）"
          >
            <ArrowDownToLine className="size-3.5" />
          </Button>

          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => adjustStock(-1)}
            disabled={pending}
            title="出库（减少库存）"
          >
            <ArrowUpFromLine className="size-3.5" />
          </Button>
        </div>
      </TableCell>

      {/* ---------------- 删除 ---------------- */}
      <TableCell className="text-right">
        <Button
          size="icon-sm"
          variant="destructive"
          onClick={remove}
          disabled={pending}
          title="删除这个规格"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

// ---------------------------------------------------------------------------
// 新增规格
// ---------------------------------------------------------------------------

const EMPTY_SKU_VALUES: SkuFormValues = {
  color: "",
  size: "",
  price: "",
  stock: "",
}

function CreateSkuForm({ productId }: { productId: string }) {
  const [state, formAction, pending] = useActionState<SkuFormState, FormData>(
    createSkuAction,
    undefined,
  )

  // 服务端每次回话都在说「表单现在该显示什么」：
  //   失败 → state.values 是用户刚填的，原样填回去
  //   成功 → state.values 是 undefined，清空，等着填下一个规格
  const serverValues = state?.values ?? EMPTY_SKU_VALUES

  const [values, setValues] = useState<SkuFormValues>(serverValues)

  // 收到新的服务端结果就同步。在渲染期间比较两个值再 setState，
  // 是 React 官方认可的写法，比放到 useEffect 里少渲染一帧 ——
  // 错误提示和输入框内容会在同一帧里出现，不会闪
  const [seen, setSeen] = useState(state)
  if (state !== seen) {
    setSeen(state)
    setValues(serverValues)
  }

  /** 只更新一个字段，其余不动 */
  const field = (key: keyof SkuFormValues) => ({
    value: values[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setValues((prev) => ({ ...prev, [key]: event.target.value })),
  })

  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <Plus className="size-4 text-muted-foreground" />
        <h2 className="font-medium">新增规格</h2>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        「颜色 + 尺码」的组合必须唯一，重复会被数据库的唯一索引挡下来。
        货号由系统自动生成，不用填。
      </p>

      {state?.message ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {state.message}
        </div>
      ) : null}

      {/*
        【输入框为什么是受控的】
        React 19 在 <form action={fn}> 提交结束后会自动重置整个表单。
        对非受控输入框来说，重置是恢复到 defaultValue —— 而 defaultValue
        只在初始化那一刻生效，事后改它 React 会直接警告。
        所以这里改成受控：显示什么完全由 values 这个 state 决定，
        React 怎么重置 DOM 都影响不到它。

        「表单该显示什么」于是只剩一个来源：服务端返回的 values。
        （详见 src/components/admin/product-form.tsx 顶部那段更长的说明）
      */}
      <form
        action={formAction}
        noValidate
        className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]"
      >
        <input type="hidden" name="productId" value={productId} />

        <div className="space-y-1">
          <Label className="block text-xs">颜色</Label>
          <Input
            name="color"
            {...field("color")}
            placeholder="曜石黑"
            maxLength={20}
          />
          <FieldErrors errors={state?.errors?.color} />
        </div>

        <div className="space-y-1">
          <Label className="block text-xs">尺码</Label>
          <Input
            name="size"
            {...field("size")}
            placeholder="42"
            maxLength={10}
          />
          <FieldErrors errors={state?.errors?.size} />
        </div>

        <div className="space-y-1">
          <Label className="block text-xs">价格（元）</Label>
          <Input
            name="price"
            {...field("price")}
            placeholder="899.00"
            inputMode="decimal"
          />
          <FieldErrors errors={state?.errors?.price} />
        </div>

        <div className="space-y-1">
          <Label className="block text-xs">首批库存</Label>
          <Input
            name="stock"
            {...field("stock")}
            placeholder="20"
            inputMode="numeric"
          />
          <FieldErrors errors={state?.errors?.stock} />
        </div>

        <div className="flex items-start pt-5">
          <Button type="submit" disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            添加
          </Button>
        </div>
      </form>
    </div>
  )
}


function FieldErrors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null

  return (
    <>
      {errors.map((error) => (
        <p key={error} className="text-xs text-destructive">
          {error}
        </p>
      ))}
    </>
  )
}
