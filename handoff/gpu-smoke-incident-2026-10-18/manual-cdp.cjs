/* 手动 CDP 对照：spawn（无 Playwright）+ 内置 WebSocket 附加 + CDP 命令。
 * 判据：若沙箱渲染 + CDP 在此模式下也崩 → 机器级冲突；若不崩 → Playwright 特定。
 */
const { spawn } = require('child_process');

async function probe(name, exe, args) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  let dead = false;
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('exit', (code) => {
    dead = true;
    console.log(`--- ${name}: EXIT ${code} | ${out.slice(0, 400)}`);
  });
  // 等 DevTools 端口就绪
  await new Promise((r) => setTimeout(r, 2500));
  if (dead) return;
  try {
    const v = await fetch('http://127.0.0.1:9333/json/version').then((x) => x.json());
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = (e) => rej(new Error('ws error'));
    });
    let id = 0;
    const send = (method) => ws.send(JSON.stringify({ id: ++id, method }));
    send('Target.getTargets');
    send('Target.setDiscoverTargets');
    send('Target.setAutoAttach');
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`--- ${name}: CDP attach + 命令 OK，进程仍存活`);
    ws.close();
  } catch (e) {
    console.log(`--- ${name}: CDP 附加失败 ${e.message} | ${out.slice(0, 300)}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (!dead) {
    p.kill();
    console.log(`--- ${name}: 手动CDP模式存活（未崩）`);
  }
  await new Promise((r) => setTimeout(r, 500));
}

(async () => {
  await probe(
    'upstream-electron',
    'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\node_modules\\electron\\dist\\electron.exe',
    ['--remote-debugging-port=9333'],
  );
  await probe(
    'packaged-app',
    'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\candidate-20261018010747-d59417c-7249f5\\win-unpacked\\OpenCodeThemeSwitcher.exe',
    ['--remote-debugging-port=9333'],
  );
  process.exit(0);
})();
