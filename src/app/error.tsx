"use client"

import { useEffect } from "react"
import { AlertTriangle, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"

// ============================================================================
// 全局错误边界（App Router 的 error.js 约定文件）
//
// 【它拦得住什么】
// app/error.tsx 会在 <page> 外面套一层 React Error Boundary，
// 所以它下面任意一个服务端/客户端组件在**渲染时**抛错，都会走到这里，
// 而不是让整页变成浏览器的「This page couldn't load」。
// 覆盖范围：app/layout.tsx 以下的整个子树（含各页面）。
// 拦不住的：layout.tsx 自己抛的错 —— 那需要 app/global-error.tsx。
//
// 【为什么必须是 Client Component】
// React 的 Error Boundary 依赖 componentDidCatch / getDerivedStateFromError
// 这两个类组件生命周期，只有客户端组件能参与。所以这个文件不能是
// 服务端组件，也就不能写 async、不能直接查数据库。
//
// 【Next 16 的改名：reset → retry】
// 老版本传进来的第二个 prop 叫 reset。Next 16 改成了 retry，
// reset 虽然还在（用来「只重渲染、不重新请求」），但官方建议优先用 retry。
//   retry() → 重新请求这一段的 RSC 数据 + 重新渲染。页面因为数据库
//             抖动而报错时，这个才有机会真的恢复。
//   reset() → 只清掉错误状态重新渲染，不发新请求。同样的数据会再次
//             渲染出同样的错误，对「查库失败」这类问题基本没用。
// 所以按钮绑的是 retry()。
//
// 【error.message 有个坑】
//   - 错误来自客户端组件 → message 是原始信息，能直接看到原因
//   - 错误来自服务端组件 → message 会被换成一个通用文案（防止把数据库
//     结构、SQL、文件路径这类信息泄露给浏览器）；真正的原因只在
//     服务端日志里，靠 error.digest 这个哈希去对。
// 所以下面两个都显示：message 给人看，digest 用来去日志里搜。
// ============================================================================

type ErrorProps = {
  error: Error & { digest?: string }
  /** 重新请求并重新渲染当前这一段。绑定按钮用这个 */
  retry: () => void
}

export default function Error({ error, retry }: ErrorProps) {
  // 顺手打到浏览器控制台，方便开发时直接看到完整堆栈。
  // 真实项目这里应该接到 Sentry / 自建日志之类的上报服务。
  useEffect(() => {
    console.error("[app/error.tsx] 捕获到未处理的渲染错误:", error)
  }, [error])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 px-4 py-24 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-7 text-destructive" />
      </div>

      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold">页面出错了</h1>
        <p className="text-sm text-muted-foreground">
          这不是你的操作问题。可以直接重试，如果一直失败就是代码有 bug。
        </p>
      </div>

      {/* 错误信息本身。用 pre 是为了保留堆栈里的换行和缩进 */}
      <pre className="max-h-60 w-full overflow-auto rounded-lg border bg-muted/50 p-3 text-left text-xs whitespace-pre-wrap text-muted-foreground">
        {error.message || "（服务端没有返回具体信息）"}
      </pre>

      {/*
        digest 是服务端错误的「取件码」。
        浏览器只拿到一个哈希，真正的原因在跑 next dev / next start
        的那个终端里，搜这个值就能定位到原始堆栈。
      */}
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          错误编号{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
            {error.digest}
          </code>
          ，可在服务端终端里搜索它定位原始堆栈
        </p>
      )}

      <Button onClick={() => retry()} className="gap-1.5">
        <RotateCw className="size-4" />
        重试
      </Button>
    </div>
  )
}
