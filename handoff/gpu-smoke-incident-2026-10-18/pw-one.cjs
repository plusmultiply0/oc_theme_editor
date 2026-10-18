/* 单旗标单进程：node pw-one.cjs <name> [args...] */
const { _electron: electron } = require('playwright');
const exe = 'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\node_modules\\electron\\dist\\electron.exe';
const name = process.argv[2];
const args = process.argv.slice(3);
process.on('uncaughtException', (e) => { console.log(`${name}: CRASH(async) ${String(e.message).slice(0, 60)}`); process.exit(2); });
(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const app = await electron.launch({ executablePath: exe, env, args, timeout: 15000 });
  await new Promise((r) => setTimeout(r, 4000));
  const pages = app.context().pages().length;
  await app.close().catch(() => {});
  console.log(`${name}: ALIVE pages=${pages}`);
  process.exit(0);
})().catch((e) => { console.log(`${name}: CRASH ${String(e.message).slice(0, 60)}`); process.exit(2); });
