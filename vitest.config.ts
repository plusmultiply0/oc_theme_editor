import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // 集成测试包含解压/重打包归档，默认 5s 不够
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
