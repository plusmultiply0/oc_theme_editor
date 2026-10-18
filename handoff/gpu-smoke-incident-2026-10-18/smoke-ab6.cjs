const { spawn } = require('child_process');
const exe = 'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\candidate-20261018010747-d59417c-7249f5\\win-unpacked\\OpenCodeThemeSwitcher.exe';
function run(name, args, attach) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let dead = false;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => {
      dead = true;
      resolve(`--- ${name}: exit=${code}\n${out.slice(0, 1200)}`);
    });
    setTimeout(async () => {
      if (dead) return;
      if (attach) {
        const re = new RegExp('Debugger listening on ws://127[.]0[.]0[.]1:(\\d+)/(\\S+)');
        const m = out.match(re);
        if (m) {
          try {
            const WebSocket = require('ws');
            const ws = new WebSocket(`ws://127.0.0.1:${m[1]}/${m[2]}`);
            await new Promise((res, rej) => {
              ws.on('open', res);
              ws.on('error', rej);
            });
            out += '\n[attached node inspector]';
          } catch (e) {
            out += `\n[attach fail ${e.message}]`;
          }
        } else {
          out += '\n[no inspector ws found]';
        }
      }
      setTimeout(() => {
        if (!dead) {
          p.kill();
          resolve(`--- ${name}: ALIVE\n${out.slice(0, 1200)}`);
        }
      }, 5000);
    }, 3000);
  });
}
(async () => {
  console.log(await run('both-flags-no-attach', ['--inspect=0', '--remote-debugging-port=0'], false));
  console.log(await run('both-flags-attach-inspector', ['--inspect=0', '--remote-debugging-port=0'], true));
})();
