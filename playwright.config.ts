import { defineConfig } from '@playwright/test';

/**
 * E2E 配置（T56、R8）。
 *
 * 这里的用例是**真实 Electron 窗口**的闭环测试（tests/e2e/theme-switcher.spec.ts）：
 * 启动应用 → 拖拽导入 → 看可读性报告 → 走确认框 → 真的改写合成安装 → 恢复。
 *
 * 两条纪律：
 * 1. 不加 `--pass-with-no-tests`：零用例必须让门禁失败，不能拿「没有用例」冒充通过。
 * 2. `testDir` 必须限定在 tests/e2e，否则 playwright 会去执行 vitest 的 *.test.ts
 *    （会报「Vitest cannot be imported in a CommonJS module」）。
 *
 * 无显示会话下 GPU 进程会反复重启并 FATAL，因此 spec 里的 launch args 带上了
 * --disable-gpu / --no-sandbox / --in-process-gpu 等开关，不在这里配置。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  use: {
    // Electron 走本机窗口，不需要下载浏览器
    headless: true,
  },
});
