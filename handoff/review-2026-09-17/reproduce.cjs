// Synthetic fixtures only. Does not extract archives, launch Electron, or alter installed apps.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {EventEmitter} = require('node:events');
const root = process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher';
const old = path.join(root,'handoff/review-2026-09-16-r2/reproduce.cjs');
const source = fs.readFileSync(old,'utf8');
const split = source.indexOf('(async()=>{');
if(split<0) throw Error('Previous fixture helper changed; inspect before reusing');
const sandbox = {require:createRequire(old),__dirname,process:{argv:['node','reproduce',root]},console,Buffer};
vm.createContext(sandbox);
vm.runInContext(source.slice(0,split)+'\nglobalThis.api={zip,check,workerScenario,run};',sandbox);
const {zip,check,workerScenario,run} = sandbox.api;
const vr = require(path.join(root,'tools/verify-release.cjs'));
const smoke = require(path.join(root,'tools/smoke-packaged.cjs'));
function inspect(file,disk) {return {deep:vr.deepVerifyZip(file),match:vr.checkZipMatchesDir(file,disk)};}
(async()=>{
 const baseline = check('baseline',[{name:'file.txt',content:'hello'}],'file.txt');
 const disk = path.join(run,'baseline');
 const oversizedComment = zip([{name:'file.txt',content:'hello'}],'oversized-comment');
 const bad = fs.readFileSync(oversizedComment); const central = bad.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 bad.writeUInt16LE(65535,central+32); fs.writeFileSync(oversizedComment,bad);
 const missingDescriptor = zip([{name:'file.txt',content:'hello'}],'missing-descriptor');
 const desc = fs.readFileSync(missingDescriptor); const cd=desc.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 desc.writeUInt16LE(8,6); desc.writeUInt16LE(8,cd+8); desc.fill(0,14,26); fs.writeFileSync(missingDescriptor,desc);
 const conflict=zip([{name:'a',content:'hello'},{name:'A/file.txt',content:'hello'}],'implicit-case-conflict');
 const page=new EventEmitter();
 page.waitForLoadState=async()=>{};page.title=async()=> 'OpenCode 换肤助手';
 page.locator=(selector)=>({innerText:async()=>selector==='body'?'OpenCode 换肤助手 应用到 OpenCode '.repeat(5):'OpenCode 换肤助手'});
 page.getByRole=()=>({first:()=>({isVisible:async()=>true})});
 // Event before observe attaches listeners is intentionally lost, despite a healthy-looking DOM.
 page.emit('pageerror',new Error('early initialization failure'));
 const early=await smoke.observe(page);
 const earlyJudge=smoke.judge(early);
 page.emit('pageerror',new Error('late initialization failure'));
 const lateJudge=smoke.judge(early);
 const results={baseline,
  fixedWindowsDir:check('windows-dir',[{name:'resources\\'},{name:'resources\\file.txt',content:'hello'}],'resources/file.txt'),
  fixedCorruptDeflate:check('bad-deflate',[{name:'file.txt',content:'hello',method:8,corrupt:true}],'file.txt'),
  fixedAlias:check('alias',[{name:'a/file.txt',content:'hello'},{name:'a\\file.txt',content:'hello'}],'a/file.txt'),
  fixedWorkerNonzero:await workerScenario('nonzero-exit'),fixedWorkerKillThrows:await workerScenario('no-exit'),
  oversizedCentralComment:inspect(oversizedComment,disk),missingDataDescriptor:inspect(missingDescriptor,disk),
  implicitParentCaseConflictDeep:vr.deepVerifyZip(conflict),
  smokeMissedEarlyError:{judgeBeforeLateError:earlyJudge,judgeAfterLateError:lateJudge},
  smokeDefaultQualification:smoke.judgeReleaseQualification({args:smoke.DEFAULT_ARGS}),smokeDefaultArgs:smoke.DEFAULT_ARGS,
  playwrightVersion:require(path.join(root,'node_modules/playwright-core/package.json')).version,
  note:'Playwright auto no-sandbox branch is Linux-only in local coreBundle.js; do not attribute it to this Windows candidate.'};
 fs.writeFileSync(path.join(__dirname,'reproduction-results.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify({run,...results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
