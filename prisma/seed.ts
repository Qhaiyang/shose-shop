import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"

import { isLocalDatabaseUrl } from "../scripts/db-url.mjs"
import { PrismaClient } from "../src/generated/prisma/client"

// ============================================================================
// 种子数据
//
// 【设计原则】整个脚本是「幂等」的 —— 反复执行结果一样，不会产生重复数据。
// 靠的是 upsert 而不是 create：
//   - Product / Sku 用固定 id（如 "prod_running"）当锚点
//   - User 用唯一的 email 当锚点
// 所以你可以随时 `npm run db:seed` 重跑，用来把被改乱的数据恢复回来。
//
// 【跑法】npm run db:seed
//
// 【这里为什么自己 new 一个 PrismaClient，不用 src/lib/prisma.ts 那个】
// 因为那个模块用了 "@/..." 路径别名，而这是被 tsx 直接执行的独立脚本，
// 走的不是 Next 的模块解析。所以 adapter 的构造在三个地方各有一份
// （这里、src/lib/prisma.ts、测试若需要）。改连接方式时三处都要动 ——
// 这是路径别名带来的代价，记在 README 的架构决策里。
// ============================================================================

const url = process.env.DATABASE_URL

if (!url) {
  throw new Error(
    "DATABASE_URL 没有配置。本地请检查 .env（可从 .env.example 复制）。",
  )
}

const adapter = new PrismaPg({ connectionString: url })
const prisma = new PrismaClient({ adapter })

// 这一次要不要种演示账号。判断依据和理由见下面的 shouldSeedDemoAccounts
const withDemoAccounts = shouldSeedDemoAccounts(url)

// ---------------------------------------------------------------------------
// 价格工具：元 → 分
// 写种子数据时用元更直观，存进去必须是分
// ---------------------------------------------------------------------------
const yuan = (n: number) => Math.round(n * 100)

// ---------------------------------------------------------------------------
// 时间工具：相对「今天」算日期
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 【为什么时间是「相对今天算」而不是写死一个日期】
 * 后台首页有「今日订单数 / 今日销售额」两张卡片，写死一个过去的日期
 * 虽然也能保证不是今天，但过一阵子回头看这份种子数据会很难读。
 * 用「5 天前」这种相对时间，任何时候跑出来都落在过去、且都不是今天。
 */
const daysAgo = (days: number, hour: number) => {
  const date = new Date(Date.now() - days * DAY_MS)
  date.setHours(hour, 0, 0, 0)
  return date
}

// ---------------------------------------------------------------------------
// 演示账号要不要种
// ---------------------------------------------------------------------------
/**
 * 演示账号（`admin@shop.dev` / `user@shop.dev`）只在**本机库**上创建。
 *
 * 【为什么必须区别对待】
 * 这两个账号的密码是写死在代码里的弱密码（`admin123` / `user123`），
 * 而且登录页上就印着它们。本地无所谓 —— 反正是给自己练手用的；
 * 但部署到线上之后，任何人打开 `/login` 就能照着提示进后台改数据。
 * 所以线上只种商品和 SKU，账号由部署的人自己注册。
 *
 * 【为什么用「主机名」判断，而不是读 NODE_ENV】
 * `NODE_ENV` 在这个场景下不可靠：种子是 Prisma CLI 通过 tsx 拉起来的，
 * 没有任何东西保证它会传 `production`。而「线上」这件事在数据库这一侧
 * 有一个更准确的表达 —— **连的不是本机**。
 *
 * 这条判断和 `scripts/db-url.mjs` 里「建库/删库只允许本机」那道防线
 * 是同一个思路：**按连接串里的事实判断，而不是按人的意图判断**。
 * 主机名名单也只有那一份（`LOCAL_HOSTS`），不在这里抄第二遍。
 *
 * 【SEED_DEMO_USERS 可以强行覆盖】
 * 设成 "true" / "false" 就以它为准，给 CI 或别的场景留个口子。
 */
function shouldSeedDemoAccounts(databaseUrl: string): boolean {
  const override = process.env.SEED_DEMO_USERS

  if (override === "true") return true
  if (override === "false") return false

  return isLocalDatabaseUrl(databaseUrl)
}

// ---------------------------------------------------------------------------
// 商品定义
// ---------------------------------------------------------------------------
type ProductSeed = {
  id: string
  name: string
  description: string
  category: string
  /** 基准价（元），各尺码可以在此基础上微调 */
  basePrice: number
  colors: { name: string; code: string }[]
  sizes: string[]
}

const PRODUCTS: ProductSeed[] = [
  {
    id: "prod_running",
    name: "「疾风」轻量缓震跑鞋",
    description:
      "单只仅重 218g，全掌回弹中底，适合日常 5-10 公里慢跑。鞋面采用一体织工艺，透气不闷脚。",
    category: "跑步鞋",
    basePrice: 899,
    colors: [
      { name: "曜石黑", code: "BLK" },
      { name: "云雾白", code: "WHT" },
      { name: "荧光绿", code: "GRN" },
    ],
    sizes: ["39", "40", "41", "42", "43", "44"],
  },
  {
    id: "prod_basketball",
    name: "「灌篮」高帮实战篮球鞋",
    description:
      "高帮包裹护踝，中底内置抗扭转片，外底人字纹抓地。为急停变向而生。",
    category: "篮球鞋",
    basePrice: 1299,
    colors: [
      { name: "黑金", code: "BGD" },
      { name: "红白", code: "RWH" },
    ],
    sizes: ["40", "41", "42", "43", "44", "45"],
  },
  {
    id: "prod_canvas",
    name: "「帆行」经典硫化帆布鞋",
    description:
      "厚实帆布鞋面配硫化橡胶底，越穿越有味道。百搭基础款，男女同款。",
    category: "休闲鞋",
    basePrice: 399,
    colors: [
      { name: "藏青", code: "NVY" },
      { name: "米白", code: "CRM" },
      { name: "酒红", code: "WIN" },
    ],
    sizes: ["35", "36", "37", "38", "39", "40"],
  },
]

// ---------------------------------------------------------------------------
// 尺码 → 标准脚长（cm）
//
// 常见国标鞋码对照。每个尺码覆盖以标称脚长为中心、±0.25 的半开区间
// [标称-0.25, 标称+0.25)：42 码（26.0）对应 [25.75, 26.25)。
// 边界 26.25 恰好落进下一码 42.5，不会两码都命中 —— 详情页的
// suggestSize() 用的就是这套半开区间口径。
// ---------------------------------------------------------------------------
const SIZE_TO_FOOT_LENGTH: Record<string, number> = {
  "35": 22.5,
  "36": 23.0,
  "37": 23.5,
  "38": 24.0,
  "39": 24.5,
  "40": 25.0,
  "41": 25.5,
  "42": 26.0,
  "43": 26.5,
  "44": 27.0,
  "45": 27.5,
}

// ---------------------------------------------------------------------------
// 库存生成：让数据看起来真实一点
//
// 用「尺码到中间码的距离」+「颜色序号」算出一个确定的库存，不引入随机数 ——
// 随机数会导致每次重跑数据都不一样，不好复现问题。
//
// 两个维度叠加出真实电商常见的「断码」现象：
//   1. 尺码维度：越靠近黄金码（中间码）库存越多，极端码进得少、卖完就断货
//   2. 颜色维度：不同颜色卖速不同，所以「同一个尺码」在 A 颜色还有货、
//      在 B 颜色却卖光了。每个颜色断一个不同的码，越热门的颜色断越中间的码。
// 这样前端 SKU 选择器里「换颜色后原尺码不可买、自动清空」的逻辑
// 就能在日常使用中自然触发，而不是非要手动改数据库才看得到。
// ---------------------------------------------------------------------------
function stockFor(sizeIndex: number, colorIndex: number, sizeCount: number) {
  const middle = Math.floor(sizeCount / 2)
  const distanceFromMiddle = Math.abs(sizeIndex - middle)

  // 基础库存曲线
  let stock: number
  if (distanceFromMiddle === 0) stock = 12 // 黄金码
  else if (distanceFromMiddle === 1) stock = 8 // 次热码
  else if (distanceFromMiddle === 2) stock = 4 // 偏码
  else stock = 0 // 极端码

  // 断码：colorIndex 越大的颜色断越中间的码（卖得越快越容易断码）。
  // 例如 6 个尺码时：颜色0 断 41 码、颜色1 断 42 码、颜色2 断 43 码。
  const brokenSize = (middle + colorIndex - 1 + sizeCount) % sizeCount
  if (sizeIndex === brokenSize) stock = 0

  return stock
}

// ---------------------------------------------------------------------------
// 演示账号 + 挂在演示账号名下的那笔订单
//
// 这两块被单独拆成函数，是因为它们**只在本地库执行**（见上面的
// shouldSeedDemoAccounts）。放在 main 里的话，那两段会长在一堆
// 「永远要执行」的种子里，一眼看不出哪部分是线上的库不该有的。
// ---------------------------------------------------------------------------
async function seedDemoAccounts() {
  // 密码用 bcrypt 哈希，cost factor 10（默认）。绝不能在数据库里放明文。
  //
  // 【这两个密码为什么是弱的、而且写在代码里】
  // 因为它们是本地演示账号，登录页上就印着，图的就是 clone 下来能直接登。
  // 代价是**绝不能出现在线上** —— 这道防线由 shouldSeedDemoAccounts 把守。
  const adminPassword = await bcrypt.hash("admin123", 10)
  const userPassword = await bcrypt.hash("user123", 10)

  const admin = await prisma.user.upsert({
    where: { email: "admin@shop.dev" },
    update: {},
    create: {
      email: "admin@shop.dev",
      password: adminPassword,
      name: "管理员",
      role: "ADMIN",
    },
  })

  const user = await prisma.user.upsert({
    where: { email: "user@shop.dev" },
    update: {},
    create: {
      email: "user@shop.dev",
      password: userPassword,
      name: "张小明",
      role: "USER",
    },
  })

  console.log(`👤 用户：${admin.email}（ADMIN）`)
  console.log(`👤 用户：${user.email}（USER）\n`)

  return { admin, user }
}

/**
 * 种一笔「已完成」的演示订单，挂在指定的用户名下。
 *
 * 【为什么种子数据里要有一张已完成的订单】
 * 「去评价」的入口只在已完成的订单上出现，而把一张订单从下单推到完成
 * 要经过支付、发货、确认收货三步 —— 手工点一遍得开两个浏览器身份、
 * 来回切三次页面。种一笔现成的，登录 user@shop.dev 打开订单就能看到
 * 评价按钮；E2E 也不用为了测评价把整条黄金路径再走一遍。
 */
async function seedDemoOrder(userId: string) {
  const DEMO_ORDER_NO = "SO-DEMO-0001"

  // 两个订单项用两款不同的商品，好在页面上看出「去评价」是**按件**出现的
  const demoLines = [
    { skuCode: "RUN-42-BLK", quantity: 1 },
    { skuCode: "CAN-38-NVY", quantity: 2 },
  ]

  const demoSkus = await prisma.sku.findMany({
    where: { skuCode: { in: demoLines.map((line) => line.skuCode) } },
    select: {
      id: true,
      skuCode: true,
      size: true,
      color: true,
      price: true,
      product: { select: { name: true } },
    },
  })

  // 少一个 SKU 就说明上面的商品循环没跑完。与其种出一张缺件的订单，
  // 不如直接报错 —— 种子里出现「看起来正常但是错的」数据最难查
  if (demoSkus.length !== demoLines.length) {
    throw new Error(
      `演示订单需要的 SKU 没找齐（期望 ${demoLines.length} 个，找到 ${demoSkus.length} 个）`,
    )
  }

  const placedAt = daysAgo(5, 10)
  const totalAmount = demoLines.reduce((sum, line) => {
    const sku = demoSkus.find((s) => s.skuCode === line.skuCode)!
    return sum + sku.price * line.quantity
  }, 0)

  // 【为什么这里用「先删再建」而不是 upsert】
  // 订单项挂在订单下面，upsert 的 update 分支要对这个关联做「先清空再重建」，
  // 写出来比直接重建还长。删除 + 创建同样满足幂等要求：反复执行的结果
  // 完全一样，而且没有任何地方依赖一个固定的订单 id（对外的锚点是 orderNo，
  // 它保持固定）。
  //
  // 副作用要说明白：重跑种子会把这笔演示订单上**已有的评价一起删掉**
  // （订单项被级联删除，评价跟着走）。这是演示数据，可以接受。
  await prisma.order.deleteMany({ where: { orderNo: DEMO_ORDER_NO } })

  await prisma.order.create({
    data: {
      orderNo: DEMO_ORDER_NO,
      userId,
      status: "COMPLETED",
      totalAmount,
      address: "上海市徐汇区演示路 88 号 3 号楼 502",
      phone: "13800138000",
      // 种子里给一笔带备注的订单，好让「备注」这块一打开就有东西看。
      // 这单是已完成的，所以它在详情页上是**只读**的 ——
      // 顺带把「发货后不能改」这件事直接摆在眼前，不用自己先去下单一笔
      note: "请工作日送达，放门口快递柜就行",
      createdAt: placedAt,
      expiresAt: new Date(placedAt.getTime() + 15 * 60 * 1000),
      paidAt: new Date(placedAt.getTime() + 2 * 60 * 1000),
      shippedAt: daysAgo(4, 14),
      completedAt: daysAgo(2, 19),
      items: {
        create: demoLines.map((line) => {
          const sku = demoSkus.find((s) => s.skuCode === line.skuCode)!
          // 和真实下单一样存快照（见 prisma/schema.prisma 里 OrderItem 的注释）
          return {
            skuId: sku.id,
            productName: sku.product.name,
            size: sku.size,
            color: sku.color,
            price: sku.price,
            quantity: line.quantity,
            skuCode: sku.skuCode,
          }
        }),
      },
    },
  })

  console.log(`📦 演示订单：${DEMO_ORDER_NO}（已完成，可直接去评价）\n`)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log("🌱 开始写入种子数据...\n")

  // ---- 1. 演示账号 ----
  //
  // 【只有本机库才种】判断依据见 shouldSeedDemoAccounts
  // 返回 null = 这次跳过了。后面那笔演示订单挂在演示用户名下，
  // 所以要用这个值决定还要不要接着种（见 2c）。
  const demo = withDemoAccounts ? await seedDemoAccounts() : null

  // ---- 2. 商品 + SKU ----
  for (const p of PRODUCTS) {
    const images = JSON.stringify([
      `/shoes/${p.id}-1.svg`,
      `/shoes/${p.id}-2.svg`,
      `/shoes/${p.id}-3.svg`,
    ])

    const product = await prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        description: p.description,
        category: p.category,
        images,
      },
      create: {
        id: p.id,
        name: p.name,
        description: p.description,
        category: p.category,
        images,
      },
    })

    let skuCount = 0

    for (const [colorIndex, color] of p.colors.entries()) {
      for (const [sizeIndex, size] of p.sizes.entries()) {
        // 尺码越大价格略高（真实鞋类常见做法），每大一码加 0~20 元
        const sizeSurcharge = Math.floor(sizeIndex / 2) * 10
        const price = yuan(p.basePrice + sizeSurcharge)

        // skuCode 是可读货号，方便人工对账：RUN-42-BLK
        const skuCode = `${p.id.replace("prod_", "").toUpperCase().slice(0, 3)}-${size}-${color.code}`

        const stock = stockFor(sizeIndex, colorIndex, p.sizes.length)

        await prisma.sku.upsert({
          where: { skuCode },
          update: {
            size,
            color: color.name,
            price,
            stock,
            productId: product.id,
          },
          create: {
            skuCode,
            size,
            color: color.name,
            price,
            stock,
            productId: product.id,
          },
        })

        skuCount++
      }
    }

    console.log(
      `👟 ${product.name}（${product.category}）→ ${p.colors.length} 色 × ${p.sizes.length} 码 = ${skuCount} 个 SKU`,
    )
  }

  // ---- 2b. 尺码建议映射 ----
  // 每个「分类 × 尺码」一行：同一尺码在不同分类下的脚长区间相同
  // （42 码永远是 26.0），所以这里直接用全局的尺码对照表，
  // 按分类各建一份，供详情页的尺码助手按分类查。
  let sizeGuideCount = 0
  for (const p of PRODUCTS) {
    for (const size of p.sizes) {
      const footLength = SIZE_TO_FOOT_LENGTH[size]
      // 表里没有这个尺码的对照就跳过，别把「脚长 0」这种脏数据写进去
      if (footLength === undefined) continue

      await prisma.sizeGuide.upsert({
        where: {
          category_suggestedSize: {
            category: p.category,
            suggestedSize: size,
          },
        },
        update: {
          footLengthMin: footLength - 0.25,
          footLengthMax: footLength + 0.25,
        },
        create: {
          category: p.category,
          suggestedSize: size,
          footLengthMin: footLength - 0.25,
          footLengthMax: footLength + 0.25,
        },
      })
      sizeGuideCount++
    }
  }
  console.log(`📏 尺码建议映射：${sizeGuideCount} 条\n`)

  // ---- 2c. 一笔「已完成」的演示订单 ----
  //
  // 【没有演示账号就整段跳过】
  // 订单必须挂在某个用户名下（`orders.userId` 是 NOT NULL 外键），
  // 而演示账号只在本地库才种 —— 线上跳过这一整段。
  if (demo) {
    await seedDemoOrder(demo.user.id)
  }

  // ---- 2d. 优惠券 ----
  //
  // 【为什么这三张券是挑着给的】
  // 三种典型的券，各自能演示一类行为：
  //   SAVE100 —— 有门槛的满减券：金额不够时结算页里根本不出现（门槛过滤）
  //   NINE50  —— 有封顶的折扣券：买贵鞋按封顶减，买便宜鞋按比例减
  //   OLD20   —— 已停用：前台看不到，后台列表里能演示「停用」状态
  //
  // 【有效期为什么用相对时间】
  // 和演示订单同一个理由（见上面 daysAgo 的注释）：写死日期的话，
  // 过一阵子这份种子数据就全过期了，前台一张券都领不到，
  // 看起来像功能坏了。相对时间保证任何时候跑完都是「正在进行中」。
  //
  // 【为什么用 upsert 而不是先删再建】
  // 券码是唯一的，可以当锚点。而且「删券」会级联影响 user_coupons
  // （谁领过这张券的记录没了）和历史订单的 couponId（被置空）——
  // 演示数据不值得制造这种副作用，upsert 改回正确配置就够。
  const couponStart = daysAgo(30, 0)
  const couponEnd = new Date(Date.now() + 60 * DAY_MS)
  couponEnd.setHours(23, 59, 59, 999)

  const COUPONS = [
    {
      code: "SAVE100",
      type: "FIXED",
      // 满减券的 value 是「减多少钱」（分）
      value: yuan(100),
      minSpend: yuan(800),
      maxDiscount: null,
      totalLimit: 100,
      perUserLimit: 1,
      isActive: true,
    },
    {
      code: "NINE50",
      type: "PERCENT",
      // 折扣券的 value 是「减掉的百分点」：10 = 9 折。
      // 注意不是 90 —— 全站对 PERCENT 的读法只有这一种
      value: 10,
      minSpend: 0,
      maxDiscount: yuan(50),
      totalLimit: 50,
      perUserLimit: 1,
      isActive: true,
    },
    {
      code: "OLD20",
      type: "FIXED",
      value: yuan(20),
      minSpend: 0,
      maxDiscount: null,
      totalLimit: 10,
      perUserLimit: 1,
      isActive: false,
    },
  ] as const

  for (const coupon of COUPONS) {
    const data = {
      ...coupon,
      startAt: couponStart,
      endAt: couponEnd,
    }
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: data,
      create: data,
    })
  }

  console.log(`🎟️  演示优惠券：${COUPONS.map((c) => c.code).join(" / ")}\n`)

  // ---- 3. 汇总 ----
  const [productCount, skuCount, userCount, couponCount] = await Promise.all([
    prisma.product.count(),
    prisma.sku.count(),
    prisma.user.count(),
    prisma.coupon.count(),
  ])

  console.log(
    `\n✅ 完成：${productCount} 款商品 / ${skuCount} 个 SKU / ${userCount} 个用户 / ${couponCount} 张券`,
  )

  // 跳过了演示账号就说明白，否则线上种完看到 userCount=0 会以为是出错了
  // —— 而这恰恰是设计成这样的。
  //
  // 这里**不写跳过的原因**：判断有两条路（主机名 / SEED_DEMO_USERS 覆盖），
  // 写死一条的话另一条就成了假话。只陈述「这次没种」，原因在上面的函数里。
  if (withDemoAccounts) {
    console.log("\n测试账号（本机演示用）：")
    console.log("  管理员  admin@shop.dev / admin123")
    console.log("  普通用户 user@shop.dev  / user123")
  } else {
    console.log("\n（这次没有种演示账号）")
    console.log("  只种了商品和 SKU。账号请自行注册 —— 注意注册一律是普通用户，")
    console.log("  需要管理员的话，在数据库里把那个账号提权：")
    console.log("    UPDATE users SET role = 'ADMIN' WHERE email = '你的邮箱';")
  }

  console.log("\n试着领一张券：")
  console.log("  商品详情页或购物车页底下有「可以领的优惠券」，点「领取」")
  console.log("  然后去 /my-coupons 看，下单时在结算页选一张就能看到实付变少")
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (e) => {
    console.error("❌ 种子数据写入失败：", e)
    await prisma.$disconnect()
    process.exit(1)
  })
