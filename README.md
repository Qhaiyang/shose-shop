# 鞋店 · 一个手写的电商练手项目

一个能完整跑通的鞋类电商：浏览商品 → 加购物车 → 下单 → 支付 → 发货 → 确认收货，
外加退款、优惠券、收藏、评价、订单备注、尺码助手，
以及一个管理后台（商品 CRUD、订单管理、退款审批、优惠券、评价管理、数据看板）。

**这个项目的重点是「把电商的核心逻辑自己写一遍」，不是做一个面向真实交易的商城。**
线上跑着一份演示部署（见「项目状态」一节），但支付走的是 Stripe 测试模式、没有真实资金往来。
所以它刻意**没有用 Medusa / Saleor 这类电商框架** —— 用框架的话，SPU/SKU 拆分、
库存扣减、订单状态机这些真正值得琢磨的东西，全都会被框架替你决定完。
这里每一行都是手写的，包括那些「看起来应该由框架提供」的部分。

代码里到处都是中文注释，重点解释**为什么这么写**而不是「这行在做什么」。
下面列出的几个设计决策，注释里有更完整的推导过程。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js 16（App Router）+ React 19 | 需要 Node **≥ 22.12**（见下方说明） |
| 语言 | TypeScript | |
| 样式 | Tailwind CSS v4 + shadcn/ui | 组件由 shadcn CLI v4 生成，底层是 `@base-ui/react`，不是 Radix |
| 数据库 | PostgreSQL 17 + Prisma 7 | 通过 `@prisma/adapter-pg` driver adapter 接入 |
| 状态 | Zustand | 只用于未登录时的本地购物车 |
| 认证 | 自己签的 JWT（`jose`）+ httpOnly cookie | 没上 NextAuth，见下面说明 |
| 校验 | zod v4 | 所有外部输入（表单、URL 参数）都过一遍 |
| 提示 | sonner | |

**Node 为什么要求 ≥ 22.12**，不是 Next.js 要求的那个下限：

- `scripts/db-url.mjs` 用了 `process.loadEnvFile()`（Node 20.12 起才有）
- Playwright 加载 `playwright.config.ts` 时会把它 import 的 `.mjs` 转成 CommonJS，
  于是要走 Node 的 `require(ESM)` 支持（22.12 起默认开启，不需要 flag）

本项目在 **Node 24** 上开发和验证。

没有 Redis、没有消息队列、没有微服务。一个 Next.js 进程 + 一个 PostgreSQL 库，
所有并发问题都用数据库的条件更新解决（下面有详细说明）。

数据库连接串**不在** `schema.prisma` 里 —— Prisma 7 取消了 datasource 块中的 `url`，
改由根目录的 `prisma7.config.ts` 提供给 CLI，运行时走 driver adapter。

---

## 环境要求

| | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22.12**（开发用的是 24） | 原因见上面「技术栈」一节 |
| PostgreSQL | **17** | 本地开发必需。Windows 两种装法：`winget install PostgreSQL.PostgreSQL.17`，或者用[官方 installer](https://www.postgresql.org/download/windows/) |
| Neon | 托管库，版本随 Neon 分配 | **只有部署到线上才需要**，本地开发完全用不上。版本和本地对不上没关系 —— 迁移文件在 17/18 上都能跑 |

装 PostgreSQL 时会给 `postgres` 超级用户设一个密码，**记下来** ——
下一步要填进 `.env`。忘了的话可以用 pgAdmin 重置。

不需要 Docker：这个项目直接用本机的 PostgreSQL，靠脚本建库/删库。

---

## 快速开始

```bash
# 1. 安装依赖（postinstall 会自动跑 prisma generate）
npm install

# 2. 准备环境变量
cp .env.example .env
#   然后把 .env 里两处占位符换掉：
#   - DATABASE_URL 里的 <密码> → 你装 PostgreSQL 时设的 postgres 密码
#   - JWT_SECRET → 一个真的随机值：
#       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. 建三个数据库（已存在就跳过，可以反复跑）
npm run db:create

# 4. 建表（把 prisma/migrations 里已有的迁移应用到 shopdev）
npm run db:migrate

# 5. 灌入种子数据（3 款鞋 / 48 个 SKU / 2 个用户）
npm run db:seed

# 6. 起服务
npm run dev
```

打开 <http://localhost:3000> 会直接跳到商品列表。

想确认数据库通不通，访问 <http://localhost:3000/api/health>，
正常应该返回 `{"ok":true,"products":3,"skus":48,"users":2}`。

（线上会不一样：演示账号不种，所以 `users` 是 0 或你自己注册的个数，
商品和 SKU 仍然是 3 / 48 —— 见下面的 `SEED_DEMO_USERS`。）

> 只想一把梭重建？`npm run db:reset -- --seed` 会把 `shopdev` 删掉重建、
> 应用迁移、再灌种子 —— 代价是**里面所有数据都没了**。

### 三个数据库

本地建了**三个**独立的库，用途严格分开。它们对应以前 SQLite 时代的三个文件
（`dev.db` / `test.db` / `e2e.db`），换到 PostgreSQL 之后就是三个 database：

| 库名 | 谁在用 | 会不会被清空 |
|---|---|---|
| `shopdev` | `npm run dev` / `npm run start`，你手工点的那套数据 | 只有你主动跑 `db:reset` 才会 |
| `shoptest` | 集成测试（`npm run test:integration`） | **每轮测试前整个删掉重建** |
| `shope2e` | E2E 测试（`npm run test:e2e`） | **每次开跑前整个删掉重建 + 灌种子** |

分开的理由很直接：测试要反复清库，绝不能让它碰到你手工造的数据；
而 E2E 需要一份**确定的**种子数据，也就不能和开发库共用。

只有 `shopdev` 的连接串写在 `.env` 里。另外两个是脚本把库名换掉得到的
（`scripts/db-url.mjs` 的 `urlForDatabase`）—— 这样密码只存一处，
不会出现「三个地方各写一份、其中一处忘了改」。

> ⚠️ 建库/删库脚本只允许操作**本机**地址和**这三个**库名（白名单写在
> `scripts/db-url.mjs`）。哪天 `.env` 里不小心填了 Neon 的连接串，
> 脚本会直接拒绝执行，而不是去动生产库。

### 测试账号

**本地**的种子数据里有两个账号，密码都是固定的：

| 角色 | 邮箱 | 密码 | 能干什么 |
|---|---|---|---|
| 管理员 | `admin@shop.dev` | `admin123` | 全部功能 + `/admin` 后台 |
| 普通用户 | `user@shop.dev` | `user123` | 只能买东西 |

想验证权限隔离，就用普通用户登录后直接访问 `/admin` —— 会被拦下来。

> ⚠️ **这两个账号只在连本机库时才种**（见下面 `SEED_DEMO_USERS`）。
> 线上是**演示商品数据，账号请自行注册**：种子里只有 3 款商品 / 48 个 SKU，
> 用户表是空的，登录页上的演示账号提示也不会显示。
>
> 注册出来的账号一律是普通用户（前端传不上来 `role`，见
> [src/app/actions/auth.ts](src/app/actions/auth.ts)）。需要管理员，
> 就在数据库里把那行改掉：
>
> ```sql
> UPDATE users SET role = 'ADMIN' WHERE email = '你的邮箱';
> ```

### 环境变量

`.env.example` 是这份清单的唯一出处（每加一个变量都要回去补一行）。
下面这一列全部来自 `.env.example`：

| 变量 | 本地开发填什么 | 生产（Vercel）填什么 |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:<密码>@localhost:5432/shopdev` | Neon 的 **pooled** 连接串（见下） |
| `DIRECT_URL` | **留空**（注释掉） | Neon 的 **直连**连接串 |
| `JWT_SECRET` | 随便一个随机值 | **重新生成**一个，绝不复用本地那个 |
| `ORDER_TIMEOUT_MINUTES` | `15` | 同左。**改成 `1` 可以快速验证超时逻辑** |
| `CRON_SECRET` | 随机值 | 随机值，和本地不同 |
| `CRON_ENABLED` | `false` | 生产不用这个开关（它只管本地那个脚本） |
| `STRIPE_SECRET_KEY` | Stripe 控制台的 `sk_test_...` | 同左（还是测试密钥，项目没上 live） |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe 控制台的 `pk_test_...` | 同左 |
| `STRIPE_WEBHOOK_SECRET` | `stripe listen` 打印的 `whsec_...`（见下） | Stripe 控制台「Webhook 端点」里那一个 |
| `SEED_DEMO_USERS` | **不用配** | **不用配**（见下） |

#### 本地要真的收到支付回调，得做两件事

只跑 `stripe listen` 是**不够**的 —— 少了密钥，接口会以
`not_configured` 拒绝处理（HTTP 500），而且一个字节都不写库：

```bash
# 1) 起转发（这个终端得一直开着）
stripe listen --events payment_intent.succeeded \
  --forward-to localhost:3000/api/webhooks/stripe

# 2) 把上面打印出来的 whsec_... 填进 .env 的 STRIPE_WEBHOOK_SECRET，然后重启 dev server
```

两件都做了，付款后订单才会自己翻成「已支付」；
只用测试卡（`4242 4242 4242 4242`）付完、不配这两样，
**钱在 Stripe 那边是收到了，但订单会一直停在「待支付」**。

> ⚠️ `stripe listen` **只转发新事件**。漏掉的历史事件不会自己补上 ——
> 要补得用 `stripe events resend evt_xxx`（配上密钥之后）。
>
> ⚠️ CLI **登录的账号**必须和 `.env` 里的 `STRIPE_SECRET_KEY` 属于同一个账号。
> 否则 `stripe listen` 转发的是另一个账号的测试事件，一条都到不了这里 ——
> 界面上表现为「`stripe listen` 明明开着，webhook 却永远不触发」。
> （实在不想切账号，可以在命令后加 `--api-key` 临时指定，但那样密钥就进了
> shell 历史，不如直接 `stripe login`。）

#### `SEED_DEMO_USERS`：演示账号种不种

这个变量**默认不用配**，行为是按连接串自动判断：

| `DATABASE_URL` 指向 | 演示账号 | 为什么 |
|---|---|---|
| 本机（`localhost` / `127.0.0.1`） | 种 | 本地图的就是 clone 下来能直接登 |
| 远程（Neon 等） | **不种** | 那两个密码是写死在代码里的弱密码（`admin123`），登录页上还印着 —— 线上有它们就等于给后台留了张告示 |

所以线上**什么都不用做**，弱密码账号不会出现。想推翻这个判断才需要写它
（`true` / `false`），理由写在 `.env.example` 里。

> 【为什么用「主机名」而不是 `NODE_ENV` 判断】种子是 Prisma CLI 拉起来的，
> 没有东西保证它会传 `production`；而「线上」这件事在数据库这一侧有一个更准确的
> 表达 —— **连的不是本机**。这跟建库/删库脚本「只允许本机」是同一个思路：
> 按连接串里的事实判断，而不是按人的意图判断。
> 两份判断共用同一份主机名名单（`scripts/db-url.mjs` 的 `LOCAL_HOSTS`）。

#### `DATABASE_URL` 和 `DIRECT_URL` 为什么要分成两个

区别只在**生产**，本地开发两者是同一个库、只需要 `DATABASE_URL`。

Neon 提供两条连接串，用途不同：

- **pooled（池化）** —— 主机名里带 `-pooler`，经由 pgbouncer。
  Vercel 是 serverless，函数实例会来来回回地建连接、用完就没了，
  不用池化会很快把 Neon 的连接数打满。所以**运行时**用它，
  并且要带上 `?pgbouncer=true&connection_limit=1`。
- **direct（直连）** —— 迁移（`prisma migrate deploy`）用这条。
  迁移需要会话级的特性（比如建影子库、拿咨询锁），而池化模式下
  pgbouncer 事务池不保证同一个会话，迁移会失败。

**本地为什么不用配 `DIRECT_URL`**：本机没有池化这回事，配了只是多一处能写错的地方 ——
空着会自动退回用 `DATABASE_URL`。

实现上，Prisma 7 **取消了** `schema.prisma` 里的 `directUrl`。
这里用 `prisma7.config.ts` 读 `DIRECT_URL || DATABASE_URL` 复现同样的意图：
有直连串就走直连（迁移），没有就用 `DATABASE_URL`（本地）。

> 【为什么是 `||` 而不是 `??`】用了 `??` 的话，`.env` 里写成 `DIRECT_URL=""`
> 会选中那个**空字符串**，连接串就成了空的。`||` 才会跳到下一个候选值。

#### 另外两个只在调试时用的变量

这两个**不在** `.env.example` 里 —— 它们是可选覆盖，不设就用括号里的默认值，
只有 `scripts/cron-dev.mjs` 会读：

| 变量 | 默认 | 作用 |
|---|---|---|
| `CRON_INTERVAL_MS` | `60000` | 上面那个脚本的触发间隔 |
| `BASE_URL` | `http://localhost:3000` | 上面那个脚本要打的地址 |

---

## 目录结构

```
prisma/
  schema.prisma          数据模型（每一段都有注释解释为什么这么设计）
  migrations/            迁移历史。换库时全部重做过，没有沿用 SQLite 那一批
  seed.ts                种子数据，用 upsert 写成幂等的，可以反复跑
src/
  app/
    products/            前台：商品列表、商品详情
    cart/  checkout/     购物车、结算
    orders/              买家侧订单列表和详情
    login/  register/    登录、注册
    admin/               后台：概览、订单管理、商品管理
      layout.tsx         ← 后台权限守卫（但注意它保护不了 Server Action）
    actions/             Server Actions，按领域分成 auth/cart/order/admin/product 五个文件
    api/
      health/            健康检查
      cron/expire-orders 超时订单扫描的入口
  components/
    ui/                  shadcn 生成的原子组件
    product/ cart/ orders/ checkout/ auth/ admin/   按领域分的业务组件
  lib/
    constants.ts         订单状态机、角色、业务参数
    products.ts          商品/SKU 的查询和写入
    product-query.ts      前台商品列表 URL 参数的解析（?q= / ?category= / ?sort=）
    product-bulk.ts      ☆ 商品的批量上下架/改价/调库存（一个事务，失败整体回滚）
    orders.ts            ★ 项目核心：下单、扣库存、支付、状态流转、超时取消
    dashboard.ts         后台首页看板（全部走 groupBy / aggregate，不在 JS 里循环）
    dates.ts             「今天」的边界（自然日半开区间，全站只此一处定义）
    cart.ts              数据库购物车（已登录用户）
    cart-store.ts        Zustand 本地购物车（未登录用户）
    cart-types.ts        两种购物车共用的类型 + findStockProblems 库存校验
    form.ts              表单输入解析（元→分、多行文本→数组）
    format.ts            展示层格式化（分→元、解析 images JSON）
    auth.ts / password.ts  会话与密码
    schemas.ts          所有 zod schema（集中放，才可能被单元测试直接导入）
    prisma.ts            PrismaClient 单例（防开发时热重载耗尽连接）
tests/
  unit/                  第一层：纯函数（Vitest）
  integration/           第二层：真库 + 真并发（Vitest + Prisma）
    helpers/db.ts        造数据的小工具（makeUser / makeProduct / makeOrder…），
                         每个破坏性操作前先查 current_database() 确认是 shoptest
    global-setup.ts      整个会话跑一次：把 shoptest 删掉重建 + 应用迁移
  e2e/                   第三层：真浏览器（Playwright）
scripts/
  create-databases.mjs   建 shopdev / shoptest / shope2e（已存在就跳过）
  reset-database.mjs     删掉重建某个库 + 应用迁移（--db=xxx --seed）
  db-url.mjs             连接串工具：白名单、只允许本机、换库名（四个调用方共用）
  cron-dev.mjs           本地模拟定时任务（独立进程，默认不启动）
  test-all.mjs           npm run test 的入口：跑完三层并打汇总表
  test-e2e.mjs           E2E 的启动包装（给 Git Bash 补 PATH，见「测试」一节）
  e2e-db.mjs             E2E 专用库：删掉重建 shope2e + 灌种子数据
prisma7.config.ts        给 Prisma CLI 用的配置（连接串、迁移目录、seed 命令）
playwright.config.ts     E2E 配置（独立端口、独立库、独立构建目录）
```

---

## 数据模型

```
User ──< CartItem >── Sku ──< OrderItem >── Order ── User
                       │
                       └── Product
```

几个关键点：

- **商品是两层：`Product`（SPU）+ `Sku`。** `Product` 只描述「这是一款什么鞋」，
  没有价格也没有库存；真正被买卖、被扣库存的单位是 `Sku`（「42 码 / 曜石黑」）。
  同一款鞋下「尺码 + 颜色」有唯一约束，数据库层面就不可能存在两个 42 码黑色。
- **所有金额都是 `Int`，单位是「分」。** ¥899.00 存成 `89900`。
  不要用 `Float` 存钱 —— `0.1 + 0.2 !== 0.3`，误差会累积成对不上账。
  转「元」只发生在渲染的最后一步（`src/lib/format.ts`）。
- **`OrderItem` 存的是快照，不是引用。** 商品名、尺码、颜色、成交价都冗余存了一份。
  订单是历史凭证，必须不可变：管理员之后改价格、改名字、甚至下架商品，
  都不该让三个月前的订单显示错误信息。`skuId` 在 SKU 被物理删除后会置空，
  但 `OrderItem` 本身仍然可读。
- **`Order.expiresAt` 是存下来的字段，不是每次现算。** 超时扫描的条件是
  `WHERE status = 'PENDING_PAYMENT' AND expiresAt <= now()`，有字段才能走索引。

### 状态和数组为什么还是 `String` 和 JSON 字符串

这个项目**已经从 SQLite 迁到 PostgreSQL 17** 了，但 schema 里两处「像是老时代的遗留」
被**有意保持不变**：

- `status` / `role` 等枚举字段仍然存 `String`（靠 TypeScript 的联合类型和 zod 收窄）
- `Product.images` 仍然存 JSON 字符串，读的时候用 `parseImages()` 解析兜底

原因：这两条本来是 SQLite 不支持 `enum` 和标量数组逼出来的写法。而这次迁移的目标是
**换掉存储引擎、语义一个都不动** —— 迁移和「改用真 enum + `String[]`」是两件独立的事，
混在一起做的话，一旦测试挂了就分不清是迁移错了还是类型改了。

留着它们的**代价**是真实的：数据库层拦不住非法状态（只能在应用层收窄），
`images` 也没法用 SQL 直接查其中的元素。清理这两处是有价值的下一步
（见文末「想继续练的话」）。

---

## 核心设计决策

这几条是整个项目里最值得看的部分，每一项在源码里都有完整的推导注释。

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

## 项目状态

### 功能清单

| 模块 | 做到哪一步 |
|---|---|
| 商品 | 浏览、搜索、分类筛选、多图轮播、尺码助手（输入脚长给建议尺码） |
| 购物车 | 未登录时存本地（Zustand），登录后落到账号上 |
| 订单 | 下单 → 支付（Stripe 收银台 + webhook 回调）→ 发货 → 确认收货，每一步都过状态机白名单 |
| 退款 | 买家申请 → 管理员批准 / 驳回，批准时把库存和券都还回去 |
| 优惠券 | 满减 / 折扣 / 封顶三类；名额用 `INSERT … SELECT … WHERE` 抢占，不是「先数再插」 |
| 会员侧 | 收藏、评价、订单备注 |
| 后台 | 商品 CRUD、订单管理、退款审批、优惠券、评价管理、数据看板 |

### 测试覆盖

**650 条**，三层全绿：单元 343 / 集成 300 / E2E 7。跑法见「测试」一节，
全跑一条命令：`npm run test`。

### 已部署

Vercel（跑 Next.js）+ Neon（托管 PostgreSQL，Singapore）。地址、环境变量清单、
以及首次部署后要做的事，见「部署（Vercel + Neon）」一节。

> ⚠️ Vercel 默认域名 `*.vercel.app` 在国内**直连不稳定**，需要代理才能访问。
> 绑自定义域名可以解决，本项目没有绑。

### 已知限制（摘要）

支付走 Stripe 测试模式、没有物流单号、没有部分退款、库存一批准退款就立即回补
（生产环境应该等仓库确认收到实物）。完整清单见「已知限制」一节。

---

## 定时任务：自动取消超时订单

扫超时订单这件事有两种触发方式，两种都实现了。

### 方式一：页面懒扫描（默认就在跑）

访问 `/orders` 或 `/orders/[id]` 时，会顺手把自己名下过期的订单取消掉。
不需要任何额外进程，开发时最省事。

### 方式二：HTTP 端点 + 外部定时器

```
GET/POST /api/cron/expire-orders
头：Authorization: Bearer <CRON_SECRET>
或：?secret=<CRON_SECRET>
```

返回 `{ ok, scanned, cancelled, restoredUnits, elapsedMs }`。
`CRON_SECRET` 没配就返回 500，密钥不对返回 401。
生产环境上，用服务器 crontab、Vercel Cron、或者 k8s CronJob 定时打这个地址。

**本地想模拟**，用 `scripts/cron-dev.mjs`。先打开 `.env`，把这一行改成 `true`：

```
CRON_ENABLED="true"
```

然后**另开一个终端**（dev server 那个不要动）：

```bash
node scripts/cron-dev.mjs
```

它是个独立的 `setInterval` 循环，默认每 60 秒打一次你的 dev server，
想停就 Ctrl+C。两个可覆盖的参数：

```bash
CRON_INTERVAL_MS=5000 node scripts/cron-dev.mjs      # 改成 5 秒一次，方便调试
BASE_URL=http://localhost:3001 node scripts/cron-dev.mjs
```

默认关掉是有意的 —— 免得在你没注意的时候后台一直在改数据。

**想快速验证超时逻辑**：把 `.env` 里的 `ORDER_TIMEOUT_MINUTES` 改成 `1`，
下一单不付款，等一分钟再刷新订单页 —— 订单会变成「已取消」，库存会还回去。

---

## 测试

三层，从快到慢，各管一段。一次全跑：

```bash
npm run test           # 三层全跑，最后给一张汇总表
```

也可以单独跑某一层：

```bash
npm run test:unit          # 第一层：纯函数，毫秒级
npm run test:integration   # 第二层：真数据库，十几秒
npm run test:e2e           # 第三层：真浏览器，半分钟
```

### 第一层 · 单元测试（Vitest）

测那些**没有依赖、算错了也不会报错**的东西：金额转换、订单状态机白名单、
所有 zod schema、购物车算价、`safeNext` 的开放重定向防护。

这一层曾经写不了 —— 因为 zod schema 原本定义在 `"use server"` 文件里，
而那种文件只能导出 async 函数。为了能测，把它们挪到了
[src/lib/schemas.ts](src/lib/schemas.ts)。**能被单独导入，是纯逻辑的基本要求。**

### 第二层 · 集成测试（Vitest + Prisma）

连一个**独立的 PostgreSQL 库**（`shoptest`，每次跑前整个删掉重建，
走的是和生产同一批迁移文件），直接调 `src/lib/` 里的函数。
测的是那些「逻辑对但并发下会错」的地方：

- 状态机的每一条合法流转、四种非法流转、5 次并发发货
- 跨用户越权：拿别人的订单 id 去查/去支付，必须返回「订单不存在」
- 下单事务：库存不足整单回滚、`expiresAt` 写入、超时取消后库存还回去
- **竞争**：20 轮 `Promise.all([payOrder, cancelExpiredOrders])`，
  每轮只能有一个赢家，库存永远自洽

最后这条是整个测试套件里最有价值的一个用例 —— 它验证的是
「把判断塞进 WHERE、看受影响行数」这套写法在真实并发下真的成立。

### 第三层 · 端到端（Playwright）

只测**一条**黄金路径：注册 → 加购 → 下单 → 支付 → 管理员发货 → 确认收货。

前两层都绕开了 HTTP 和浏览器，只有这一条能回答「这些东西拼在一起，
用户真的能走通吗」。E2E 是最慢也最容易 flaky 的一层，
所以**刻意不做全量覆盖** —— 堆用例的边际收益很低。

它用独立的库（`shope2e`）和独立的构建目录（`.next-e2e`），
所以可以和你正在跑的 `npm run dev` 同时存在，互不干扰。

> ⚠️ 入口是 `npm run test:e2e`，它走 `scripts/test-e2e.mjs`。
> 那一层只做一件事：给 Git Bash 补上 `C:\Windows\System32`，
> 好让 Playwright 结束时能真的杀掉自己起的 dev server。
> 直接跑 `npx playwright test` 在 Git Bash 里会挂住 —— 原因写在那个文件里。

---

## 常用命令

```bash
# ---- 开发 ----
npm run dev            # 开发服务器（http://localhost:3000）
npm run build          # 生产构建（也会跑一遍类型检查）
npm run start          # 起刚构建好的产物（要先 npm run build）
npm run lint           # ESLint
npx tsc --noEmit       # 只做类型检查，比 build 快

# ---- 测试 ----
npm run test              # 三层全跑 + 汇总表（约 1.5 分钟）
npm run test:unit         # 第一层：纯函数，毫秒级
npm run test:integration  # 第二层：真库 + 真并发，二十几秒
npm run test:e2e          # 第三层：真浏览器，一分多钟

# ---- 数据库 ----
npm run db:create      # 建 shopdev / shoptest / shope2e（已存在就跳过，幂等）
npm run db:migrate     # 改完 schema.prisma 后建迁移，并把 shopdev 更新到最新
npm run db:seed        # 灌种子数据（幂等，可以反复跑）
npm run db:studio      # 图形化看数据库，调试时很好用
npm run db:generate    # schema 改完后重新生成 Prisma Client
npm run db:reset       # 删掉重建数据库 + 应用迁移 ← 会删掉所有数据
npm run db:reset -- --seed        # 上面那条 + 顺带灌种子
npm run db:reset -- --db=shoptest # 换成操作指定的库
```

> ⚠️ `db:reset` **不灌种子**（默认），而且会先 `DROP DATABASE`。
> 它和建库脚本共用同一份白名单和「只允许本机」校验，
> 库名写错或指向远程会被直接拒绝。

---

## 部署（Vercel + Neon）

线上是 **Vercel 跑 Next.js + Neon 托管 PostgreSQL**。两边都免费。

### 当前部署

| | |
|---|---|
| 代码仓库 | <https://github.com/Qhaiyang/shose-shop> |
| 生产数据库 | Neon 托管 PostgreSQL，**Singapore**（`ap-southeast-1`） |
| 线上地址 | <https://shose-shop-beta.vercel.app> |
| Build Command | `prisma migrate deploy && next build` |

> ⚠️ **打不开线上地址是正常的** —— Vercel 默认域名 `*.vercel.app` 在国内直连不稳定，
> 需要代理。绑一个自定义域名可以解决，本项目没有绑。

生产环境变量一共 **5 个**，下面只列名字和用途 —— **实际值只存在 Vercel 里，不在仓库里**：

| 变量名 | 用途 |
|---|---|
| `DATABASE_URL` | 运行时连库。Neon 的**池化**串（主机名带 `-pooler`） |
| `DIRECT_URL` | `prisma migrate deploy` 连库。Neon 的**直连**串 |
| `JWT_SECRET` | 签发 / 校验登录 JWT 的密钥 |
| `CRON_SECRET` | `/api/cron/expire-orders` 的 Bearer 令牌 |
| `ORDER_TIMEOUT_MINUTES` | 订单超时自动取消的分钟数 |

**线上数据**：商品和 SKU 照种（3 款 / 48 个），优惠券也种（3 张），
但**用户表是空的** —— 演示账号只在连本机库时才种（见「`SEED_DEMO_USERS`」一节）。
所以线上第一个管理员要**自己注册、再手工提权**：

```sql
-- 在 Neon 控制台的 SQL Editor 里执行
UPDATE users SET role = 'ADMIN' WHERE email = '你的邮箱';
```

下面的步骤，是从零重建一份同样部署的完整流程。

> 🔑 **下面所有连接串里的密码都用 `<你的密码>` 占位。** 真实串只往 Vercel 的环境变量里填，
> **不要写进仓库里任何文件** —— `.env` 已经被 `.gitignore` 忽略，但 `.env.example` 和
> 本文档都会提交。

### 第 1 步：Neon 建库，拿两条连接串

1. <https://neon.tech> → GitHub 登录 → 免费版 → Create project
   （Region 选离你近的，比如 `ap-southeast-1`）
2. 进 **Connection Details**，**先打开 Connection pooling 开关**
3. **两条串都要，区别只在主机名里有没有 `-pooler`**：

| 给谁 | 主机名结构 | 用途 |
|---|---|---|
| `DATABASE_URL` | `ep-xxxx-pooler.<region>.aws.neon.tech` ← 有 **`-pooler`** | 运行时（Vercel 上的 serverless 函数） |
| `DIRECT_URL` | `ep-xxxx.<region>.aws.neon.tech` ← **没有** `-pooler` | 迁移（`prisma migrate deploy`） |

为什么必须分开，见上面「`DATABASE_URL` 和 `DIRECT_URL` 为什么要分成两个」。

拿到的是这个形状（**从 Neon 复制，别手打**）：

```
# pooled（池化）—— 前半段是 Neon 给的，后面两个参数要自己补
postgresql://<用户>:<你的密码>@ep-xxxx-pooler.<region>.aws.neon.tech/neondb
  ?sslmode=require&channel_binding=require          ← Neon 给的
  &pgbouncer=true&connection_limit=1                ← 自己补：告诉 Prisma 后端是池化，且每个实例只占一条连接

# direct（直连）
postgresql://<用户>:<你的密码>@ep-xxxx.<region>.aws.neon.tech/neondb
  ?sslmode=require&channel_binding=require
```

> ⚠️ 最容易搞反的一步：把 `-pooler` 那条填给了 `DIRECT_URL`。
> 症状是 `prisma migrate deploy` 报**影子库/咨询锁相关的错**。
> 拿不准就核对主机名 —— 迁移那条必须**不带** `-pooler`。

### 第 2 步：Vercel 关联仓库

<https://vercel.com> → GitHub 登录 → Add New… → Project → 选这个仓库。
Framework 会自动认成 Next.js，**不用改**。

### 第 3 步：改 Build Command

默认是 `next build`，改成：

```
npx prisma migrate deploy && next build
```

Neon 上的库一开始是**空的**（一张表都没有），必须先建表再构建。
`prisma generate` 不用加 —— `postinstall` 已经跑了。

> `migrate deploy`（而不是 `migrate dev`）是给生产用的那条：它**不交互**，
> 只把 `prisma/migrations/` 里已提交的迁移按顺序应用，不会去改迁移文件。

### 第 4 步：填环境变量

Vercel 项目的 Settings → Environment Variables（**Production** 环境）：

| 变量 | 值 |
|---|---|
| `DATABASE_URL` | 第 1 步的 **pooled** 串（带 `-pooler` 那条，含 `&pgbouncer=true&connection_limit=1`） |
| `DIRECT_URL` | 第 1 步的 **direct** 串 |
| `JWT_SECRET` | **新生成的随机值**，绝不复用本地那个 |
| `CRON_SECRET` | 也新生成一个 |
| `ORDER_TIMEOUT_MINUTES` | `15` |

生成随机值（跑两次，两个变量各用一个）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **`CRON_ENABLED` 不用填** —— 那个开关只管本地那个模拟脚本。
> **`SEED_DEMO_USERS` 也不用填** —— 线上连的不是本机，演示账号会自动跳过（见下）。

### 第 5 步：部署，然后灌演示商品数据（可选）

点 Deploy。构建期间 `prisma migrate deploy` 会把 12 张表建出来。

想要线上有商品可看，就在**本地**跑一次种子（**一次性运维动作走直连最省事**）：

```bash
DATABASE_URL="<Neon direct 串>" DIRECT_URL="<Neon direct 串>" npx prisma db seed
```

线上只会得到 **3 款商品 / 48 个 SKU / 3 张券，用户表是空的** ——
演示账号（`admin123` 那种）只在连本机库时才种，这条判断按主机名自动生效，
不需要额外配置。所以线上是**演示商品数据，账号请自行注册**。

> ⚠️ **不要把 Neon 串填进本地的 `.env`**。填了的话 `npm run dev` 就在改生产库。
> 万一填错了也不用慌：`db:create` / `db:reset` 有「只允许本机」的校验，会直接拒绝执行。

### 第 6 步：注册第一个管理员

站点上正常注册（注册出来一律是普通用户），然后在 **Neon 控制台的 SQL Editor** 里提权：

```sql
UPDATE users SET role = 'ADMIN' WHERE email = '你的邮箱';
```

### 验收清单

1. 公网 URL 能打开，`/products` 有 3 款鞋
2. `/api/health` 返回 `{"ok":true,"products":3,"skus":48,"users":0}`（用户数按你注册的个数）
3. 用提权后的账号能进 `/admin`，看板四张卡片有数字
4. 黄金路径走一遍：加购 → 下单 → 支付 → 发货 → 确认收货
5. **本地 `npm run test` 仍然 3/3** —— 部署不该影响本地。
   如果挂了，说明有东西被改成依赖线上环境了，那是要查的问题，不是「改断言让它过」

### 构建日志里可能出现的一条警告

```
SECURITY WARNING: The SSL modes 'prefer', 'require' and 'verify-ca'
are treated as aliases for 'verify-full'
```

来自 `pg-connection-string`，**不影响功能**（`sslmode=require` 当前按 `verify-full` 处理，
对 Neon 来说是更严格的校验）。它在 pg v9 才会改变语义，本项目锁定在 `pg ^8`。
想眼不见为净可以显式写 `sslmode=verify-full`，但没必要。

---

## 已知限制

这是个学习项目，下面这些是**故意**没做的，不是漏了：

- **支付接了 Stripe（PaymentIntent + webhook），但只有这一条链路。** 卡号由 Stripe
  的收银台收、我们只拿 clientSecret；订单翻「已支付」主要靠 webhook 验签后的回调
  （外加用户点「去支付」时那次补算，见下）。
  缺的是：退款没接 Stripe 退款 API（仍走手写审批）、**没有定时对账**
  （唯一的对账入口是用户再点一次「去支付」时顺手补的那一刀，见
  `src/lib/stripe-payment.ts`）、没有 3D Secure 之外的支付方式验证、
  `stripe listen` 之外没有 webhook 重放/监控。
  **结算货币是 USD，人民币按汇率换算后结算**（test mode 无实际影响，live 涉及汇率损益）。
- **退款是「管理员审批 + 改状态」，没有真的退钱。** 买家提交退款单，管理员批准或驳回；
  批准时订单进 `REFUNDED`、库存还回去、用的券也退给买家。
  但对接到支付网关的退款接口是没有的 —— 退款金额只是记在 `refund_requests.refundAmount` 上，
  也没有部分退款、没有退款流水。
- **发货没有物流单号。** `shipOrderAction` 只是把订单从 `PAID` 推到 `SHIPPED`，
  没有快递公司、运单号，也没有轨迹查询 —— 那些都要和快递平台对接，是另一个话题。
  所以「确认收货」是靠买家自己点，不是靠签收回调。
- **库存回滚的时机是简化的。** 一批准退款就入库，等于假设每双退回来的鞋都是完好的。
  真实系统要等仓库确认收到实物，而且要区分「可再售」和「待质检」
  （这条写在 `approveRefund` 的注释里）。
- **没有运费、没有税费。** 优惠券是有的（`coupons` / `user_coupons` 两张表，
  结算页能选券，订单上有 `discountAmount`），但金额构成只有
  「商品小计 − 优惠」两项，没有任何按地址、重量、地区算钱的逻辑。
- **图片是手填路径，不是上传。** 后台用「一行一个路径」的文本框编辑，
  图片文件直接放 `public/shoes/`。真做上传要处理存储、大小限制、类型校验、
  孤儿文件清理，是另一个话题。
- **搜索和分类筛选很基础。** 没有全文检索、没有分面筛选。
  换成 PostgreSQL 之后这些**技术上已经可行了**（`tsvector` / `pg_trgm` 直接就能用），
  只是还没做。
- **没有订单的超时兜底重试。** 定时任务失败就是失败了，下次扫描会补上（因为是幂等的），
  但没有告警。
- **部署形态是单实例。** 这已经不是 SQLite 时代的硬约束了（PostgreSQL 支持多实例并发写），
  但这个项目还没处理横向扩展随之而来的问题：超时扫描在多实例上会重复跑、
  内存里的并发假设也建立在「只有一个进程」之上。
  真要扩，得先给定时任务加分布式锁或租约。
- **「支付成功 → 确认中 → 轮询 → 徽章变已支付」这段前端逻辑没有自动化测试。**
  `stripe-checkout.spec.ts` 只到「弹层打开」为止；这一段要靠
  `stripe listen` + 测试卡（`4242 4242 4242 4242`）手动验。

### 想继续练的话，几个方向

**先说哪几件已经不在这个清单里了** —— 它们**做完了**，所以不再算「方向」：

- ✅ 从 SQLite 换到 PostgreSQL（迁移文件、driver adapter、建库/删库脚本都就位）
- ✅ 退款流程（申请 → 审批 / 驳回，连库存和优惠券的回补一起）
- ✅ 部署上线（Vercel + Neon，见「部署（Vercel + Neon）」一节）
- ✅ 接真实支付：Stripe PaymentIntent + 收银台 + webhook 验签回调
  （缺口见「已知限制」里支付那一条）

剩下的方向：

1. **把 `String` 状态换成真正的 `enum`、`images` 换成 `String[]`。**
   换库这一步已经做完了（见上文「状态和数组为什么还是 `String`」），
   而这两处是那次**故意没动**的 —— 现在可以单独做一轮，
   顺便把「金额用分」的约束写进 check 约束里
2. **给退款补上流水**：退款单、金额、审批都有了，缺的是
   「谁在什么时候退了多少钱」的账，以及部分退款
3. **加库存流水表**：现在库存变化只有一个最终值，出了问题查不出「谁在什么时候动了它」
4. **给下单接口加幂等键**：现在防重复提交靠前端按钮 `disabled`，
   认真的做法是客户端生成一个幂等键，服务端用它去重
5. **把 E2E 铺开**：现在只覆盖了一条黄金路径。超时取消、库存不足、
   越权访问这些分支在集成测试里测过了，但「在真实浏览器里长什么样」
   还没验证过
6. **让超时扫描能在多实例下跑**：现在是「页面懒扫描 + 一个 HTTP 端点」，
   单实例够用，多实例会重复执行（虽然幂等，但白干活）。
   要扩就得加分布式锁或租约
