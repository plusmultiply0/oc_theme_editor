/**
 * 真实 GUI 闭环测试（T56、R6、R8）。
 *
 * 与 tools/electron-fixture-e2e.cjs 的分工：
 * - 那边验的是「主进程 + 事务逻辑在 Electron 的 fs 语义下站得住」；
 * - 这里验的是「窗口真的起来了、按钮状态真的跟后端一致、点下去真的改了安装」。
 *
 * 三条硬要求：
 * 1. **只看得见合成安装**：把 LOCALAPPDATA 指到临时目录并关掉注册表扫描，
 *    开工前还会断言选中的目标路径落在临时目录内 —— 一旦不满足就立刻失败，
 *    绝不冒险点到用户的真实安装。
 * 2. **不用「强行启用按钮」蒙过去**：禁用状态与禁用原因都要断言。
 * 3. 结束时无论成败都关闭应用并清理临时目录。
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createPackageWithOptions, extractFile, uncache } from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** 1x1 PNG：走真实的导入 IPC，不依赖任何外部素材 */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const LEGACY_CSS = [
  'html, body, #root {',
  '  --snow-primary: #a0a7c9;',
  '  --background-base: #404558;',
  '}',
].join('\n');

const LEGACY_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>OpenCode</title>',
  '    <link rel="stylesheet" href="./assets/main-fixture.css">',
  '    <link rel="stylesheet" href="./snow-theme.css" data-local-theme="snowfield">',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
  '',
].join('\n');

let app: ElectronApplication;
let page: Page;
let baseDir: string;
let installRoot: string;
let archivePath: string;
let runtimeDir: string;
let localAppData: string;

function writeFile(p: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** 构造一份「已装过原型时代雪景主题」的合成安装 */
async function createSyntheticInstall(): Promise<void> {
  const src = path.join(baseDir, '_src');
  writeFile(
    path.join(src, 'package.json'),
    JSON.stringify({ name: '@opencode-ai/desktop', version: '1.18.29', main: './out/main/index.js' }, null, 2),
  );
  writeFile(path.join(src, 'out/main/index.js'), 'console.log(1);');
  writeFile(path.join(src, 'out/renderer/index.html'), LEGACY_HTML);
  writeFile(path.join(src, 'out/renderer/snow-theme.css'), LEGACY_CSS);
  writeFile(path.join(src, 'out/renderer/snow-background.jpg'), 'fake-jpg');
  writeFile(path.join(src, 'out/renderer/assets/main-fixture.css'), ':root{--x:1}');
  writeFile(path.join(src, 'node_modules/native/x.node'), 'native-binary');

  installRoot = path.join(localAppData, 'Programs', '@opencode-aidesktop');
  fs.mkdirSync(path.join(installRoot, 'resources'), { recursive: true });
  archivePath = path.join(installRoot, 'resources', 'app.asar');
  writeFile(path.join(installRoot, 'OpenCode.exe'), 'MZ-placeholder');

  // 打包时也临时关掉 asar 解释：包装 fs 会把归档路径注册进 Electron 的
  // 进程级 asar 缓存并长期持有句柄，导致之后 rename 覆盖失败（真机表现为 FILE_LOCKED）
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    await createPackageWithOptions(src, archivePath, { unpack: '*.node' });
  } finally {
    process.noAsar = prev;
  }
}

function readInstalledHtml(): string {
  uncache(archivePath);
  return extractFile(archivePath, 'out/renderer/index.html'.split('/').join(path.sep)).toString('utf8');
}

test.beforeAll(async () => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-gui-'));
  localAppData = path.join(baseDir, 'localappdata');
  runtimeDir = path.join(baseDir, 'runtime');
  fs.mkdirSync(localAppData, { recursive: true });
  await createSyntheticInstall();

  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('缺少 out/ 构建产物：请先 npm run build 再跑 E2E');
  }

  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  env.LOCALAPPDATA = localAppData;
  env.THEME_SWITCHER_DATA_DIR = runtimeDir;
  // 关掉注册表扫描：合成测试绝不允许看到机器上真实安装的 OpenCode
  env.THEME_SWITCHER_NO_REGISTRY = '1';

  app = await electron.launch({
    cwd: ROOT,
    /*
     * 复审 R5/R6：这组安全降级开关只用于**自动化诊断**——无显示会话下 Electron 的
     * GPU 子进程会反复重启、拖住进程（见 docs/acceptance.md 6.1）。
     * 它**不是**产品验收证据：候选包默认配置（保留沙箱）的启动验收在
     * tools/smoke-packaged.cjs，不能用这里的绿色结果替代。
     */
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--disable-dev-shm-usage',
      '.',
    ],
    env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  try {
    await app?.close();
  } catch {
    /* 关闭失败不影响判定 */
  }
  try {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    console.log(`CLEANUP_WARN ${baseDir} 未删除（临时目录由系统回收）`);
  }
});

/**
 * 走真实的拖拽导入路径选图（renderer 只交出文件内容，不交路径），
 * 然后等界面自己完成取色与生成。
 */
async function setImageByDragAndDrop(): Promise<void> {
  const dataTransfer = await page.evaluateHandle((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'e2e.png', { type: 'image/png' }));
    return dt;
  }, Array.from(ONE_PX_PNG));

  await page.dispatchEvent('.dropzone', 'dragover', { dataTransfer });
  await page.dispatchEvent('.dropzone', 'drop', { dataTransfer });
  await page.waitForSelector('.preview .mock-window', { timeout: 30_000 });
}

/**
 * 按标题精确锁定侧栏面板（仅「恢复」选项卡激活时可见）。
 * 不能用 `filter({ hasText: '目标' })`：可读性面板里「全部条目达到目标值」也含「目标」，
 * 结果会选中错的面板。
 */
function panelWithHeading(name: string) {
  return page.locator('.side-column .panel').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

/** 切到右栏「恢复」选项卡（目标/待恢复/恢复三块自 U-重整 T2 起在此页内） */
async function openRestoreTab(): Promise<void> {
  const tab = page.getByRole('tab', { name: '恢复' });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * R6：目标等待超时时收集可诊断证据（扫描状态、目标区各段文本、期望路径）。
 * 目的是让「发现失败」和「界面没渲染」区分得开，而不是只给一句超时。
 */
async function collectDiscoveryDiagnostics(): Promise<Record<string, string>> {
  const read = async (selector: string): Promise<string> => {
    const text = await page
      .locator(selector)
      .first()
      .innerText()
      .catch(() => '(读取失败)');
    return text.trim().slice(0, 400);
  };
  return {
    status: await read('.status'),
    target: await read('.target'),
    targetMuted: await read('.target .muted'),
    targetBadge: await read('.target .badge'),
    expectedBaseDir: baseDir,
  };
}

test.describe('图形界面闭环（先不碰用户安装）', () => {
  test('窗口与渲染进程启动，且只看到临时目录里的合成安装', async ({}, testInfo) => {
    await expect(page.locator('.topbar h1')).toHaveText('OpenCode 换肤助手');

    /*
     * R6：目标发现走异步 IPC（discoverTargets），标题出现 ≠ 扫描结束。
     * 旧写法是「标题一出现就 innerText() 快照 + 普通 expect(string)」——静态文本断言
     * 不会自动重试，首用例可能撞上扫描尚未完成的窗口期（已有一次首用例失败、后续
     * 成功的记录与之吻合）。这里改用有界自动重试的轮询断言（取规范化文本以兼容
     * 路径大小写），并在超时时把可诊断证据落进报告；不是「加固定 sleep」或
     * 「重试到绿」。
     * U-重整 T1 后 installPath 可见文本单行截断，全文改由 title 属性承载——断言跟
     * 着改读 title。
     */
    const targetChip = page.locator('.target .muted');
    const chipTitle = async () => ((await targetChip.getAttribute('title')) ?? '').toLowerCase();
    try {
      await expect.poll(chipTitle, {
        timeout: 30_000,
        message: `等待目标发现完成（应显示隔离临时目录 ${baseDir}）`,
      }).toContain(baseDir.toLowerCase());
    } catch (e) {
      const diagnostics = await collectDiscoveryDiagnostics();
      await testInfo.attach('discover-timeout.json', {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: 'application/json',
      });
      const shot = await page.screenshot().catch(() => null);
      if (shot) await testInfo.attach('discover-timeout.png', { body: shot, contentType: 'image/png' });
      throw new Error(`等待目标路径超时：${JSON.stringify(diagnostics)}（原始错误：${(e as Error).message}）`);
    }

    // 发现完成后才断言徽标与包名；隔离保险：路径必须落在临时目录内
    await expect(page.locator('.target .badge')).toHaveText('supported', { timeout: 30_000 });
    const installText = await chipTitle();
    expect(installText).toContain(baseDir.toLowerCase());
    expect(installText).toContain('@opencode-aidesktop');
  });

  test('未选图片时应用按钮禁用，且给出可行动的禁用原因（不是强行启用）', async () => {
    const apply = page.getByRole('button', { name: '应用到 OpenCode' });
    await expect(apply).toBeDisabled();
    await expect(page.locator('.status')).toContainText('请选择一张本地图片');
    await expect(page.locator('.controls .scope').last()).toBeVisible();
  });

  test('导入图片后生成配色、可读性报告通过，应用按钮才变为可用', async () => {
    await setImageByDragAndDrop();

    // 配色与预览同源
    await expect(page.locator('.preview .mock-window')).toBeVisible();
    await expect(page.locator('.preview-note')).toContainText('同一份 token');

    const report = page.locator('.side-column .panel').first();
    await expect(report).toContainText('可读性检查');
    await expect(report).toContainText('估算');
    await expect(report).toContainText('余量最差');
    // U-重整 T3：24 行明细默认折叠进「明细与判定依据」——展开后再断言逐条内容
    await report.locator('details.scan-details > summary').click();
    await expect(page.locator('.entries li').first()).toBeVisible();
    // R4：覆盖了非 default 状态与多点采样
    await expect(report).toContainText('（hover）');
    await expect(report).toContainText('（pressed）');
    await expect(report).toContainText('点');

    await expect(page.getByRole('button', { name: '应用到 OpenCode' })).toBeEnabled();
  });

  test('应用前必须在确认框里看到会撤下的旧主题层，确认后安装真的被改写', async () => {
    const before = readInstalledHtml();
    expect(before).toContain('snow-theme.css');

    await page.getByRole('button', { name: '应用到 OpenCode' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('确认应用到 OpenCode');
    await expect(dialog).toContainText('旧主题层');
    await expect(dialog).toContainText('snow-theme.css');
    await expect(dialog).toContainText('原型时代注入的本地主题');

    await page.getByRole('button', { name: '确认应用' }).click();
    await expect(page.locator('.status')).toContainText('已应用', { timeout: 60_000 });

    const after = readInstalledHtml();
    expect(after).not.toContain('snow-theme.css');
    expect(after).toContain('oc-theme-custom.css');
  });

  test('恢复面板区分「原版」与「首次接管快照」，无出厂证据时不给恢复原版按钮', async () => {
    await openRestoreTab();
    const restore = panelWithHeading('恢复');
    await expect(restore).toContainText('首次接管快照');
    // U-重整 T4：出厂指纹长说明收进折叠「说明」，可见处是一行摘要
    await expect(restore).toContainText('没有可证明的出厂原版 —— 用首次接管快照');
    await expect(restore.getByRole('button', { name: '恢复原版' })).toHaveCount(0);
    await expect(restore.getByRole('button', { name: '恢复到首次接管时' })).toBeVisible();
  });

  test('恢复到首次接管快照后，旧主题链接回到 HTML', async () => {
    await openRestoreTab();
    const restore = panelWithHeading('恢复');
    await restore.getByRole('button', { name: '恢复到首次接管时' }).click();
    await expect(page.locator('.status')).toContainText('首次接管时的状态', { timeout: 60_000 });
    expect(readInstalledHtml()).toContain('snow-theme.css');
  });

  test('「重新检测」与「选择安装目录」入口存在，检测失败时不是死路（R6）', async () => {
    await openRestoreTab();
    const target = panelWithHeading('目标');
    await expect(target.getByRole('button', { name: '重新检测' })).toBeVisible();
    await expect(target.getByRole('button', { name: '选择安装目录' })).toBeVisible();

    await target.getByRole('button', { name: '重新检测' }).click();
    // 重新检测后仍应认出同一个合成目标，且不弹错误（T1 后全文在 title 里）
    await expect
      .poll(async () => ((await page.locator('.target .muted').getAttribute('title')) ?? '').toLowerCase())
      .toContain('@opencode-aidesktop');
    await expect(page.locator('.status')).not.toContainText('未发现');
  });

  test('待恢复区在无未完成事务时明确说明「没有」，不冒充有', async () => {
    await openRestoreTab();
    // U-重整 T4：空态从整块面板压缩为一行
    await expect(page.locator('.recovery-empty')).toContainText('没有未完成的操作');
    await expect(panelWithHeading('待恢复')).toHaveCount(0);
  });
});
