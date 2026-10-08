import { Prisma } from "@/generated/prisma/client"
import { LOW_STOCK_THRESHOLD } from "@/lib/constants"
import { prisma } from "@/lib/prisma"
import { parseImages } from "@/lib/format"
import { PRODUCT_LIST_SELECT, toProductListItem } from "@/lib/product-list"
import type { ProductSort } from "@/lib/product-query"

// ============================================================================
// 商品查询（Server 端）
//
// 这些函数只在 Server Component 里调用，直接查数据库，不经过 API 路由。
// 好处是没有一层多余的 HTTP 往返，也不用手写 JSON 序列化和类型定义。
//
// 【原则】查询函数只负责「取数据 + 算派生字段」，不做任何 React 相关的事。
// 这样以后想在 Server Action 或定时任务里复用也很方便。
// ============================================================================

// ---------------------------------------------------------------------------
// 类型定义
// 显式写出来（而不是用 Prisma 推导的复杂类型）有两个好处：
//   1. 传给 Client Component 时类型是干净的，不会把 Prisma 内部类型泄漏出去
//   2. 以后换 ORM 或改查询，只要保证返回这个形状，组件就不用动
// ---------------------------------------------------------------------------

export type ProductListItem = {
  id: string
  name: string
  category: string
  /** 主图路径，没有图片时为 null */
  image: string | null
  /** 该 SPU 下所有 SKU 的最低/最高价（单位：分） */
  minPrice: number
  maxPrice: number
  /** 所有 SKU 库存都为 0 */
  soldOut: boolean
  /** 该 SPU 下 SKU 总数 */
  skuCount: number
}

export type SkuView = {
  id: string
  skuCode: string
  size: string
  color: string
  stock: number
  price: number
}

/** 按颜色分组的 SKU —— 前端选择器先选颜色再选尺码，这个结构最顺手 */
export type ColorGroup = {
  color: string
  sizes: SkuView[]
  /** 该颜色下所有尺码的库存合计，为 0 则整个颜色按钮置灰 */
  totalStock: number
  /** 该颜色的最低价，用于在按钮上显示价格提示 */
  minPrice: number
}

export type ProductDetail = {
  id: string
  name: string
  description: string
  category: string
  images: string[]
  colors: ColorGroup[]
  /** 全 SPU 库存合计 */
  totalStock: number
}

// ---------------------------------------------------------------------------
// 商品列表
// ---------------------------------------------------------------------------
export async function getAllProducts(options?: {
  /** 按商品名 + 描述模糊搜索。空字符串视为「不搜索」 */
  q?: string
  /** 只取某个分类。分类名是精确匹配，来源是 getAllCategories() */
  category?: string
  /** 排序方式，默认 newest */
  sort?: ProductSort
}): Promise<ProductListItem[]> {
  const where: Prisma.ProductWhereInput = { isActive: true }

  // 【为什么搜索要同时命中 name 和 description】
  // 买家搜「缓震」时，可能商品名里没有这个词、但描述里写了「全掌缓震」。
  // 只搜名字会漏掉这类商品。LIKE 参数化查询，没有注入风险，
  // 只是 % / _ 仍会当通配符（和后台一致，知道有这回事即可）
  const keyword = options?.q?.trim()
  if (keyword) {
    // 【为什么两处都要显式写 mode: "insensitive"】
    // 换到 PostgreSQL 之前，"大小写不敏感" 是白拿的：
    // SQLite 的 LIKE 对 ASCII 字母默认就不区分大小写。
    // PostgreSQL 的 LIKE 是**区分**大小写的，不写 mode 就等于
    // 「搜 rUn 找不到 Run」—— 而中文没有大小写，测试里搜的都是中文，
    // 这条差异不会被任何现有断言发现，只有英文关键词的真实用户会撞上。
    // 所以这是「保持原有行为」的改动，不是新增行为。
    // 详细说明见下面 getAdminProducts 里那段更长的注释
    where.OR = [
      { name: { contains: keyword, mode: "insensitive" } },
      { description: { contains: keyword, mode: "insensitive" } },
    ]
  }

  if (options?.category) {
    where.category = options.category
  }

  const products = await prisma.product.findMany({
    where,
    orderBy: { createdAt: "desc" },
    // 字段集合和「行 → 卡片」的映射都抽到了 src/lib/product-list.ts，
    // 因为「我的收藏」页要的是完全一样的东西（见那个文件顶部的注释）
    select: PRODUCT_LIST_SELECT,
  })

  const items = products.map(toProductListItem)

  // 【价格排序为什么在 JS 里做，而不是 SQL orderBy】
  // 排序键是 minPrice —— 它是从该商品的 SKU 里现算出来的，数据库里
  // 没有这一列。要下沉到 SQL 得写 relation aggregate 的 orderBy
  // （orderBy: { skus: { _min: { price } } }），对不同数据库的兼容性不一。
  // 这个规模下把「已在内存里的这几行」排一下，简单、可读、也够快。
  // 默认的 newest 已经在查询里按 createdAt desc 排好了，不用再动。
  //
  // Array.prototype.sort 在 ES2019+ 是稳定的，同价的商品会保持
  // 「新上架在前」的顺序，正好是我们要的
  const sort = options?.sort ?? "newest"
  if (sort === "price_asc") items.sort((a, b) => a.minPrice - b.minPrice)
  else if (sort === "price_desc") items.sort((a, b) => b.minPrice - a.minPrice)

  return items
}

/**
 * 单个 SKU 的实时库存和价格。
 *
 * 用途：商品详情页里用户切换颜色/尺码时，前端调 Server Action 拿**此刻**
 * 的最新库存 —— 页面加载时传下去的 colors 是一份快照，从加载到用户
 * 切换之间库存可能已经被别人买走了。
 */
export async function getSkuAvailability(
  skuId: string,
): Promise<{ stock: number; price: number } | null> {
  const sku = await prisma.sku.findUnique({
    where: { id: skuId },
    select: { stock: true, price: true },
  })
  return sku
}

/**
 * 所有在售商品的分类，去重、按字母序排好。
 *
 * 【为什么不用写死在常量里的分类列表】
 * 分类是运营数据，不是代码。写死的话每加一个分类就要改一次代码、
 * 发一次版。distinct 从数据库现取，加分类只要改数据。
 */
export async function getAllCategories(): Promise<string[]> {
  const rows = await prisma.product.findMany({
    where: { isActive: true },
    distinct: ["category"],
    select: { category: true },
    orderBy: { category: "asc" },
  })
  return rows.map((row) => row.category)
}

// ---------------------------------------------------------------------------
// 商品详情
// ---------------------------------------------------------------------------
export async function getProductDetail(
  id: string,
): Promise<ProductDetail | null> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      skus: {
        // 排序很讲究：先按颜色排，同色内按尺码「数值」排。
        // 注意 size 是 String，直接按字符串排会得到 39,40,41,42,43,44 —— 这个
        // 例子碰巧对，但换成 35~44 就会排成 "35,36,...,4,40"，所以下面还要再兜一层。
        orderBy: [{ color: "asc" }, { size: "asc" }],
      },
    },
  })

  if (!product || !product.isActive) return null

  // ---- 按颜色分组 ----
  // 用 Map 保持「第一次出现的顺序」，这样颜色的展示顺序和数据库写入顺序一致
  const grouped = new Map<string, SkuView[]>()

  for (const sku of product.skus) {
    const view: SkuView = {
      id: sku.id,
      skuCode: sku.skuCode,
      size: sku.size,
      color: sku.color,
      stock: sku.stock,
      price: sku.price,
    }

    const bucket = grouped.get(sku.color)
    if (bucket) {
      bucket.push(view)
    } else {
      grouped.set(sku.color, [view])
    }
  }

  const colors: ColorGroup[] = Array.from(grouped.entries()).map(
    ([color, sizes]) => {
      // 尺码按数值排序，让 "5" 排在 "44" 前面
      sizes.sort((a, b) => Number(a.size) - Number(b.size))

      return {
        color,
        sizes,
        totalStock: sizes.reduce((sum, s) => sum + s.stock, 0),
        minPrice: Math.min(...sizes.map((s) => s.price)),
      }
    },
  )

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    images: parseImages(product.images),
    colors,
    totalStock: colors.reduce((sum, c) => sum + c.totalStock, 0),
  }
}

// ============================================================================
// 管理后台：商品管理 —— 第 9b 步
//
// 【前台查询和后台查询为什么要分开】
// 前台那个 getAllProducts() 里写死了 where: { isActive: true }。
// 后台必须能看到下架的商品，否则「上架」这个操作就无从下手 ——
// 你看不到的东西没法重新上架。
//
// 更重要的差别在**谁能调**：后台查询返回全站数据（含下架商品、成本相关字段），
// 一旦被前台误用就是信息泄露。所以函数名上明确带 Admin，
// 让每个调用点都必须显式地写出「我在用后台查询」。
// ============================================================================

export type AdminProductRow = {
  id: string
  name: string
  category: string
  /** 主图，没有则为 null */
  image: string | null
  isActive: boolean
  minPrice: number
  maxPrice: number
  skuCount: number
  /** 所有 SKU 库存合计 */
  totalStock: number
  /**
   * 有多少个 SKU 库存低于阈值。
   *
   * 【为什么这个字段是白送的】
   * 下面 findMany 本来就把每个 SKU 的 stock 查出来了（算 totalStock 要用），
   * 顺手 filter 一下再 .length 就是答案 —— 不需要额外查一次库。
   * 「先把字段捞全，能在内存里算完的就在内存里算」和
   * 「能在 SQL 里算完的别捞回来」看起来矛盾，其实不是：
   * 数据**已经在手上**的时候，再发一条查询去数它是纯浪费。
   */
  lowStockSkuCount: number
  createdAt: Date
}

/**
 * 后台商品列表。
 *
 * 【为什么不用分页】
 * 一个鞋店后台同时管理的商品通常几十到几百个，前端一屏能滚完，
 * 加个分类筛选就够了。分页的复杂度（页码状态、翻页时丢筛选条件）
 * 在这个量级上不划算。等商品上千个再加也不迟 ——
 * 订单列表就不一样，它是**只增不减**的，所以那边第 9a 步就做了分页。
 */
export async function getAdminProducts(options?: {
  /** 只看在售 / 只看已下架。不传则全部 */
  active?: boolean
  /** 只看「有低库存 SKU」的商品。后台首页那张低库存卡片点进来用的 */
  lowStock?: boolean
  /** 按商品名模糊搜索。空字符串视为「不搜索」 */
  q?: string
}): Promise<AdminProductRow[]> {
  const where: {
    isActive?: boolean
    skus?: { some: { stock: { lt: number } } }
    // mode 是 PostgreSQL 上让 LIKE 变成 ILIKE 的那个开关（见下面第 1 点）。
    // 类型注解里必须放行它，否则赋值那一行会报「mode 不存在于
    // { contains: string }」—— 而这条错误只在换了数据库之后才出现
    name?: { contains: string; mode?: "insensitive" }
  } = {}

  if (options?.active !== undefined) where.isActive = options.active

  // 【为什么空字符串要当成「不搜索」，而不是「搜空字符串」】
  // 搜空字符串在语义上是「名字里包含空」——听起来等于全部，
  // 但只要数据库里有 name 为空的行，就变成「只找名字为空的」。
  // 与其依赖这种模糊的巧合，不如显式写清楚：空就是不筛
  const keyword = options?.q?.trim()
  if (keyword) {
    // contains 生成的是 SQL 的 LIKE '%xxx%'。
    //
    //  1. 大小写：**这是从 SQLite 换到 PostgreSQL 时唯一需要动的一行。**
    //     原来这段注释预言过这件事，现在应验了：
    //     SQLite 的 LIKE 对 ASCII 字母默认不区分大小写，所以以前不写 mode
    //     也是「对」的；PostgreSQL 的 LIKE 区分大小写，不写就是
    //     「搜 rUn 找不到 Run」。加 mode: "insensitive" 让它生成 ILIKE，
    //     行为回到从前。反过来说，这个参数在 SQLite 上会直接报错 ——
    //     所以两个数据库没法共用同一份代码，只能二选一地写
    //  2. 通配符：用户输入的 % 和 _ 会被当成 LIKE 的通配符，
    //     搜 "50%" 实际会匹配到「50」开头的所有商品。
    //     参数化查询保证它**不会变成注入**，只是搜得比预期宽。
    //     真要精确匹配得转义 + 加 ESCAPE 子句，那需要写裸 SQL；
    //     后台搜索这个精度够用了，知道有这回事就行
    where.name = { contains: keyword, mode: "insensitive" }
  }

  // 【为什么用 skus: { some: ... } 而不是先查 SKU 再拿 productId 去 in】
  // 「有任意一个 SKU 库存低于阈值」正是 some 的定义。
  // 用 some 是一条带 EXISTS 子查询的 SQL；先查 SKU 列表再拼 id 数组
  // 至少要两条查询，而且商品一多那个 IN 列表会长得很难看。
  //
  // 【注意这是「商品」维度的筛选，不是「SKU」维度】
  // 筛出来的是「含有低库存规格的商品」，可能有 4 款商品对应 12 个低库存 SKU。
  // 所以列表里还要显示每款商品**有几个** SKU 告急（lowStockSkuCount），
  // 否则管理员点进来只看到 4 行，会以为卡片上的 12 是错的。
  if (options?.lowStock) {
    where.skus = { some: { stock: { lt: LOW_STOCK_THRESHOLD } } }
  }

  const products = await prisma.product.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      category: true,
      images: true,
      isActive: true,
      createdAt: true,
      skus: { select: { price: true, stock: true } },
    },
  })

  return products.map((p) => {
    const prices = p.skus.map((s) => s.price)

    return {
      id: p.id,
      name: p.name,
      category: p.category,
      image: parseImages(p.images)[0] ?? null,
      isActive: p.isActive,
      minPrice: prices.length ? Math.min(...prices) : 0,
      maxPrice: prices.length ? Math.max(...prices) : 0,
      skuCount: p.skus.length,
      totalStock: p.skus.reduce((sum, s) => sum + s.stock, 0),
      lowStockSkuCount: p.skus.filter((s) => s.stock < LOW_STOCK_THRESHOLD).length,
      createdAt: p.createdAt,
    }
  })
}

export type AdminSkuRow = {
  id: string
  skuCode: string
  size: string
  color: string
  price: number
  stock: number
}

export type AdminProductDetail = {
  id: string
  name: string
  description: string
  category: string
  images: string[]
  isActive: boolean
  createdAt: Date
  skus: AdminSkuRow[]
  /** 有多少个订单项引用了这款商品的 SKU —— 决定能不能物理删除 */
  referencedByOrders: number
}

/** 后台商品详情。和前台的区别：不看 isActive，且带上「有没有被订单引用过」 */
export async function getAdminProductDetail(
  id: string,
): Promise<AdminProductDetail | null> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      skus: { orderBy: [{ color: "asc" }, { size: "asc" }] },
      _count: { select: { skus: true } },
    },
  })

  if (!product) return null

  // 订单项引用了这款商品的任何 SKU 吗？
  // OrderItem.skuId 是 SetNull，SKU 被删后这个字段会变成 null ——
  // 也就是说「这个 SKU 卖过东西」这件事在删完之后就查不到了。
  // 所以必须在**删之前**问一次
  const referencedByOrders = await prisma.orderItem.count({
    where: { skuId: { in: product.skus.map((s) => s.id) } },
  })

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category,
    images: parseImages(product.images),
    isActive: product.isActive,
    createdAt: product.createdAt,
    referencedByOrders,
    skus: product.skus
      // 尺码按数值排，"5" 要排在 "44" 前面。
      // 数据库里按字符串排做不到，所以在应用层再排一次
      .sort((a, b) => a.color.localeCompare(b.color, "zh") || Number(a.size) - Number(b.size))
      .map((sku) => ({
        id: sku.id,
        skuCode: sku.skuCode,
        size: sku.size,
        color: sku.color,
        price: sku.price,
        stock: sku.stock,
      })),
  }
}

// ---------------------------------------------------------------------------
// 后台：商品写操作
// ---------------------------------------------------------------------------

export type ProductWriteInput = {
  name: string
  description: string
  category: string
  /** 已经解析好的图片数组，写库时才序列化成 JSON 字符串 */
  images: string[]
}

/** 新建商品。返回新 id，由 action 决定跳去哪 */
export async function createProduct(
  input: ProductWriteInput,
): Promise<{ id: string }> {
  const product = await prisma.product.create({
    data: {
      name: input.name,
      description: input.description,
      category: input.category,
      // SQLite 不支持标量数组，只能把数组 JSON.stringify 成一个字符串存。
      // 读的时候用 parseImages() 解析（见 src/lib/format.ts）
      images: JSON.stringify(input.images),
      // 新建的商品默认上架。刚建完还没有 SKU，前台会显示成「售罄」，
      // 所以建完应该立刻去加规格 —— 商品列表页会给这种商品一个提示
      isActive: true,
    },
    select: { id: true },
  })

  return product
}

/** 修改商品信息。不改 isActive —— 上下架是独立的操作，见 setProductActive */
export async function updateProduct(
  id: string,
  input: ProductWriteInput,
): Promise<void> {
  await prisma.product.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      category: input.category,
      images: JSON.stringify(input.images),
    },
  })
}

/**
 * 上架 / 下架。
 *
 * 【为什么用 isActive 而不是删除商品】
 * 商品一旦被卖过，删除就会留下烂摊子：
 *   - 订单项里存的是快照（商品名、成交价），删了商品订单还能正常显示，
 *     但 skuId 会被置空，以后想追溯「这笔订单买的是哪个 SKU」就断了
 *   - 用户购物车里的这条商品会跟着被级联删掉，用户会莫名其妙发现东西少了
 *
 * 而「下架」只是让它在前台消失：已有订单不受影响，
 * 购物车里的条目还在（但会显示成售罄），想恢复随时点上架。
 * 这是电商后台的通行做法 —— **默认不物理删除，只标记状态**。
 */
export async function setProductActive(
  id: string,
  isActive: boolean,
): Promise<void> {
  await prisma.product.update({ where: { id }, data: { isActive } })
}

export type SkuWriteInput = {
  size: string
  color: string
  /** 单位：分 */
  price: number
  stock: number
}

/**
 * 给商品加一个规格（SKU）。
 *
 * 【货号 skuCode 自动生成】
 * 格式：商品 id 去掉 prod_ 前缀 + 尺码 + 颜色代码段 + 随机后缀。
 * 例：RUNNING-42-8F3A
 *
 * 为什么不按「尺码 + 颜色」拼得漂漂亮亮（比如 RUN-42-BLK）？
 * 因为颜色是中文（"曜石黑"），拼进货号既不通用也不好看，
 * 而且**中文拼音缩写需要额外映射表**，属于给自己找麻烦。
 * 学习项目里用一个短随机串，好处是天然不容易撞 ——
 * skuCode 上有 @unique，撞了会抛 P2002，还得处理。
 *
 * 生成后仍要处理 P2002：极小概率会撞，也可能有人手工往库里插过同样的货号。
 */
export async function createSku(
  productId: string,
  input: SkuWriteInput,
): Promise<{ ok: true; sku: AdminSkuRow } | { ok: false; error: string }> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true },
  })

  if (!product) return { ok: false, error: "商品不存在" }

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  const prefix = productId.replace(/^prod_/, "").toUpperCase().slice(0, 8)
  const skuCode = `${prefix}-${input.size}-${suffix}`

  try {
    const sku = await prisma.sku.create({
      data: {
        productId,
        size: input.size,
        color: input.color,
        price: input.price,
        stock: input.stock,
        skuCode,
      },
      select: { id: true, skuCode: true, size: true, color: true, price: true, stock: true },
    })

    return { ok: true, sku }
  } catch (error) {
    // 【P2002 是「唯一约束冲突」】
    // 这里有两个唯一约束可能被触发，要分开给提示：
    //   @@unique([productId, size, color]) → 这个尺码+颜色已经存在了
    //   skuCode @unique                    → 货号撞了（极小概率）
    //
    // 【怎么区分撞的是哪一条 —— 不要去看错误里的约束名】
    // 这里原本写的是 `String(error.meta?.target ?? "").includes("skuCode")`。
    // 那在 Prisma 7 上**永远为 false** —— P2002 的 meta 里只有
    // { driverAdapterError, table }，根本没有 target（约束名埋在驱动错误的
    // 深层结构里）。后果是「货号重复了」那条分支成了死代码：真撞上货号时，
    // 管理员会收到「这个规格已经存在了」—— 一句把他引向错误方向的话，
    // 他会去找一个根本不存在的重复规格。
    //
    // 【现在改用一次查询当判据】
    // 按 (productId, size, color) 查一次：查得到，说明是这个组合重复；
    // 查不到，就只可能是货号撞了。查询结果自己就是判据，
    // 不依赖任何 Prisma 的内部结构，换版本也不会碎
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const sameSpec = await prisma.sku.findUnique({
        // productId_size_color 是 schema 里 @@unique([productId, size, color])
        // 自动生成的复合键名
        where: {
          productId_size_color: {
            productId,
            size: input.size,
            color: input.color,
          },
        },
        select: { id: true },
      })

      if (!sameSpec) {
        return { ok: false, error: "货号重复了，请再试一次" }
      }

      return {
        ok: false,
        error: `${input.color} / ${input.size}码 这个规格已经存在了`,
      }
    }

    throw error
  }
}

/**
 * 改价格。价格可以直接设成新值 —— 价格不存在「并发累加」的问题。
 *
 * 【为什么这里还要挡一次 price <= 0】
 * action 里已经校验过了，这里是第二道。不是为了防用户（用户过不了 action 那关），
 * 而是为了防**以后的自己**：哪天新增一个批量导入 CSV 的功能，
 * 或者写个脚本直接从命令行改价，就绕过了 action 的校验。
 * 库里一旦出现 0 元甚至负价的 SKU，前台会显示成免费，
 * 而且它会被订单正常买走 —— 事后发现时已经成交了一批。
 *
 * 判断依据很简单：**这条数据如果错了，会直接造成损失吗？**
 * 会的话就值得在数据入口处再挡一次，哪怕 action 里已经挡过了。
 */
export async function updateSkuPrice(
  skuId: string,
  price: number,
): Promise<{ ok: true; price: number } | { ok: false; error: string }> {
  if (!Number.isInteger(price) || price <= 0) {
    return { ok: false, error: "价格必须是大于 0 的整数（单位：分）" }
  }

  const result = await prisma.sku.updateMany({
    where: { id: skuId },
    data: { price },
    // updateMany 返回 count，只有 update 能直接返回改完的行
  })

  if (result.count === 0) return { ok: false, error: "规格不存在" }

  return { ok: true, price }
}

/**
 * 调整库存：**只能按增减量调，不能直接设成某个数字**。
 *
 * 【为什么这是个必须讲清楚的设计】
 * 直觉上后台应该是「输入框里填个 20，保存」。但那个做法有竞态：
 *
 *   时刻  管理员                          用户
 *    t1   页面显示库存 10，他决定改成 20
 *    t2                                   下单 2 件，库存 10 → 8
 *    t3   保存，写入 stock = 20
 *
 * 结果：卖掉的 2 件被无声地「还」了回来，实际库存是 18 却记成 20，
 * 之后就会超卖 2 件。根因还是那个老问题 —— 先读后写，
 * 中间隔着的世界已经变了。
 *
 * 正确做法和扣库存一样：把增减交给数据库做，一次原子操作。
 *     UPDATE skus SET stock = stock + ? WHERE id = ?
 * 对应的 Prisma 写法是 increment / decrement，而不是赋一个值。
 *
 * 所以界面上的输入框是「入库 N 件 / 出库 N 件」，而不是「把库存设为 N」。
 * 盘点发现数字对不上时，用「出库 2 件」把差额调掉即可 ——
 * 这比「设为正确值」麻烦一点点，但它永远不会把别人刚卖掉的货吃掉。
 *
 * @param delta 正数入库，负数出库。**必须非 0** —— 见下面那条检查
 */
export async function adjustSkuStock(
  skuId: string,
  delta: number,
): Promise<{ ok: true; stock: number } | { ok: false; error: string }> {
  if (!Number.isInteger(delta) || delta === 0) {
    // 【为什么 delta = 0 要当成错误，而不是「查一下库存」】
    // 「调整 0 件」这句话本身没有意义。如果让它成功返回，
    // 调用方会拿到 ok: true，界面上就弹出一句「已入库，现在库存 25 件」——
    // 管理员以为自己改了什么，其实什么都没发生。
    // 把无效输入伪装成成功，比直接报错难查一百倍：
    // 前者你会以为是数据错了，后者一眼就知道是自己参数传错了。
    //
    // 想看当前库存就老实调 findUnique 去查，别借用「调整」这个动作。
    return { ok: false, error: "调整数量必须是非 0 整数" }
  }

  if (delta > 0) {
    // 入库：加多少都不会变成负数，直接 increment
    const result = await prisma.sku.updateMany({
      where: { id: skuId },
      data: { stock: { increment: delta } },
    })
    if (result.count === 0) return { ok: false, error: "规格不存在" }
  } else {
    // 出库：**同样要把判断塞进 WHERE**，防止把库存扣成负数。
    // stock: { gte: -delta } 保证「够不够扣」和「扣多少」在同一条 SQL 里完成
    const result = await prisma.sku.updateMany({
      where: { id: skuId, stock: { gte: -delta } },
      data: { stock: { decrement: -delta } },
    })

    if (result.count === 0) {
      // 可能是规格不存在，也可能是库存不够 —— 分开告诉管理员
      const sku = await prisma.sku.findUnique({
        where: { id: skuId },
        select: { stock: true },
      })
      if (!sku) return { ok: false, error: "规格不存在" }
      return {
        ok: false,
        error: `出库数量超过现有库存（现在只有 ${sku.stock} 件）`,
      }
    }
  }

  const sku = await prisma.sku.findUniqueOrThrow({
    where: { id: skuId },
    select: { stock: true },
  })

  return { ok: true, stock: sku.stock }
}

/** 删除规格。已经被订单引用过的 SKU 不允许删 —— 那会让历史订单失去追溯线索 */
export async function deleteSku(
  skuId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const referenced = await prisma.orderItem.count({ where: { skuId } })
  if (referenced > 0) {
    return {
      ok: false,
      error: `这个规格被 ${referenced} 个订单引用过，不能删除。把库存清零即可让它在前台显示售罄`,
    }
  }

  const result = await prisma.sku.deleteMany({ where: { id: skuId } })
  if (result.count === 0) return { ok: false, error: "规格不存在" }

  return { ok: true }
}

/**
 * 物理删除商品。
 *
 * 【为什么要在事务里，以及为什么先检查订单引用】
 * 删除商品会级联删掉它的所有 SKU（schema 里的 onDelete: Cascade），
 * 而删 SKU 又会级联删掉购物车里这些 SKU 的条目。这一串动作
 * 要么全做完要么全不做，所以包在事务里。
 *
 * 「被订单引用过就不许删」这条规则放在应用层而不是数据库层。
 * 因为 OrderItem.skuId 的外键是 SetNull —— 数据库层面的意思是
 * 「SKU 没了就把这个字段置空，订单行保留」，它不会阻止删除。
 * 而这个项目的业务判断是：只要卖过，就不该删，应该下架。
 */
export async function deleteProduct(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const detail = await getAdminProductDetail(id)
  if (!detail) return { ok: false, error: "商品不存在" }

  if (detail.referencedByOrders > 0) {
    return {
      ok: false,
      error: `这款商品被 ${detail.referencedByOrders} 个订单引用过，不能删除。请改用「下架」`,
    }
  }

  await prisma.$transaction([
    // 先删 SKU 再删商品？不需要 —— schema 里 Product → Sku 是 onDelete: Cascade，
    // 删商品时数据库会自动清理它的 SKU。但购物车里的条目也要跟着走，
    // 那一条链（Sku → CartItem）同样是 Cascade，所以一句 delete 就够了。
    prisma.product.delete({ where: { id } }),
  ])

  return { ok: true }
}
