const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher';
const mode = process.argv[3] || 'unit';
const build = '20260916114818-8b3b8f8-f4e1c6';
const args = mode === 'unit'
 ? ['node_modules/vitest/vitest.mjs','run','tests/unit/verify-release.test.ts','tests/unit/pack-worker-lifecycle.test.ts','tests/unit/smoke-packaged.test.ts','tests/unit/encoding.test.ts','--maxWorkers=1','--no-file-parallelism','--reporter=json']
 : ['tools/verify-release.cjs','--candidate-dir',`candidate-${build}/win-unpacked`,'--manifest',`candidate-${build}/candidate-manifest.json`,'--build-id',build,'--source-commit','8b3b8f88f91df20ed2438388bd7270b9b7532e69','--require-release-eligibility'];
const r = cp.spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000,windowsHide:true,maxBuffer:16*1024*1024});
fs.writeFileSync(path.join(__dirname,`${mode}.stdout.log`),r.stdout||'');
fs.writeFileSync(path.join(__dirname,`${mode}.stderr.log`),r.stderr||'');
const summary = {mode,args,status:r.status,signal:r.signal,error:r.error?.message};
if(mode==='unit' && r.stdout) {try {const j=JSON.parse(r.stdout); Object.assign(summary,{success:j.success,total:j.numTotalTests,passed:j.numPassedTests,failed:j.numFailedTests,pending:j.numPendingTests,files:j.testResults?.map(t=>({name:t.name,status:t.status}))});}catch(e){summary.reportError=e.message;}}
fs.writeFileSync(path.join(__dirname,`${mode}.summary.json`),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
if(mode!=='unit') console.log(r.stdout);
