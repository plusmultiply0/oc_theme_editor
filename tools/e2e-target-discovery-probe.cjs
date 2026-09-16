/**
 * 探针 2：在真实 Electron 里判定「未发现目标」的成因。
 *
 * 假说：e2e 的合成安装落在 os.tmpdir() 之下，而链上 testEnv() 把 TEMP/TMP
 * 重定向到一个深层 runDir。Electron 主进程启动时若目标发现发生在窗口首次渲染前、
 * 或 discovery 中的 realpath/stat 走到被重定向的 TEMP，就会认不出合成安装。
 *
 * 本探针只做一件事：用 Playwright 启动 app，读取界面上 .target 区域的文本，
 * 并把关键环境打印出来。不改动任何被测代码。
 *
 * 用法：node tools/e2e-target-discovery-probe.cjs
 */
/* eslint-disable no-console */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const { _electron: electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const { createPackageWithOptions } = require(require.resolve('@electron/asar', { paths: [ROOT] }));

  // 链上 testEnv() 的重定向：把 TEMP/TMP 指到一个深层 runDir（与发布链行为一致）
  const chainRunDir = process.env.PROBE_RUN_DIR || path.join(os.tmpdir(), `ots-probe-chain-${process.pid}`);
  fs.mkdirSync(chainRunDir, { recursive: true });

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-probe-gui-'));
  const localAppData = path.join(baseDir, 'localappdata');
  const runtimeDir = path.join(baseDir, 'runtime');
  fs.mkdirSync(localAppData, { recursive: true });

  const src = path.join(baseDir, '_src');
  const writeFile = (p, c) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  };
  writeFile(
    path.join(src, 'package.json'),
    JSON.stringify({ name: '@opencode-ai/desktop', version: '1.18.29', main: './out/main/index.js' }, null, 2),
  );
  writeFile(path.join(src, 'out/main/index.js'), 'console.log(1);');
  writeFile(path.join(src, 'out/renderer/index.html'), '<html><body>probe</body></html>');
  const installRoot = path.join(localAppData, 'Programs', '@opencode-aidesktop');
  const archivePath = path.join(installRoot, 'resources', 'app.asar');
  writeFile(path.join(installRoot, 'OpenCode.exe'), 'MZ-placeholder');

  const prev = process.noAsar;
  process.noAsar = true;
  try {
    await createPackageWithOptions(src, archivePath, { unpack: '*.node' });
  } finally {
    process.noAsar = prev;
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.LOCALAPPDATA = localAppData;
  env.THEME_SWITCHER_DATA_DIR = runtimeDir;
  env.THEME_SWITCHER_NO_REGISTRY = '1';
  if (process.env.PROBE_CHAIN_TEMP === '1') {
    env.TEMP = chainRunDir;
    env.TMP = chainRunDir;
  }

  console.log('baseDir   =', baseDir);
  console.log('TEMP      =', env.TEMP);
  console.log('TMP       =', env.TMP);
  console.log('chainTemp =', process.env.PROBE_CHAIN_TEMP === '1' ? 'ON' : 'off');
  console.log('install   =', installRoot, fs.existsSync(archivePath) ? '(archive OK)' : '(archive MISSING)');

  const app = await electron.launch({
    cwd: ROOT,
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
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);

  const targetText = await page.locator('.target').innerText().catch((e) => `ERR ${e.message}`);
  const statusText = await page.locator('.status').innerText().catch(() => '');
  console.log('--- 界面 .target ---');
  console.log(targetText);
  console.log('--- 界面 .status ---');
  console.log(statusText);

  await app.close();
}

main().catch((e) => {
  console.error('PROBE_ERROR', e);
  process.exit(1);
});
