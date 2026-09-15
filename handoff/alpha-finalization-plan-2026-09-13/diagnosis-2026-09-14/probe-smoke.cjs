// Mock-only execution of the CURRENT smoke script; does not launch Electron or touch installs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const project = process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher';
const req = createRequire(path.join(project, 'package.json'));
const ts = req('typescript');
const file = path.join(project, 'tools/smoke-packaged.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
async function scenario(throwText) {
  const logs = [];
  const exits = [];
  const win = {
    waitForLoadState: async () => {},
    title: async () => '',
    locator: () => ({ innerText: async () => { if (throwText) throw new Error('mock renderer unavailable'); return ''; } }),
  };
  const context = {
    exports: {},
    require: (id) => id === 'playwright'
      ? { _electron: { launch: async () => ({ firstWindow: async () => win, close: async () => {} }) } }
      : id === 'node:path' ? path : (() => { throw new Error('Unexpected import: ' + id); })(),
    process: { argv: ['node', file, 'synthetic-not-a-real-candidate'], env: {}, exit: (code) => exits.push(code) },
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
  };
  vm.runInNewContext(code, context, { filename: file, timeout: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  return { mockOnly: true, throwText, exits, smokeOk: logs.includes('SMOKE_OK'), logs };
}
(async () => {
  const evidence = { scenarios: [await scenario(false), await scenario(true)] };
  console.log(JSON.stringify(evidence, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; });
