/**
 * 截图用的 Electron 主进程脚本：起真实应用、喂一张渐变图，然后把窗口截下来。
 * 由 tools/capture-ui.cjs 以隔离环境变量启动；只在临时目录里操作。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const WORK = process.env.OTS_CAPTURE_WORK;
const OUT = process.env.OTS_CAPTURE_OUT;

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

function write(p, c) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}

/** 一张冷色渐变图，比纯色更能看出半透明面板与文字的实际观感 */
async function makeWallpaper(file) {
  const W = 720;
  const H = 480;
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const t = (x / W) * 0.6 + (y / H) * 0.4;
      const i = (y * W + x) * 3;
      buf[i] = Math.round(26 + t * 120);
      buf[i + 1] = Math.round(36 + t * 96);
      buf[i + 2] = Math.round(58 + t * 140);
    }
  }
  const sharp = require('sharp');
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
}

async function makeSyntheticInstall() {
  const src = path.join(WORK, '_src');
  write(
    path.join(src, 'package.json'),
    JSON.stringify({ name: '@opencode-ai/desktop', version: '1.18.29', main: './out/main/index.js' }, null, 2),
  );
  write(path.join(src, 'out/main/index.js'), 'console.log(1);');
  write(path.join(src, 'out/renderer/index.html'), LEGACY_HTML);
  write(path.join(src, 'out/renderer/snow-theme.css'), 'html, body, #root { --snow-primary: #a0a7c9; --background-base: #404558; }');
  write(path.join(src, 'out/renderer/assets/main-fixture.css'), ':root{--x:1}');
  write(path.join(src, 'node_modules/native/x.node'), 'native-binary');

  const installRoot = path.join(process.env.LOCALAPPDATA, 'Programs', '@opencode-aidesktop');
  fs.mkdirSync(path.join(installRoot, 'resources'), { recursive: true });
  write(path.join(installRoot, 'OpenCode.exe'), 'MZ-placeholder');

  const { createPackageWithOptions } = require('@electron/asar');
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    await createPackageWithOptions(src, path.join(installRoot, 'resources', 'app.asar'), { unpack: '*.node' });
  } finally {
    process.noAsar = prev;
  }
}

/** 生成截图对应的界面：走真实的拖拽导入路径 */
async function drive(wc, wallpaper) {
  const bytes = Array.from(fs.readFileSync(wallpaper));
  await wc.executeJavaScript(
    `(async () => {
       const dt = new DataTransfer();
       dt.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})], 'wallpaper.png', { type: 'image/png' }));
       const zone = document.querySelector('.dropzone');
       zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
       zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
       return true;
     })()`,
    true,
  );
  const deadline = Date.now() + 30000;
  for (;;) {
    const ready = await wc.executeJavaScript("!!document.querySelector('.preview .mock-window')", true);
    if (ready) break;
    if (Date.now() > deadline) throw new Error('等待预览超时');
    await new Promise((r) => setTimeout(r, 200));
  }
  // 给字体与缩略图一点时间
  await new Promise((r) => setTimeout(r, 800));
}

app.whenReady().then(async () => {
  await makeSyntheticInstall();
  const wallpaper = path.join(WORK, 'wallpaper.png');
  await makeWallpaper(wallpaper);

  // 载入真实应用主进程：它会自己建窗口、注册 IPC
  require(path.join(ROOT, 'out', 'main', 'index.js'));

  const win = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const tick = () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) return resolve(w);
      if (Date.now() > deadline) return reject(new Error('应用没有创建窗口'));
      setTimeout(tick, 150);
    };
    tick();
  });

  win.setSize(1440, 920);
  // 等界面完成首次目标检测，再做隔离保险
  let target = '';
  const tDeadline = Date.now() + 20000;
  for (;;) {
    target = await win.webContents.executeJavaScript(
      "document.querySelector('.target .muted') ? document.querySelector('.target .muted').textContent : ''",
      true,
    );
    if (target && target !== '未发现目标') break;
    if (Date.now() > tDeadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!target || !target.toLowerCase().includes(String(process.env.LOCALAPPDATA).toLowerCase())) {
    throw new Error(`隔离检查失败：界面选中的目标不是临时目录 → ${target || '（空）'}`);
  }

  await drive(win.webContents, wallpaper);
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  console.log(`CAPTURE_OK ${OUT}`);
  process.exit(0);
}).catch((e) => {
  console.error('CAPTURE_FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});

app.on('window-all-closed', () => app.exit(0));
