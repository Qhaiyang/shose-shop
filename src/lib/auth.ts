import { cache } from "react"
import { cookies } from "next/headers"
import { SignJWT, jwtVerify } from "jose"

import { prisma } from "@/lib/prisma"
import { USER_ROLE, type UserRole } from "@/lib/constants"

// ============================================================================
// 会话认证
//
// 【方案】手写 JWT + httpOnly Cookie（没有用 NextAuth）
//
// 流程：
//   登录/注册 → signSessionToken(userId) 签一个 JWT → 写进 httpOnly cookie
//   之后每次请求 → getCurrentUser() 从 cookie 读 JWT → 验签 → 查出用户
//
// 【为什么 httpOnly】
// 带 httpOnly 的 cookie，JavaScript 读不到（document.cookie 看不见），
// 所以即使页面被 XSS 注入了脚本，也偷不走登录凭证。代价是前端无法知道
// 「我登录了吗」，必须由服务端渲染时告诉前端 —— 这也是为什么登录状态
// 是通过 Server Component 的 props 往下传的。
//
// 【和 NextAuth 的取舍】
// 自己写能看到每一步在做什么，但少了 NextAuth 帮你处理的 CSRF token、
// session 轮转、第三方 OAuth。学习项目够用，上生产要补齐。
//
// 【谁在用这些函数】
//   signSessionToken / createSession → src/app/actions/auth.ts 的注册和登录
//   destroySession                   → src/app/actions/auth.ts 的退出
//   getCurrentUser                   → layout、各页面、以及每个需要鉴权的
//                                      Server Action（见 actions/cart.ts 顶部说明）
// ============================================================================

/** cookie 名。改这里就能全局改名 */
export const SESSION_COOKIE = "session"

/** 会话有效期：7 天 */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

/**
 * 签名密钥。
 * 延迟到调用时才读取（而不是模块顶层），这样构建期没有 .env 也不会崩。
 */
function getSecretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error(
      "缺少环境变量 JWT_SECRET。请检查项目根目录的 .env 文件（可参考 .env.example）。",
    )
  }
  return new TextEncoder().encode(secret)
}

// ---------------------------------------------------------------------------
// 签发
// ---------------------------------------------------------------------------

/**
 * 给用户签一个会话 JWT。
 * 只在 Server Action / Route Handler 里调用（因为要写 cookie）。
 */
export async function signSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecretKey())
}

/** 把会话写进 cookie。只能在 Server Action / Route Handler 里调用 */
export async function createSession(userId: string): Promise<void> {
  const token = await signSessionToken(userId)
  const cookieStore = await cookies()

  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // 生产环境走 HTTPS，本地开发是 http，强行 secure 会导致 cookie 写不进去
    secure: process.env.NODE_ENV === "production",
    // strict 太激进（从外站点回来会掉登录态），lax 是常规选择
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

/** 清除会话 cookie */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export type SessionUser = {
  id: string
  email: string
  name: string
  role: UserRole
}

/**
 * 取当前登录用户。未登录、token 过期、token 被篡改都返回 null。
 *
 * 【为什么用 React 的 cache() 包一层】
 * layout 要调它（渲染顶部导航），页面本身也常常要调它（判断权限）。
 * 不包的话，同一次页面渲染里会重复查两遍数据库。
 * cache() 的作用是「同一个请求内，相同参数的调用只真正执行一次」，
 * 第二次直接返回第一次的结果。
 *
 * 注意它**不是**跨请求的缓存 —— 下一个请求会重新执行。
 * 所以数据库里改了用户角色，下一次请求就能看到最新值，不会读到脏数据。
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value

  if (!token) return null

  let userId: string
  try {
    const { payload } = await jwtVerify(token, getSecretKey())
    if (typeof payload.sub !== "string") return null
    userId = payload.sub
  } catch {
    // 验签失败：token 被改过、过期了、或者换了密钥。
    // 这属于正常情况（比如用户清了 cookie），不该抛错，返回未登录即可。
    return null
  }

  // 验签通过不代表用户还在 —— 账号可能已被删除
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  })

  if (!user) return null

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === USER_ROLE.ADMIN ? USER_ROLE.ADMIN : USER_ROLE.USER,
  }
})

// ---------------------------------------------------------------------------
// 管理员鉴权
// ---------------------------------------------------------------------------

/**
 * 取当前管理员。不是管理员就返回错误，绝不放行。
 *
 * 【为什么返回错误对象而不是 redirect】
 * redirect() 靠抛异常工作，在 Server Action 里会把调用方自己的 try/catch
 * 搅乱（见 actions/auth.ts 的说明）。而且对 action 来说，「没权限」
 * 应该是一句能弹给用户看的提示，不是一次跳转。
 *
 * 【为什么登录和权限分开判断】
 * 两者要给不同的提示：「请先登录」和「你没有权限」对用户的下一步动作
 * 是完全不同的指引。但在**返回给外界的信息**上要克制 ——
 * 这里会透露出「该账号不是管理员」，因为我们本来就已经确认了调用者是谁，
 * 这不算信息泄露。真正要小心的是「这个订单存不存在」那类匿名探测。
 *
 * 【为什么在 lib 里而不是 actions/admin.ts 里】
 * 第 7 步加了退款，管理员的「批准 / 拒绝」写在 actions/refund.ts ——
 * 那个文件里既有买家的操作也有管理员的，是**按业务**分的，
 * 而 actions/admin.ts 是**按权限**分的。两套切法都合理，于是权限检查
 * 就成了两个文件都要用的东西。
 *
 * 抄一份当然能跑，但那是把「谁算管理员」这件事变成了两个地方各判一次：
 * 将来加了超级管理员 / 客服角色，漏改一处的表现是**某个后台入口
 * 对普通用户敞开着**，而且没有任何测试会红。放这里，改一次全局生效。
 *
 * 注意它必须待在 lib —— "use server" 的文件只能导出 async 函数，
 * 一个返回联合类型的辅助函数没法从 action 文件里 export 出来给别人用。
 */
export async function requireAdmin(): Promise<
  { ok: true; user: SessionUser } | { ok: false; error: string }
> {
  const user = await getCurrentUser()

  if (!user) return { ok: false, error: "登录状态已失效，请重新登录" }

  if (user.role !== USER_ROLE.ADMIN) {
    // 服务端日志里记一笔。有人在反复尝试调后台接口时，
    // 这条日志就是发现异常的信号
    console.warn(`[admin] 非管理员尝试执行后台操作: ${user.email}`)
    return { ok: false, error: "没有权限执行这个操作" }
  }

  return { ok: true, user }
}
