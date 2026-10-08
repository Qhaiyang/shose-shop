import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

// ============================================================================
// 第一层：单元测试配置
//
// 只跑 tests/unit/，这些用例**不碰数据库、不碰网络、不碰 Next 运行时**，
// 纯粹是「给一个值，看返回什么」。所以可以在几百毫秒内跑完。
//
// 【为什么单元测试和集成测试要分成两个配置文件】
// 因为它们的**运行前提**完全不同：
//   - 单元：什么都不需要，随时能跑
//   - 集成：需要一个建好表、灌好数据的测试数据库
// 如果混在一个配置里，「跑单元测试」就会顺带上数据库 ——
// 于是你在重构一个纯函数时，会因为测试库没准备好而失败。
// 分开之后，单元测试的快和集成测试的重互不干扰。
//
// 【为什么测试目录在根目录的 tests/ 而不是 src/ 里】
// src/ 里放的都是会进生产 bundle 的代码。测试不是，
// 分开放，「哪些文件会发布」一眼就能看出来。
// ============================================================================

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // 测试文件里显式 import { describe, it, expect } from "vitest"，
    // 不打开 globals —— 这样 TypeScript 不需要额外配置类型，
    // 而且看一个测试文件就知道它依赖什么
    globals: false,
  },
  resolve: {
    // 让测试也能用 "@/lib/xxx" 这种路径，和业务代码保持一致。
    // 不装 vite-tsconfig-paths 是因为只需要这一个别名，
    // 为一行配置多装一个依赖不划算
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
})
