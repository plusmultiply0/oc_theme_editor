// Read-only production source loading; writes synthetic fixtures only beside this script.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher';
const verify = require(path.join(root, 'tools/verify-release.cjs'));
const run = fs.mkdtempSync(path.join(__dirname, 'fixtures-'));
function zip(entries, name) {
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const n = Buffer.from(e.name), content = Buffer.from(e.content || '');
    const method = e.method || 0;
    const body = method === 8 ? (e.corrupt ? Buffer.from([7, 0, 0]) : zlib.deflateRawSync(content)) : content;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4);
    l.writeUInt16LE(method, 8); l.writeUInt32LE(verify.crc32(content), 14);
    l.writeUInt32LE(body.length, 18); l.writeUInt32LE(content.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(method, 10); c.writeUInt32LE(verify.crc32(content), 16);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(content.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, body); centrals.push(c, n); offset += l.length + n.length + body.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  const file = path.join(run, name + '.zip'); fs.writeFileSync(file, Buffer.concat([...locals, central, end])); return file;
}
function check(name, entries, diskName) {
  const file = zip(entries, name), disk = path.join(run, name);
  fs.mkdirSync(path.dirname(path.join(disk, diskName)), {recursive:true});
  fs.writeFileSync(path.join(disk, diskName), 'hello');
  return { match: verify.checkZipMatchesDir(file, disk), deep: verify.deepVerifyZip(file) };
}
async function workerScenario(kind) {
  const ts = require(path.join(root, 'node_modules/typescript'));
  const source = fs.readFileSync(path.join(root, 'src/core/patch/pack.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true}}).outputText;
  const module = {exports:{}}; const timers = []; const listeners = {}; let kills = 0;
  vm.runInNewContext(compiled, {module, exports:module.exports, __dirname:root, process:{versions:{},env:{}}, Date,
    require(name) { if (name === '../../shared/errors') return {ok:()=>({success:true}),fail:(code,message)=>({success:false,error:{code,message}})}; if(name === 'electron') throw Error('not Electron'); return require(name); },
    setTimeout(fn, ms){const t={fn,ms,active:true,unref(){}};timers.push(t);return t;}, clearTimeout(t){t.active=false;}
  });
  const promise = module.exports.packArchiveInWorker({appDir:run, stagedArchive:path.join(run,'unused.asar'),files:[]}, {workerPath:'unused-worker.js', forkOverride:()=>({
    onMessage(fn){listeners.message=fn;},onExit(fn){listeners.exit=fn;},onError(fn){listeners.error=fn;},postMessage(){},kill(){kills++;throw Error('kill refused');}
  })});
  listeners.message({ok:true});
  if (kind === 'nonzero-exit') listeners.exit(1);
  else timers.find(t=>t.active && t.ms===30000).fn();
  return {result:await promise,kills,exitEmitted:kind==='nonzero-exit'};
}
(async()=>{
 const results = {
  sourceSha256: Object.fromEntries(['tools/verify-release.cjs','src/core/patch/pack.ts'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')])),
  windowsDirectory:check('windows-directory',[{name:'resources\\'},{name:'resources\\file.txt',content:'hello'}],'resources/file.txt'),
  corruptDeflate:check('corrupt-deflate',[{name:'file.txt',content:'hello',method:8,corrupt:true}],'file.txt'),
  duplicateAlias:check('duplicate-alias',[{name:'a/b.txt',content:'hello'},{name:'a\\b.txt',content:'hello'}],'a/b.txt'),
  traversalDeep:verify.deepVerifyZip(zip([{name:'..\\escape.txt',content:'hello'}],'traversal')),
  workerNonzero:await workerScenario('nonzero-exit'),workerNoExitKillThrows:await workerScenario('no-exit')
 };
 try { zlib.inflateRawSync(Buffer.from([7,0,0])); results.inflateControl='unexpected success'; } catch(e){ results.inflateControl=e.code; }
 fs.writeFileSync(path.join(run,'results.json'),JSON.stringify(results,null,2)); console.log(JSON.stringify({run,...results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
