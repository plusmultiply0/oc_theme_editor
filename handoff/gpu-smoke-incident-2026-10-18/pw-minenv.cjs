/* 最小环境对照：白名单变量启动 Playwright 探针 */
const { _electron: electron } = require('playwright');
const exe = 'D:\\zjcfile\\weblearn\\other\\oc_theme_editor\\node_modules\\electron\\dist\\electron.exe';
process.on('uncaughtException', (e) => { console.log(`CRASH(async) ${String(e.message).slice(0, 60)}`); process.exit(2); });
(async () => {
  const keep = ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ComSpec', 'WINDIR', 'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  const app = await electron.launch({ executablePath: exe, env, args: [], timeout: 15000 });
  await new Promise((r) => setTimeout(r, 4000));
  const pages = app.context().pages().length;
  await app.close().catch(() => {});
  console.log(`MINIMAL-ENV: ALIVE pages=${pages}`);
  process.exit(0);
})().catch((e) => { console.log(`CRASH ${String(e.message).slice(0, 60)}`); process.exit(2); });
