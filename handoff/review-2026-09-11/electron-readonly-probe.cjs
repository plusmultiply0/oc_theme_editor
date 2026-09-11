// Diagnostic only: no BrowserWindow, no target writes, no apply/precheck/restore.
const path = require('node:path');
const { app } = require('electron');
const rawFs = require('original-fs');
const wrappedFs = require('node:fs');
const project = 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher';
const install = path.join(process.env.LOCALAPPDATA, 'Programs', '@opencode-aidesktop');
const archive = path.join(install, 'resources', 'app.asar');
app.setPath('userData', path.join(__dirname, 'probe-user-data'));
const check = (fs) => {
  try { const s = fs.statSync(archive); return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size }; }
  catch (e) { return { error: String(e) }; }
};
(async () => {
  const result = { electron: process.versions.electron, node: process.versions.node,
    wrappedFs: check(wrappedFs), originalFs: check(rawFs) };
  try {
    const { inspectRoot } = require(path.join(project, 'out/core/patch/discover.js'));
    result.inspection = await inspectRoot(install);
  } catch (e) { result.inspectionError = String(e); }
  rawFs.writeFileSync(path.join(__dirname, 'electron-readonly-result.json'), JSON.stringify(result, null, 2));
  app.exit(0);
})().catch(e => {
  rawFs.writeFileSync(path.join(__dirname, 'electron-readonly-result.json'), JSON.stringify({fatal: String(e)}));
  app.exit(1);
});
