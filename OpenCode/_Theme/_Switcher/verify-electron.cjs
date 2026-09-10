const cp = require('node:child_process');
const path = require('node:path');
const app = process.env.OPENCODE_APP_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', '@opencode-aidesktop');
const root = path.join(app, 'resources/app.asar/out/renderer/');
const code = `
const fs = require('fs');
const crypto = require('crypto');
const root = ${JSON.stringify(root)};
const html = fs.readFileSync(root + 'index.html', 'utf8');
if (!html.includes('snow-theme.css')) process.exit(2);
const css = fs.readFileSync(root + 'snow-theme.css', 'utf8');
const img = fs.readFileSync(root + 'snow-background.jpg');
console.log(JSON.stringify({ electronArchiveRead: true, stylesheetBytes: css.length, imageBytes: img.length, imageHash: crypto.createHash('sha256').update(img).digest('hex') }));
`;
console.log(cp.execFileSync(path.join(app, 'OpenCode.exe'), ['-e', code], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 20000,
}));
