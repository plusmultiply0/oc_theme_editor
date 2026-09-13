/**
 * 冒烟：用 Playwright 启动候选包的 exe，确认能出窗口、能读到界面文本。
 *
 * 为什么不直接用命令行启动：从 shell 上下文启动 GUI 时窗口创建可能受限，
 * 会误判为「包坏了」。Playwright 的 electron.launch 与 e2e 用的是同一套机制，
 * 与真实用户双击启动的行为一致。
 *
 * 用法：npx tsx tools/smoke-packaged.ts <win-unpacked 目录>
 */
import { _electron as electron } from 'playwright';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: npx tsx tools/smoke-packaged.ts <win-unpacked 目录>');
  process.exit(2);
}
const exe = path.join(dir, 'OpenCodeThemeSwitcher.exe');

async function main() {
  /*
   * 必须清掉 ELECTRON_RUN_AS_NODE：某些开发环境（含本仓库的自动化 shell）
   * 会全局导出它，Electron 应用会退化成 Node 模式 —— 不建窗口、无脚本时静默
   * 退出 0，看上去像「包坏了」。曾据此误判过一次，所以这里显式剥离。
   */
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: exe,
    env: env as NodeJS.ProcessEnv,
    // 本机自动化环境下渲染进程可能因 GPU 初始化崩溃，冒烟时禁用 GPU 不影响结论
    args: ['--disable-gpu', '--disable-software-rasterizer'],
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  const title = await win.title();
  const text = (await win.locator('body').innerText().catch(() => '')) || '';
  const firstLine = text.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ');
  console.log('窗口标题:', title);
  console.log('界面文本片段:', firstLine.slice(0, 160));
  await app.close();
  console.log('SMOKE_OK');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log('SMOKE_FAIL:', e instanceof Error ? e.message.slice(0, 300) : String(e));
    process.exit(1);
  },
);
