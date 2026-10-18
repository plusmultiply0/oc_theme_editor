/* 定位 Playwright 默认启动在本机崩溃的最小规避旗标（上游 electron.exe，无应用代码） */
const { _electron: electron } = require('playwright');
const exe = 'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\node_modules\\electron\\dist\\electron.exe';
const cases = [
  ['default', []],
  ['no-sandbox', ['--no-sandbox']],
  ['in-process-gpu', ['--in-process-gpu']],
  ['disable-gpu', ['--disable-gpu']],
  ['disable-gpu-sandbox', ['--disable-gpu-sandbox']],
  ['js-flags', ['--js-flags=--noexpose_wasm']],
];
(async () => {
  for (const [name, args] of cases) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let verdict;
    try {
      const app = await electron.launch({ executablePath: exe, env, args, timeout: 15000 });
      const t = setTimeout(() => verdict = 'HANG', 0);
      await new Promise((r) => setTimeout(r, 4000));
      const pages = app.context().pages().length;
      await app.close().catch(() => {});
      verdict = `ALIVE pages=${pages}`;
    } catch (e) {
      verdict = `CRASH ${String(e.message).slice(0, 80)}`;
    }
    console.log(`${name}: ${verdict}`);
  }
})();
