"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { createSession, destroySession } from "@/lib/auth"
import { USER_ROLE } from "@/lib/constants"
import { safeNext } from "@/lib/form"
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "@/lib/password"
import { prisma } from "@/lib/prisma"
// 校验规则和 safeNext 都搬去了 lib —— 这样测试能直接 import 它们，
// 不必把整个依赖 next/cache、next/navigation 的 action 文件拖进测试环境
import { loginSchema, registerSchema } from "@/lib/schemas"

// ============================================================================
// 认证 Server Actions（注册 / 登录 / 退出）
//
// 【表单 action 的签名】
// 这几个函数要配合 React 的 useActionState 使用，签名固定为：
//     (上一次的返回值, formData) => 新的返回值
// 第一个参数是「上一次提交的结果」，用来把校验错误回传给表单显示。
// 首次渲染时它是 undefined（就是我们传的初始值）。
//
// 【redirect() 的坑，务必记住】
// redirect() 的实现方式是「抛出一个特殊异常」，Next 在框架层接住它然后
// 发起跳转。所以它绝对不能写在 try/catch 里面 —— 一旦被你的 catch 接住，
// 跳转就静默失效了，页面看起来像「提交了但什么都没发生」，非常难查。
//
//   错误写法：                         正确写法：
//   try {                              try {
//     ...                                ...
//     redirect("/")   ← 被 catch 吃掉      doSomething()
//   } catch (e) {                      } catch (e) { ... }
//     console.error(e)                 redirect("/")   ← 放在 try 外面
//   }
//
// 本文件里 redirect() 全部放在 try/catch 之外，就是为了绕开这个坑。
// ============================================================================

/** 表单状态：返回给 useActionState，用来渲染字段级错误和整体提示 */
export type AuthFormState =
  | {
      errors?: {
        name?: string[]
        email?: string[]
        password?: string[]
      }
      message?: string
    }
  | undefined

// 校验规则（loginSchema / registerSchema）在 src/lib/schemas.ts，
// safeNext 在 src/lib/form.ts —— 两个都是可以单独测试的纯值 / 纯函数，
// 定义在这个 "use server" 文件里就没法被测试 import。
// 本文件只负责：取 formData → 交给 schema → 查库 → 建会话 → 跳转。

/**
 * 判断是不是「唯一约束冲突」（Prisma 错误码 P2002）。
 * 这里用鸭子类型判断而不是 import Prisma 的错误类，是为了让本文件
 * 不依赖生成的 Prisma 客户端的具体导出路径。
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  )
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export async function registerAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const { name, email, password } = parsed.data

  // 提前查一次是为了给用户友好的字段级提示（不是为了防止重复，
  // 真正防重复的是数据库的 @@unique 约束，见下面的 catch）
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (existing) {
    return { errors: { email: ["这个邮箱已经注册过了"] } }
  }

  // 【为什么可以放心把哈希计算放在这里】
  // bcrypt 是 CPU 密集型的，会把当前线程卡住约 100ms。
  // 对学习项目完全够用；真实高并发场景会换成异步版本的 bcrypt 库，
  // 或者把登录/注册拆到单独的 worker 里，避免拖慢其他请求。
  const hashedPassword = await hashPassword(password)

  let userId: string

  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        // 注册的用户一律是普通用户。管理员只能由种子数据或后台指定，
        // 绝不能让前端传 role 上来 —— 否则任何人注册时都能把自己变成 ADMIN。
        role: USER_ROLE.USER,
      },
      select: { id: true },
    })
    userId = user.id
  } catch (error) {
    // 上面 findUnique 查到 create 之间有个时间窗口：
    // 两个请求同时用同一个邮箱注册，可能都通过了「没重复」的检查。
    // 数据库的唯一索引是最后一道防线，这里把它的报错翻译成人话。
    if (isUniqueViolation(error)) {
      return { errors: { email: ["这个邮箱已经注册过了"] } }
    }
    throw error
  }

  // 注册成功直接登录，不用再让用户去登录页输一遍
  await createSession(userId)

  revalidatePath("/", "layout")
  redirect(safeNext(formData.get("next")))
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

export async function loginAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const { email, password } = parsed.data

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, password: true },
  })

  // 【两个安全细节，都在这一行里】
  //
  // 1. 用户不存在时用 DUMMY_PASSWORD_HASH 顶上，让 bcrypt 照常跑一遍。
  //    否则「账号不存在」会立刻返回，「密码错误」要等 ~100ms，
  //    攻击者光看响应快慢就能判断出哪些邮箱在你这注册过。
  //
  // 2. 下面无论哪种失败都返回同一句话「邮箱或密码不正确」。
  //    如果分成「该邮箱未注册」和「密码错误」，等于给攻击者提供了一个
  //    免费的账号枚举接口 —— 拿一份邮箱清单批量试探就知道谁是你的用户了。
  const passwordMatches = await verifyPassword(
    password,
    user?.password ?? DUMMY_PASSWORD_HASH,
  )

  if (!user || !passwordMatches) {
    return { message: "邮箱或密码不正确" }
  }

  await createSession(user.id)

  revalidatePath("/", "layout")
  redirect(safeNext(formData.get("next")))
}

// ---------------------------------------------------------------------------
// 退出
// ---------------------------------------------------------------------------

/**
 * 退出登录：删掉 cookie 即可。
 *
 * 【为什么不用查数据库、不用维护黑名单】
 * 我们用的是无状态 JWT —— 服务端不保存会话，只看 cookie 里的签名。
 * 所以「退出」就是把 cookie 删掉，让浏览器不再携带它。
 *
 * 【代价（要知道）】
 * 如果 token 已经被别人复制走了，删本地 cookie 拦不住对方继续用，
 * 它会在 7 天后自然过期。真实项目里要做「服务端会话表」或
 * 「token 版本号」，退出时把服务端那份标记失效。学习项目先不做。
 *
 * 【注意 csrf】
 * 退出这种「登出」操作被 CSRF 触发的后果很轻（就是把用户踢下线），
 * 所以这里没做额外防护。但下单、改密码这类操作必须防。
 */
export async function logoutAction(): Promise<void> {
  await destroySession()

  revalidatePath("/", "layout")
  redirect("/products")
}
