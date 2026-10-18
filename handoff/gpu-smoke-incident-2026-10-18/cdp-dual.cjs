/* 双会话并发保持：node inspector(Runtime.enable) + page(Runtime.enable/DOM/Page)，dwell 6s */
const { spawn } = require('child_process');
const exe = 'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\candidate-20261018010747-d59417c-7249f5\\win-unpacked\\OpenCodeThemeSwitcher.exe';

function openCdp(wsUrl, commands) {
  const ws = new WebSocket(wsUrl);
  let i = 0;
  ws.onopen = () => { for (const c of commands) ws.send(JSON.stringify({ id: ++i, method: c.method, params: c.params || {} })); };
  return ws;
}

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

  const ws1 = insp ? openCdp(insp[1], [
    { method: 'Runtime.enable' },
    { method: 'Runtime.evaluate', params: { expression: 'process.versions.electron' } },
  ]) : null;

  let ws2 = null;
  if (port) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((x) => x.json()).catch(() => []);
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws2 = openCdp(page.webSocketDebuggerUrl, [
        { method: 'Runtime.enable' }, { method: 'Page.enable' }, { method: 'DOM.enable' },
        { method: 'Runtime.evaluate', params: { expression: 'document.title' } },
      ]);
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
