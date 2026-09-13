/**
 * 诊断测试专用配置：与 vitest.config.ts 相同的编译环境，
 * 但 include 指向 tests/diagnose（一次性证据收集，不进常规门禁）。
 *
 * 运行：node node_modules/vitest/vitest.mjs run --config vitest.diagnose.config.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/diagnose/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
