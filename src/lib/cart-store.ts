import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import type { CartItemView } from "@/lib/cart-types"

// ============================================================================
// 本地购物车（未登录用户）
//
// 【为什么用 zustand 而不是 useState + Context】
// 购物车状态要被顶部导航的角标、商品详情页的加购按钮、购物车页面同时读写，
// 这些组件在组件树里离得很远。用 Context 的话要在根部包一层 Provider，
// 而且任何一次加购都会让所有消费者重渲染。zustand 的 store 在组件树之外，
// 组件按需订阅，改数量只重渲染订阅了数量的那个组件。
//
// 【持久化】
// persist 中间件把 state 写进 localStorage，刷新页面不丢。
// ============================================================================

/** localStorage 里的 key，加版本号方便以后改结构时做迁移 */
const STORAGE_KEY = "shose-shop-cart"

type CartStore = {
  items: CartItemView[]

  /**
   * 是否已从 localStorage 读取完成。
   *
   * 服务端渲染时读不到 localStorage，所以首屏 HTML 里购物车必然是空的。
   * 组件靠这个标志判断「现在能不能信任 items」—— 水合完成前渲染空状态，
   * 水合完成后再渲染真实内容，避免 React 报 hydration mismatch。
   */
  hydrated: boolean
  setHydrated: (hydrated: boolean) => void

  /** 加入购物车。已存在的 SKU 累加数量，不新增行 —— 与数据库的 @@unique 约束行为一致 */
  addItem: (item: Omit<CartItemView, "quantity">, quantity: number) => void
  /** 直接设置数量（购物车页 +/- 用） */
  setQuantity: (skuId: string, quantity: number) => void
  /** 移除某个 SKU */
  removeItem: (skuId: string) => void
  /** 清空（合并到数据库成功后调用） */
  clear: () => void
  /** 整体替换（刷新服务端数据用） */
  replaceAll: (items: CartItemView[]) => void
}

/** 单次最多购买件数，和 SKU 选择器保持一致 */
const MAX_QUANTITY_PER_ORDER = 10

export const useCartStore = create<CartStore>()(
  persist(
    (set) => ({
      items: [],
      hydrated: false,
      setHydrated: (hydrated) => set({ hydrated }),

      addItem: (item, quantity) =>
        set((state) => {
          const existing = state.items.find((i) => i.skuId === item.skuId)

          // 已有该 SKU → 累加数量（这是「同 SKU 数量累加」的前端一半）
          if (existing) {
            return {
              items: state.items.map((i) =>
                i.skuId === item.skuId
                  ? {
                      ...i,
                      quantity: clampQuantity(i.quantity + quantity, i.stock),
                      // 顺手把价格/库存快照更新成最新的
                      price: item.price,
                      stock: item.stock,
                    }
                  : i,
              ),
            }
          }

          // 新 SKU → 追加一行
          return {
            items: [
              ...state.items,
              { ...item, quantity: clampQuantity(quantity, item.stock) },
            ],
          }
        }),

      setQuantity: (skuId, quantity) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.skuId === skuId
              ? { ...i, quantity: clampQuantity(quantity, i.stock) }
              : i,
          ),
        })),

      removeItem: (skuId) =>
        set((state) => ({
          items: state.items.filter((i) => i.skuId !== skuId),
        })),

      clear: () => set({ items: [] }),

      replaceAll: (items) => set({ items }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),

      // 【关键】跳过自动水合。
      //
      // 因为服务端渲染时读不到 localStorage，如果让 persist 在初始化时自动
      // 读取，服务端渲染出的 HTML（空购物车）和客户端首次渲染（有商品）就会
      // 对不上，React 报 hydration mismatch。
      //
      // 设成 true 之后，由 <CartSync /> 组件在 useEffect 里手动调
      // useCartStore.persist.rehydrate()，那时已经在客户端了，不会冲突。
      skipHydration: true,

      // 只持久化 items，不要把方法也存进去（hydrated 是运行时状态，存了反而会出错）
      partialize: (state) => ({ items: state.items }),

      // 水合完成（或失败）后回调，用来点亮 hydrated 标志
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error("[cart] 从 localStorage 恢复购物车失败:", error)
        }
        state?.setHydrated(true)
      },

      version: 1,
    },
  ),
)

/** 把数量限制在 1 ~ min(库存, 单次上限) 之间 */
function clampQuantity(quantity: number, stock: number): number {
  const max = Math.max(1, Math.min(stock, MAX_QUANTITY_PER_ORDER))
  return Math.min(Math.max(1, Math.floor(quantity)), max)
}

/** 购物车是否已经在客户端完成水合（用于避免 SSR/CSR 内容不一致） */
export const selectItems = (state: CartStore) => state.items
