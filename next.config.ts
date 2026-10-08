import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
    【distDir 为什么可以从环境变量来】
    Next 16 的 dev server 会在 distDir 下放一把锁（默认是 .next/dev/lock），
    同一个项目目录同时只允许跑一个 —— 启动第二个会直接被拒绝，
    提示「Another next dev server is already running」。

    E2E 测试正需要同时跑第二个 dev server（独立的库、独立的端口）。
    与其去关掉那把锁（锁没了，两个 server 就会共用同一份编译缓存，
    互相覆盖产物、把测试搞得时灵时不灵），不如让测试用一个完全独立的
    输出目录：锁天然不冲突，缓存也不会串。

    平时不设这个变量，行为完全不变。
  */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
