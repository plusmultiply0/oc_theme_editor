/**
 * 真实 Electron 主进程的端到端闭环（R1 验收、R8 发布门禁）。
 *
 * Node 下的测试永远抓不到 R1 那个缺陷：Electron 的 `fs` 被包装过，
 * `app.asar` 会被当成虚拟目录，识别逻辑在 Node 里全绿、在真机上一跑就「找不到归档」。
 * 所以这里直接起一个真实的 Electron 主进程（tools/electron-fixture-e2e.cjs），
 * 在里面跑合成安装的 识别 → 生成 → 准备 → 应用 → 恢复 → 启动恢复扫描，
 * 再把结果 JSON 读回来断言。
 *
 * 不具备以下任一条件时**判失败而不是跳过**——零覆盖不能冒充通过：
 * - 找不到 electron 可执行文件；
 * - 找不到 out/ 构建产物（先跑 npm run build）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(ROOT, 'tools', 'electron-fixture-e2e.cjs');
const RESULT = path.join(ROOT, 'tools', 'electron-fixture-e2e-result.json');

function electronBinary(): string {
  const candidates =
    process.platform === 'win32'
      ? [path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')]
      : [
          path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
          path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('找不到 electron 可执行文件：请先 npm install（本用例不接受跳过）');
  }
  return found;
}

/**
 * 跑 harness 并等待结果文件落盘。
 *
 * 注意：这里**不等待子进程退出**。实测（见 docs/acceptance.md 6.1）无显示会话下
 * Electron 的 GPU 子进程会反复重启，`app.exit()` 与 `process.exit()` 之后的退出流程
 * 都可能被拖住几分钟；而结论（结果 JSON）是同步落盘的，等它就够了。
 * 所以这里等文件出现、解析成功后立刻杀掉子进程。
 */
function runHarness(timeoutMs = 150_000): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.rmSync(RESULT, { force: true });

    const env = { ...process.env } as NodeJS.ProcessEnv;
    // 该变量会让 electron 以纯 Node 身份运行，主进程根本不启动，等于什么都没验
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(
      electronBinary(),
      [
        '--disable-gpu',
        '--no-sandbox',
        '--disable-gpu-compositing',
        '--disable-software-rasterizer',
        '--in-process-gpu',
        '--disable-dev-shm-usage',
        HARNESS,
      ],
      { cwd: ROOT, env, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', reject);

    const started = Date.now();
    const tick = () => {
      if (fs.existsSync(RESULT)) {
        // 结果已落盘；子进程收尾不可靠，直接结束它
        child.kill();
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        child.kill();
        reject(new Error(`等待 Electron 闭环结果超时（${Math.round(timeoutMs / 1000)}s），且 ${RESULT} 未生成`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

interface HarnessCase {
  name: string;
  ok: boolean;
  detail: string;
}

describe('真实 Electron 主进程闭环（R1、R7、R8）', () => {
  it('使用 original-fs 的物理归档 I/O，完成 识别→应用→恢复 全链路', async () => {
    if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
      throw new Error('缺少 out/ 构建产物：请先 npm run build 再跑本用例（本用例不接受跳过）');
    }
    expect(fs.existsSync(HARNESS)).toBe(true);

    await runHarness();

    if (!fs.existsSync(RESULT)) {
      throw new Error('Electron 闭环没有产出结果文件');
    }
    const report = JSON.parse(fs.readFileSync(RESULT, 'utf8')) as {
      electron: string;
      fatal?: string;
      cases: HarnessCase[];
      failed: number;
      total: number;
    };

    // 逐条列出失败项，失败时能直接定位，而不是只看到「期望 0 实际 N」
    const failed = report.cases.filter((c) => !c.ok);
    const summary = failed.map((c) => `- ${c.name}: ${c.detail}`).join('\n');
    expect(report.total).toBeGreaterThanOrEqual(30);
    expect(summary, `Electron 闭环失败项：\n${summary}\n${report.fatal ?? ''}`).toBe('');
    expect(report.failed).toBe(0);
    expect(report.electron).toBeTruthy();
  }, 200_000);
});
