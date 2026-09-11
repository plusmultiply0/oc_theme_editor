/**
 * 只读诊断：本机环境下 Electron 能否真的创建窗口并渲染页面。
 * 结果落 tools/window-probe-result.json。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const OUT = path.join(__dirname, 'window-probe-result.json');
const result = { electron: process.versions.electron, steps: [] };
const step = (name, ok, detail) => {
  result.steps.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
};

app.whenReady().then(async () => {
  try {
    step('app ready', true, app.getPath('userData'));
    const win = new BrowserWindow({
      width: 900,
      height: 600,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    step('BrowserWindow 创建', true, String(win.id));

    const html = path.join(__dirname, '..', 'out', 'renderer', 'index.html');
    step('renderer 产物存在', fs.existsSync(html), html);
    await win.loadFile(html);
    step('loadFile 完成', true);

    await new Promise((r) => setTimeout(r, 1500));
    const title = await win.webContents.executeJavaScript('document.title');
    step('executeJavaScript 可用', true, `title=${title}`);
    const hasApi = await win.webContents.executeJavaScript('typeof window.themeSwitcher');
    step('preload 桥接已注入', hasApi === 'object', String(hasApi));
    const rootText = await win.webContents.executeJavaScript(
      'document.querySelector(".topbar h1") ? document.querySelector(".topbar h1").textContent : "(no h1)"',
    );
    step('页面已渲染应用界面', typeof rootText === 'string' && rootText.includes('换肤'), rootText);

    const shot = path.join(__dirname, 'window-probe.png');
    const img = await win.webContents.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    step('截图成功', fs.existsSync(shot), shot);

    win.destroy();
  } catch (e) {
    step('异常', false, String(e && e.stack ? e.stack : e));
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('WINDOW_PROBE_DONE');
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
