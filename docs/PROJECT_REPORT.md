# 鞋类电商商城 · 项目报告

> 本文档分两部分来源：**第 1–6 章由仓库内容自动提取**（数据均为实测），
> **第 7–8 章由开发过程复盘补写**（见文末占位）。
>
> 最后更新：2026-10-09　对应提交：`45570f5`

---

## 1. 概览

**一句话定位**：一个把所有业务逻辑手写出来的鞋类电商全栈项目 —— 刻意不引入任何电商框架，
目的是把「并发下的正确性」这类问题落到可运行、可测试的真实代码里，而不是停在 PPT 上。

### 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 16.3.7（App Router + Turbopack） | Server Components + Server Actions |
| UI | React 19、Tailwind v4、shadcn/ui | shadcn 底层是 **base-ui**，不是 Radix |
| 语言 | TypeScript（全量 `strict`） | 业务状态用联合类型收窄 |
| 数据 | Prisma 7.10.0 + PostgreSQL 17 | 从 SQLite 迁移而来，迁移文件全部重做 |
| 支付 | Stripe（PaymentIntent + Elements + Webhook） | 测试模式；卡号不进本店 |
| 认证 | 自签 JWT（`jose` HS256）+ `bcryptjs` | 刻意不上 NextAuth，见第 3 章第 12 条 |
| 状态 | Zustand（未登录购物车）+ 数据库购物车 | 登录后合并 |
| 测试 | Vitest（单元 + 集成）+ Playwright（E2E） | 三层分工，见第 5 章 |

### 规模数据

以下数字均为实测（命令与口径一并列出，便于复核）：

| 指标 | 数值 | 口径 |
|---|---|---|
| Git 提交数 | **13** | `git rev-list --count HEAD` |
| 开发区间 | 2026-09-29 → 2026-10-09 | 首次提交到最近提交 |
| 源码文件数 | **117** | `src/**.{ts,tsx}`，**排除** `src/generated/`（Prisma 生成物，不提交） |
| 源码行数 | **22,299** | 同上口径 |
| ├ `src/app` | 40 文件 / 6,468 行 | 路由与 Server Actions |
| ├ `src/components` | 45 文件 / 7,409 行 | 业务组件 |
| └ `src/lib` | 32 文件 / 8,422 行 | 业务逻辑核心（`orders.ts` 为重中之重） |
| 测试文件数 | 41 | 单元 14 / 集成 19 / E2E 8 |
| 测试代码行数 | 11,835 | `tests/**/*.ts` |
| 测试用例数 | **653** | `npm run test` 实际输出：343 / 303 / 7 |
| 数据表 | **13** | `prisma/schema.prisma`；迁移文件 3 个 |
| Schema 行数 | 675 | 含大量「为什么这么设计」的注释 |

> 测试代码 11,835 行 vs 源码 22,299 行 —— **测试约为源码的一半**。
> 这个比例是刻意的：这个项目要练的就是「并发下会不会错」，
> 而这类问题不写测试根本无法确认。

### 状态

| | |
|---|---|
| 封版 | **2026-10-08**（功能范围冻结） |
| 部署 | **已上线** —— Vercel + Neon，见第 6 章 |
| 当前 | 封版后仍在练手轮次：补 Stripe 真实支付链路、修并发与终态边界问题 |

---

## 2. 功能清单

### 买家侧

| 模块 | 做到哪一步 |
|---|---|
| 浏览 | 商品列表、分类筛选、多图轮播、商品详情 |
| 搜索 | 关键词搜索 + 排序（标题/价格/时间） |
| 尺码助手 | 输入脚长返回建议尺码（`size_guides` 表驱动） |
| 购物车 | 未登录存本地（Zustand），登录后落到账号上，两种购物车共用同一套库存校验 |
| 下单 | 购物车结算 → 事务内扣库存、占券名额、生成订单；带**幂等键**防重复提交 |
| 支付 | Stripe 收银台（PaymentIntent + Elements）+ webhook 验签回调驱动状态 |
| 退款 | 买家提交退款申请（记下申请前状态），管理员批准或驳回 |
| 优惠券 | 满减 / 折扣 / 封顶三类；领券与核销均把名额判断写进 SQL |
| 收藏 | 商品收藏（`(userId, productId)` 复合唯一） |
| 评价 | 按订单项评价（一单一件评一次），管理员可下架 |
| 订单备注 | 下单时选填，发货前可改（能否改由状态机管） |

### 管理后台

| 模块 | 做到哪一步 |
|---|---|
| 商品 CRUD | 商品 + SKU 两级；批量上下架 / 改价 / 调库存（单事务，失败整体回滚） |
| 订单管理 | 列表、详情、**发货**（条件更新 `status = PAID`） |
| 退款审批 | 批准 / 驳回；批准时库存与券一并回补 |
| 优惠券 | 新建、启停、设置名额与限领 |
| 评价管理 | 查看、下架 |
| 数据看板 | 四张指标卡，全部走 `groupBy` / `aggregate`，不在 JS 里循环 |

**后台权限**：`admin/layout.tsx` 只挡住「页面渲染」。
每个 Server Action 另行以 `requireAdmin()` 开头做独立校验 —— 理由见第 3 章第 11 条。

---

## 3. 架构决策记录

> 本章自 README「核心设计决策」一节**原文搬运，未做改动**。

### 1. 库存扣减：把判断塞进 WHERE，看受影响行数

朴素写法是「先查库存够不够，再扣」：

```ts
const sku = await prisma.sku.findUnique({ where: { id } })
if (sku.stock < quantity) throw new Error("库存不足")
await prisma.sku.update({ where: { id }, data: { stock: sku.stock - quantity } })
```

两个人同时买最后一件，两次查询都会看到 `stock = 1`，两次都通过检查，然后都扣 —— 超卖。
根因是**读和写之间有一段时间窗口，窗口里世界变了**。

正确写法是把判断条件和扣减放进同一条 SQL：

```ts
const result = await prisma.sku.updateMany({
  where: { id, stock: { gte: quantity } },   // ← 够不够，交给数据库判断
  data: { stock: { decrement: quantity } },
})
if (result.count === 0) return { ok: false, error: "库存不足" }  // ← 没抢到
```

`count` 是**实际被改动的行数**。库存不够时 WHERE 不匹配，改动 0 行，我们就知道没抢到。
整个判断+扣减是一个原子操作，不存在窗口。

这条「条件更新 + 看受影响行数」的模式在这个项目里反复出现：
支付（`status = PENDING_PAYMENT AND 未过期`）、发货（`status = PAID`）、
超时取消（`status = PENDING_PAYMENT AND expiresAt <= now`）、
后台出库（`stock >= 数量`）用的都是它。

### 2. 事务解决的是另一个问题

`$transaction` 容易被当成「并发问题的万能药」，但它解决的是
**多个 SKU 之间的全有或全无**：一单买 3 个不同 SKU，不能扣了前两个、第三个失败，
那样购物车里的东西买了一部分、钱却按整单收。

而**单个 SKU 的并发安全靠的是上面的条件更新，不是事务**。
两者解决的是不同层面的问题，不能互相替代。

超时取消那边还有一条：**每笔订单一个事务，不是一整批一个大事务**。
一个大事务会长时间持有写锁，而且一笔失败会拖垮整批。

### 3. 金额解析不用 `parseFloat`

`parseFloat("0.29") * 100 === 28.999999999999996`。
`src/lib/form.ts` 的 `parseYuanToCents` 把它当**字符串**拆小数点，
全程只有整数运算，一分钱都不会差。

### 4. 库存只能「增减」，不能「设为 N」

后台的库存操作是「入库 N 件 / 出库 N 件」，没有「把库存设成 N」的输入框。
因为绝对赋值有竞态：

```
t1  管理员看到库存 100，决定改成 100（没变）
t2  买家下单 3 件，库存 100 → 97
t3  管理员提交，写入 100  ← 卖掉的 3 件被无声地补回来了
```

「+N」表达的是「又进了 N 件货」，这句话在任何时刻都成立，跟当前库存是多少无关。

### 5. 订单状态机集中在 `src/lib/constants.ts`

```
待支付 ──支付──> 已支付 ──发货──> 已发货 ──确认收货──> 已完成
   │                │
   └──超时/取消──> 已取消 <──取消（退款场景，先留着）
```

合法流转表 `ORDER_STATUS_TRANSITIONS` 写在一处，`canTransition()` 是唯一的判断入口。
每次流转都走 `updateMany({ where: { id, status: 期望的当前状态 } })`，
`count === 0` 就说明状态已经被别人改过了 —— 这样既防止重复点击，
也防止乱序流转（比如没付款就发货）。

### 6. 超时取消：先抢占，再恢复库存

订单超时后要取消，还要把库存还回去。但「取消」和「买家付款」是竞争关系 ——
如果写成「先判断该不该取消，再取消」，判断和取消之间的窗口里买家可能付了钱，
于是出现「收了钱却被取消」的订单。

解法还是条件更新：`WHERE status = 'PENDING_PAYMENT' AND expiresAt <= now()`。
**只有抢到了这次状态变更的扫描者，才有资格去恢复库存**，抢不到的什么都不做。
这样扫描可以随便重复跑，是幂等的。

### 7. 「该不该还库存」为什么不在函数里判断

第 6 条里的「还库存」有一个前置判断：**什么状态的订单取消了才需要还**。
这个判断原来是写在 `restoreStockForOrder` 里面的：

```ts
if (!shouldRestoreStock(statusBeforeCancel)) return 0
```

加了退款之后，这条规则**不再成立**了：

| 场景 | 订单状态 | 要不要还库存 |
|---|---|---|
| 取消订单 | `SHIPPED` / `COMPLETED` | **不还** —— 货已经在路上，属于售后问题 |
| 批准退款 | `SHIPPED` / `COMPLETED` | **要还** —— 钱都退了，货是平台的 |

同一个状态、两个相反的结论。这说明「该不该还」**根本不是状态的函数** ——
它取决于调用方正在做哪件事。

所以闸门从函数里挪到了两个调用点，各自写清楚自己的规则：

- `cancelOneExpiredOrder` → 用 `shouldRestoreStock(status)` 卡住
- `approveRefund` → 无条件还

**为什么不是传一个 `shouldRestore: boolean` 参数**：那样函数签名上就看不出调用方的意图了，
而这两个调用点的差别恰恰是这块业务里最容易搞错的地方 —— 必须让它在代码里显眼。

退券（`restoreCouponForOrder`）是同一套形状，但规则**单独写了一对**判断
（`shouldRestoreCoupon`），没有复用 `shouldRestoreStock`。两者现在的取值恰好一样，
理由却不同：库存那条是「货没发出去」，券这条是「钱没收到」。
将来加「发货后 7 天无理由退货」就会分叉 —— 库存不回来（要退回仓库质检），
券还是要还（券是平台自己发的）。今天合成一个，那天改一处就会连带改错另一处。

代价要说清楚：**同一个状态判断现在散落在调用点**，读代码时要先看调用方才能知道规则。
换来的是「两个路径规则不同」这件事在代码里一眼可见 ——
而它们本来就不同，只是以前恰好撞在一起了。

### 8. 退款：为什么要把「申请前的状态」记下来

退款不是「改个状态」那么简单。买家申请时，订单可能是 `PAID`、`SHIPPED` 或 `COMPLETED`；
管理员**拒绝**时，订单要回到**申请前那一个**状态。

`refund_requests.previousStatus` 就是为这件事存的快照。不存它的话，拒绝时只能一律退到一个
写死的状态 —— 而一个已发货的订单被退回 `PAID`，管理员界面上会重新出现「发货」按钮，
**同一件货能发两次**。

光看 `REFUNDING` 也推不出原来是什么：状态机里 `REFUNDING` 有三条回退边
（→ `PAID` / `SHIPPED` / `COMPLETED`），那是**拒绝专用**的。
另一条路是给每个来源状态各造一个中间态（`REFUNDING_FROM_PAID`…）—— 状态爆炸，不值当。

两个细节：

- **快照是在申请时、用「刚读到的那个状态」钉死的**，而不是拿 `in (PAID, SHIPPED, COMPLETED)`
  当抢占条件。后者在「读完紧接着管理员发货了」的情况下仍然会命中，
  于是把 `previousStatus` 记成 `PAID` —— 万一被拒绝，订单会退回一个它**从没待过**的状态。
  钉死成读到的那个值，这种情况直接算抢占失败，让用户重试。
- 回退本身仍然是条件更新：`UPDATE orders SET status = ? WHERE id = ? AND status = 'REFUNDING'`。
  拒绝和批准都在抢 `REFUNDING` 这个状态位，抢不到的那一个什么都不做。

至于**批准**那条路，订单一律进 `REFUNDED`，用不上 `previousStatus` ——
这个字段存在的唯一理由，就是拒绝时能退回去。

### 9. 优惠券的名额：抢占写进 `INSERT`，而不是「先数再插」

「每人限领 N 张」最容易写成的样子：

```ts
const count = await prisma.userCoupon.count({ where: { userId, couponId } })
if (count >= coupon.perUserLimit) return { ok: false, error: "已领过" }
await prisma.userCoupon.create({ data: { userId, couponId } })
```

两个人同时点「领取」，两次 `count` 都读到 0，两次都通过检查，然后都插入 ——
限领 1 张的券领到了 2 张。这和第 1 条是**同一个病**：读和写之间有窗口。

解法也是同一招，把判断塞进那条语句里，**让数据库裁决**：

```sql
INSERT INTO "user_coupons" ("id", "userId", "couponId", "createdAt")
SELECT $1, $2, $3, $4
WHERE (SELECT COUNT(*) FROM "user_coupons"
       WHERE "userId" = $2 AND "couponId" = $3) < $5
```

「数」和「插」成了同一条语句，中间没有缝。受影响行数 **0** 就说明超了限领。

名额的另一头 —— 下单时**扣掉**一个名额 —— 也是这个套路，
只不过条件要比较**同一行的两个列**：

```sql
UPDATE "coupons" SET "usedCount" = "usedCount" + 1
WHERE "id" = $1 AND "usedCount" < "totalLimit"
```

这条只能退回原生 SQL：Prisma 的 `updateMany` 里写 `usedCount: { lt: coupon.totalLimit }`，
`totalLimit` 会被当成**字面量**（也就是「查出来的那个旧值」），
那正是我们要避开的「先查后写」。受影响行数 0 = 没抢到名额。

> 【照抄这段 SQL 的话，两个坑先看这里】
>
> - **列名必须加双引号**。PostgreSQL 会把不加引号的标识符一律折叠成小写，
>   而建表时列名是带引号的驼峰（`"usedCount"`）—— 裸写会报
>   「字段 `usedcount` 不存在」（SQLSTATE 42703）。SQLite 的标识符不区分大小写，
>   所以这个坑只在换库之后才露出来，而且**只有引用驼峰列的语句会中招**。
> - **`id` 和 `createdAt` 要自己传**。原生 SQL 绕过 Prisma 层，
>   `@default(cuid())` 和那些默认值在这里都不存在。

### 10. 订单查询的越权防护：把 `userId` 放进 WHERE

```ts
// ✅ 查的时候就限定是自己的
prisma.order.findFirst({ where: { id: orderId, userId } })

// ❌ 先查出来再在代码里判断 —— 迟早有人忘了判断
const order = await prisma.order.findUnique({ where: { id: orderId } })
if (order.userId !== userId) throw new Error("无权访问")
```

`getOrderDetail(orderId, userId)` 和 `getOrderDetailForAdmin(orderId)`
有意保持成**两个独立函数**，而不是合并成 `getOrderDetail(id, userId?)`。
可选参数会造出一条「忘记传」的路径，那条路径就是静默越权。

### 11. layout 保护不了 Server Action

`src/app/admin/layout.tsx` 里做了权限校验，非管理员看不到后台页面。
但那**只对页面渲染有效**。

Server Action 编译后是一个独立的 POST 端点。客户端可以直接构造请求去调它，
整个 React 组件树（包括 layout）根本不会参与执行。也就是说：
普通用户没法通过浏览器*看到*后台，但完全可以自己发一个请求去调 `shipOrderAction`。

所以 `src/app/actions/admin.ts` 里**每一个** action 都以 `requireAdmin()` 开头，
检查当前用户是不是管理员。前端的 `disabled`、有没有渲染这个按钮、
路由叫不叫 `/admin`，全都不算数。

这不是冗余，是纵深防御：layout 让用户看不见后台，action 里的校验保证被绕过也改不动数据。

### 12. 认证用自己签的 JWT，没上 NextAuth

这个项目的目的是学「会话是怎么工作的」，NextAuth 会把签发、校验、cookie 设置、
回调流程全部封装掉，正好把想练的部分藏起来。自己用 `jose` 签一个 HS256 token、
塞进 httpOnly cookie、每次请求验一遍，代码量不大，但每一步都看得见。

密码用 `bcryptjs` 哈希后存储，绝不存明文。

---

## 4. 数据模型

### 关系图

```
User ──< CartItem >── Sku ──< OrderItem >── Order ── User
                       │
                       └── Product
```

### 表清单（13 张）

| 表 | 说明 | 关键约束 |
|---|---|---|
| `users` | 用户 | `email @unique`；`role` 存 String（见下） |
| `products` | 商品 SPU：只描述「这是什么鞋」，无价格无库存 | `@@index([category])` |
| `skus` | 可买卖单位（「42 码 / 曜石黑」） | `@@unique([productId, size, color])`、`skuCode @unique` |
| `cart_items` | 购物车（已登录） | `@@unique([userId, skuId])`；两级都 `onDelete: Cascade` |
| `orders` | 订单 | `orderNo @unique`、`stripePaymentIntentId @unique`、`@@unique([userId, idempotencyKey])`、`@@index([status, expiresAt])` |
| `order_items` | 订单项**快照** | `orderId` Cascade；`skuId` **`onDelete: SetNull`** |
| `reviews` | 评价 | `orderItemId @unique`（一单一件评一次） |
| `size_guides` | 尺码助手数据 | `@@unique([category, suggestedSize])` |
| `favorites` | 收藏 | `@@unique([userId, productId])` |
| `coupons` | 优惠券模板 | `code @unique`；`usedCount` / `totalLimit` 在 SQL 里比较 |
| `user_coupons` | 券的持有记录 | `orderId @unique`（**`SetNull`**，非 Cascade）；`(userId, couponId)` **刻意不唯一** |
| `refund_requests` | 退款申请 | `previousStatus` 快照；`@@index([status, createdAt])` |
| `webhook_events` | 支付渠道事件（幂等） | `@@unique([provider, eventId])`；`orderId` **无外键** |

### 四个特殊设计

**① 金额一律 `Int`，单位「分」。**
¥899.00 存成 `89900`。不用 `Float` —— `0.1 + 0.2 !== 0.3`，误差会累积成对不上账。
转「元」只发生在渲染最后一步（`src/lib/format.ts`）。

**② `OrderItem` 存快照，不存引用。**
商品名、尺码、颜色、成交价都冗余一份。订单是历史凭证，必须不可变 ——
管理员之后改价、改名、下架商品，都不该让三个月前的订单显示错误信息。

**③ 外键的删除语义是逐表想过的，不统一：**

| 关系 | 语义 | 理由 |
|---|---|---|
| `OrderItem.orderId → Order` | **Cascade** | 订单没了，订单项无意义 |
| `OrderItem.skuId → Sku` | **SetNull** | SKU 被物理删除后，订单项**仍然可读** |
| `Order.userId → User` | **无 Cascade** | 订单是历史凭证，不能因为删用户而消失 |
| `Order.couponId → Coupon` | **SetNull** | 券被删，订单还在，只是「用了哪张券」变空 |
| `UserCoupon.orderId → Order` | **SetNull** | 订单没了，这张券要变回「未使用」 |

**④ 复合唯一承担业务规则，不只做去重：**

- `Sku @@unique([productId, size, color])` —— 数据库层面就不可能有「两个 42 码黑色」
- `CartItem @@unique([userId, skuId])` —— 同一个人同一 SKU 只有一行
- `Favorite @@unique([userId, productId])` —— 收藏判重
- `Order @@unique([userId, idempotencyKey])` —— 下单幂等；**可空**是关键：
  PostgreSQL 唯一索引把多个 `NULL` 视为互不相等，所以不带键的订单不受约束
- `UserCoupon (userId, couponId)` **故意不加唯一** —— 加了的话，限领 2 张的券
  就永远只能有一张。限量由 `perUserLimit` + `INSERT … SELECT … WHERE` 控制

### `status` / `images` 为什么还是 `String`

项目已从 SQLite 迁到 PostgreSQL 17，但这两处**有意保持不变**：
`status` / `role` 等枚举仍存 `String`（靠 TS 联合类型 + zod 收窄），
`Product.images` 仍存 JSON 字符串。

原因：这两条本是 SQLite 不支持 `enum` 和标量数组逼出来的写法，
而那次迁移的目标是**换掉存储引擎、语义一个都不动** ——
把「改类型」混进来，一旦测试挂了就分不清是迁移错了还是类型改了。

代价是真实的：数据库层拦不住非法状态，`images` 也没法用 SQL 直接查元素。
清理这两处是明确的下一步（见第 6 章「已知限制」）。

---

## 5. 测试体系

### 三层分工

| 层 | 工具 | 数量 | 测什么 | 为什么在这一层 |
|---|---|---|---|---|
| 第一层 | Vitest | **343** | 纯函数：金额换算、状态机白名单、所有 zod schema、购物车算价、开放重定向防护 | 无依赖、算错了也不会报错，必须靠测试钉住 |
| 第二层 | Vitest + Prisma | **303** | 真数据库 + **真并发**：状态机每条流转、越权、下单事务、竞争 | 「逻辑对但并发下会错」只有真库能验 |
| 第三层 | Playwright | **7** | 黄金路径：注册 → 加购 → 下单 → 支付 → 发货 → 确认收货 | 前两层都绕开了 HTTP 和浏览器 |
| **合计** | | **653** | | `npm run test` 一条命令跑完并打汇总表 |

> 数字为 `npm run test` 实际输出：**343 / 303 / 7 = 653**，三层全绿。

### 三层各自的关键设计

**第一层**：这一层曾经写不了 —— zod schema 原本定义在 `"use server"` 文件里，
而那种文件只能导出 async 函数。为了能测，把它们挪到了
[src/lib/schemas.ts](../src/lib/schemas.ts)。
**能被单独导入，是纯逻辑的基本要求。**

**第二层**：连一个独立库（`shoptest`，每次跑前整个删掉重建，走**和生产同一批迁移文件**），
直接调 `src/lib/` 里的函数。造数工具（`tests/integration/helpers/db.ts`）每个破坏性操作前
先查 `current_database()` 确认是 `shoptest`。

**第三层**：独立库（`shope2e`）+ 独立构建目录（`.next-e2e`），
所以能和正在跑的 `npm run dev` 同时存在。**刻意不做全量覆盖** ——
E2E 最慢也最容易 flaky，堆用例的边际收益很低。

### 三个特殊测试方法

**① 并发竞争测试（第二层）**
20 轮 `Promise.all([payOrder, cancelExpiredOrders])`，每轮只能有一个赢家，
库存永远自洽。这是整个套件里最有价值的用例 —— 它验证的是
「把判断塞进 WHERE、看受影响行数」这套写法在真实并发下**真的成立**，
而不只是看起来合理。

**② 变异实验 / 对照实验**
用于定位复杂 bug：构造 A/B/C 三组受控条件（如 PaymentIntent 处于
`succeeded` / 全新 / `canceled` 三种状态），确认哪一组**稳定复现**、
哪一组**稳定正常**。这样把「偶发」变成「确定」。

**③ stash 还原验证**
验证「改动前后行为差异」时，用 `git stash` 回到改动前跑一遍。
注意点：**必须同步处理 gitignored 的生成物**（Prisma Client 等），
否则会造成假失败 —— 见第 7 章。

---

## 6. 部署与运维

### 当前部署

线上是 **Vercel 跑 Next.js + Neon 托管 PostgreSQL**，两边都免费。

| | |
|---|---|
| 代码仓库 | <https://github.com/Qhaiyang/shose-shop> |
| 生产数据库 | Neon 托管 PostgreSQL，**Singapore**（`ap-southeast-1`） |
| 线上地址 | <https://shose-shop-beta.vercel.app> |
| Build Command | `prisma migrate deploy && next build` |

> ⚠️ **打不开线上地址是正常的** —— Vercel 默认域名 `*.vercel.app` 在国内直连不稳定，
> 需要代理。绑自定义域名可以解决，本项目没有绑。

### 环境变量

生产环境变量 **5 个**（值只存在 Vercel，不在仓库里）：

| 变量名 | 用途 |
|---|---|
| `DATABASE_URL` | 运行时连库。Neon 的**池化**串（主机名带 `-pooler`） |
| `DIRECT_URL` | `prisma migrate deploy` 连库。Neon 的**直连**串 |
| `JWT_SECRET` | 签发 / 校验登录 JWT 的密钥 |
| `CRON_SECRET` | `/api/cron/expire-orders` 的 Bearer 令牌 |
| `ORDER_TIMEOUT_MINUTES` | 订单超时自动取消的分钟数 |

> ⚠️ 线上未配以上三个 Stripe 变量（`STRIPE_SECRET_KEY`、
> `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`、`STRIPE_WEBHOOK_SECRET`），
> **支付链路在线上不可用**（仅本地开发可走通）。

### 定时任务

扫超时订单有两种触发方式，**都实现了**：

1. **页面懒扫描（默认在跑）** —— 访问 `/orders` 或 `/orders/[id]` 时顺手取消自己名下过期的订单。
   不需要额外进程。
2. **HTTP 端点 + 外部定时器** —— `GET/POST /api/cron/expire-orders`，
   `Authorization: Bearer <CRON_SECRET>`。本地可用 `scripts/cron-dev.mjs` 模拟
   （默认关闭，免得没注意时后台一直在改数据）。

### 已知限制

这是个学习项目，以下是**故意**没做的，不是漏了：

- **支付只有 Stripe 这一条链路。** 缺：退款没接 Stripe 退款 API（仍走手写审批）、
  **没有定时对账**（唯一的对账入口是用户再点一次「去支付」时顺手补的那一刀）、
  没有 3D Secure 之外的支付方式验证、`stripe listen` 之外没有 webhook 重放/监控。
  另：结算货币是 USD，人民币按汇率换算后结算。
- **退款是「管理员审批 + 改状态」，没有真的退钱。** 没有部分退款、没有退款流水。
- **发货没有物流单号。** 所以「确认收货」靠买家自己点，不是签收回调。
- **库存回滚时机简化。** 一批准退款就入库，等于假设每双退回来的鞋都是完好的。
- **没有运费、没有税费。** 金额构成只有「商品小计 − 优惠」两项。
- **图片是手填路径，不是上传。**
- **搜索和分类筛选很基础。** 换到 PostgreSQL 后 `tsvector` / `pg_trgm` 技术上已可行，只是没做。
- **没有订单超时兜底重试。** 定时任务失败就是失败了，下次扫描会补上（幂等），但没有告警。
- **部署形态是单实例。** 超时扫描在多实例上会重复跑；真要扩得先给定时任务加分布式锁或租约。
- **「支付成功 → 确认中 → 轮询 → 徽章变已支付」这段前端逻辑没有自动化测试。**
  `stripe-checkout.spec.ts` 只到「弹层打开」为止，这一段靠 `stripe listen` + 测试卡手动验。
- **`status` 仍存 String、`images` 仍存 JSON 字符串**（理由见第 4 章）。

---

## 7. 关键工程事件

### ① layout 拦不住 Server Action

- **问题**：Next.js 的 layout 鉴权只对页面渲染有效，Server Action 编译后是独立 POST 端点，客户端可绕过 layout 直接调
- **发现方式**：**重放测试**——同一请求、同一 action id，换三种身份（普通用户 cookie / 无 cookie / 管理员 cookie）重放。前两种被拒、管理员成功
- **决策**：每个 Server Action 独立 `requireAdmin()`
- **代价**：代码重复，但这是纵深防御

### ② PostgreSQL 折叠未加引号的标识符

- **问题**：Prisma 建表时列名是带引号的 `"paidAt"`，原生 SQL 里未加引号的 `paidat` 被 PostgreSQL 折叠成小写
- **症状**：`字段 "paidat" 不存在`（SQLSTATE 42703），**三处原生 SQL 静默 500**——页面能打开，走到某条路径才炸
- **发现方式**：dev server 日志里一条报错，扫全仓找同类
- **决策**：原生 SQL 标识符一律双引号

### ③ Prisma 7 的 P2002 没有 `meta.target`

- **问题**：原方案用 `error.meta?.target` 区分"撞的是幂等键还是 orderNo"，Prisma 7 的 `meta` 只有 `{driverAdapterError, table}`，`target` 恒为 `undefined`
- **症状**：判断永远 false，**会静默穿透成真失败**
- **发现方式**：并发测试红了，错误原样抛出
- **决策**：改用「查询本身当判据」——P2002 后按 `(userId, idempotencyKey)` 查一次
- **代价**：多一次查询，但不依赖 Prisma 内部结构

### ④ `INSERT ... SELECT` 在 READ COMMITTED 下不原子

- **问题**：领券的 `INSERT ... SELECT ... WHERE COUNT(*)` 在 PostgreSQL 默认隔离级别下，子查询读到的是各自快照的 0，不持有锁
- **症状**：限领 2 张，10 个并发领到 3-4 张，**~46% 概率复现**
- **发现方式**：stash 对照实验——干净 HEAD 上 13 次 6 红
- **决策**：事务内 `pg_advisory_xact_lock` 串行化
- **附加发现**：去掉锁只留事务 → 6 次 4 红，证明"事务本身修不好它"（READ COMMITTED 不提供可串行化）

### ⑤ 「钱收了、单没了」边界在真实世界第一次触发

- **问题**：webhook 在订单已被超时取消之后才到达
- **实际发生**：一笔真实测试订单，PI `succeeded` 但订单被 `cancelExpiredOrders` 扫成 `CANCELLED`
- **设计响应**：`WebhookEvent` 记一行、`appliedAt` 留空、打 error 日志、返回 200、**不自动恢复**
- **告警口径**：`/api/health` 的 `orphanedWebhooks` 从 0 变 1
- **决策**：不自动恢复（选了 B 方案）——A 方案会超卖

---

## 8. 反思

**做得好的：**

- 653 条三层测试，覆盖边界和并发
- 12 条架构决策每条都有「问题 → 决策 → 代价」
- 金额存分、状态机白名单、Server Action 独立鉴权这些核心设计从头就对
- 测试方法：变异实验、对照实验、stash 还原验证

**做得不够的：**

- 一个巨型 initial commit（`27422f3`，188 文件），没有增量提交历史
- UI 没有品牌色，全是 shadcn 默认
- coupons 并发测试 flaky（~46%）存在多轮才被发现
- 支付成功后的"确认中轮询"面板无自动化测试
- 本地 webhook 环境配置门槛高（`stripe listen` + `whsec` 两件都做，还要账号一致）

**如果重做：**

- 从第一行代码就 `git init`，小步提交
- 环境配置文档写得更早、更细
- 并发用例更早暴露 `INSERT...SELECT` 的竞态
