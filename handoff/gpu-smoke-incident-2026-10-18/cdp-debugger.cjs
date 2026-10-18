/* 复刻 Playwright 的 node inspector 用法：Debugger.enable 长驻 + page 会话并发 */
const { spawn } = require('child_process');
const exe = 'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\candidate-20261018010747-d59417c-7249f5\\win-unpacked\\OpenCodeThemeSwitcher.exe';

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(exe, ['--inspect=0', '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let err = '';
  let dead = false;
  p.stderr.on('data', (d) => (err += d));
  p.on('exit', (code) => { dead = true; console.log(`EXIT code=${code}`); });
  await new Promise((r) => setTimeout(r, 2500));
  if (dead) { console.log('died before attach'); process.exit(0); }

  const insp = err.match(/Debugger listening on (ws:\/\/\S+)/);
  const port = (err.match(/DevTools listening on ws:\/\/127[.]0[.]0[.]1:(\d+)\//) || [])[1];

  // node inspector：Debugger.enable（Playwright 关键差异点）
  let ws1 = null;
  if (insp) {
    ws1 = new WebSocket(insp[1]);
    ws1.onopen = () => {
      ws1.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws1.send(JSON.stringify({ id: 2, method: 'Debugger.enable' }));
    };
    ws1.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 2) {
        // Debugger.enable 成功后像在 Electron 主进程内求值
        ws1.send(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: 'process.versions.electron' } }));
      }
    };
  }

  // page 会话并发
  let ws2 = null;
  if (port) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((x) => x.json()).catch(() => []);
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws2 = new WebSocket(page.webSocketDebuggerUrl);
      ws2.onopen = () => {
        ws2.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        ws2.send(JSON.stringify({ id: 2, method: 'Page.enable' }));
      };
    }
  }

  for (let t = 1; t <= 6 && !dead; t++) {
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`t=${t}s alive=${!dead}`);
  }
  try { ws1 && ws1.close(); } catch {}
  try { ws2 && ws2.close(); } catch {}
  if (!dead) { p.kill(); console.log('FINAL alive'); }
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
})();
