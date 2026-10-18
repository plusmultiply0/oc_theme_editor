/* 细分 Playwright 的 CDP 行为：node inspector 附加 / 页面域启用，分别观察存活 */
const { spawn } = require('child_process');
const exe = 'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\candidate-20261018010747-d59417c-7249f5\\win-unpacked\\OpenCodeThemeSwitcher.exe';

function cdp(wsUrl, commands, dwellMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let i = 0;
    ws.onopen = () => {
      for (const c of commands) ws.send(JSON.stringify({ id: ++i, method: c.method, params: c.params || {} }));
      setTimeout(() => { try { ws.close(); } catch {} resolve('ok'); }, dwellMs);
    };
    ws.onerror = () => resolve('ws-error');
  });
}

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(exe, ['--inspect=0', '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let err = '';
  let dead = false;
  let inspectorUrl = null;
  p.stderr.on('data', (d) => {
    err += d;
    const m = err.match(/Debugger listening on (ws:\/\/\S+)/);
    if (m) inspectorUrl = m[1];
  });
  p.on('exit', (code) => { dead = true; console.log(`EXIT code=${code} (dead=true)`); });

  await new Promise((r) => setTimeout(r, 2500));
  console.log('step0 alive=' + !dead + ' inspector=' + inspectorUrl);

  // 步骤1：node inspector 附加 + v8 命令
  if (inspectorUrl && !dead) {
    await cdp(inspectorUrl, [{ method: 'Runtime.evaluate', params: { expression: 'process.pid' } }], 2000);
    await new Promise((r) => setTimeout(r, 800));
    console.log('step1-node-inspector alive=' + !dead);
  }

  // 步骤2：页面 target CDP 域全开（模拟 Playwright 行为）
  if (!dead) {
    const port = (err.match(/DevTools listening on ws:\/\/127[.]0[.]0[.]1:(\d+)\//) || [])[1];
    if (port) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((x) => x.json()).catch(() => []);
      const page = list.find((t) => t.type === 'page');
      if (page) {
        await cdp(page.webSocketDebuggerUrl, [
          { method: 'Runtime.enable' }, { method: 'Page.enable' }, { method: 'DOM.enable' },
          { method: 'Runtime.evaluate', params: { expression: 'document.title' } },
        ], 2500);
        await new Promise((r) => setTimeout(r, 800));
        console.log('step2-page-domains alive=' + !dead);
      } else console.log('step2: no page target; targets=' + JSON.stringify(list.map((t) => t.type)));
    } else console.log('step2: no devtools port found');
  }

  if (!dead) { p.kill(); console.log('FINAL: alive（未复现崩溃）'); }
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
})();
