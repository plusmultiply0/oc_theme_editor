import { defineConfig } from '@playwright/test';

/**
 * E2E 配置（T56 的验收要求）。
 *
 * 目前 tests/e2e 下没有任何用例：Electron 窗口在本环境无法启动，
 * 写了也跑不起来，因此这里刻意留空并保留配置，避免 `playwright test`
 * 跑去执行 vitest 的单元/集成用例。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: {
    // Electron 走本机窗口，不需要浏览器下载
    headless: true,
  },
});
