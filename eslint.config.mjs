import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // E2E 测试用的独立构建目录（见 next.config.ts 的 distDir）。
    // 里面全是 Turbopack 编译出来的产物，不 ignore 的话
    // `npm run lint` 会去检查这些生成代码，报出几千条无意义的告警
    ".next-e2e/**",
    // Playwright 的产物（失败截图、trace、HTML 报告）
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
