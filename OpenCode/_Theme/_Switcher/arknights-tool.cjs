/* Scoped revision for this reviewed installation; preserves the accepted snow theme. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const asarStage = process.env.ASAR_STAGE || path.join(process.env.USERPROFILE || '', '.codex', 'skills', 'image-theme-styler', 'scripts', 'asar_stage.cjs');
const {load, pack, verify, checkFuses, sha} = require(asarStage);
const base = __dirname;
const app = process.env.OPENCODE_APP_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', '@opencode-aidesktop');
const exe = path.join(app, 'OpenCode.exe');
const target = path.join(app, 'resources/app.asar');
const sourceImage = process.env.OPENCODE_THEME_IMAGE || '';
const sourceImageBytes = () => (assert.ok(sourceImage, 'Set OPENCODE_THEME_IMAGE to the wallpaper file path.'), fs.readFileSync(sourceImage));
const sourceImageHash = '80fbd6a98935542dd2ac45bc98b2f9f1a8e40c47a76200ef29856f82742dad7b';
const expected = '55ea3a45f84edf7528ad3c3c3f11d56868a94532f75a95d6735e0d4ca72ab1d5';
const stylesheet = path.join(base, 'arknights-theme.css');
const staged = path.join(base, 'app.arknights.asar');
const record = path.join(base, 'arknights-manifest.json');
const oldRecord = path.join(base, 'backup-manifest.json');
const p = 'out/renderer/';
const digest = f => sha(fs.readFileSync(f));
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJSON = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');

function closed() {
  const query = `$ErrorActionPreference='Stop'; $all=Get-CimInstance Win32_Process; $open=$all | Where-Object { $_.ExecutablePath -eq '${exe}' -or ($_.Name -ieq 'OpenCode.exe' -and -not $_.ExecutablePath) }; if ($open) { $open | Select-Object Name,ProcessId | ConvertTo-Json -Compress; exit 9 }`;
  cp.execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',query], {windowsHide:true,stdio:'pipe'});
}
function nativeRead(file, cssHash, imageHash) {
  const bin = fs.readFileSync(exe), sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const at = bin.indexOf(sentinel) + sentinel.length;
  assert.equal(bin[at + 2], 49, 'Existing RunAsNode fuse unavailable; do not change it.');
  const code = `const fs=require('fs'),crypto=require('crypto'),assert=require('assert/strict');
    const root=${JSON.stringify(file.replaceAll('\\','/') + '/' + p)};
    const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
    const html=fs.readFileSync(root+'index.html','utf8');
    assert.equal(html.split('href="./snow-theme.css"').length-1,1);
    assert.equal(hash(fs.readFileSync(root+'snow-theme.css')),${JSON.stringify(cssHash)});
    assert.equal(hash(fs.readFileSync(root+'snow-background.jpg')),${JSON.stringify(imageHash)});
    console.log(JSON.stringify({nativeElectronRead:true}));`;
  return JSON.parse(cp.execFileSync(exe,['-e',code],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8',timeout:20000}));
}
function stage() {
  checkFuses(exe);
  assert(!fs.existsSync(record) && !fs.existsSync(staged), 'Staging already exists; inspect it first.');
  const current = load(target), prev = readJSON(oldRecord);
  assert.equal(sha(current.bytes), expected, 'Installation changed; do not overwrite.');
  assert.equal(prev.patchedHash, expected);
  assert.equal(path.resolve(prev.target), path.resolve(target));
  assert.equal(digest(prev.backup), prev.originalHash);
  assert.equal(JSON.parse(current.read('package.json')).version, '1.18.29');
  const html = current.read(p+'index.html').toString();
  assert.equal(html.split('href="./snow-theme.css"').length-1, 1);
  assert(!html.includes('image-theme.css'), 'Conflicting custom theme.');
  const css = fs.readFileSync(stylesheet), image = sourceImageBytes();
  assert.equal(sha(image),sourceImageHash);
  assert.equal(image.toString('hex',0,3),'ffd8ff');
  assert(!/@import\b/i.test(css.toString()));
  for(const m of css.toString().matchAll(/url\(\s*([^)]*)\s*\)/gi)) assert.equal(m[1].trim().replace(/^['"]|['"]$/g,''),'./snow-background.jpg');
  const changes = new Map([[p+'snow-theme.css',css],[p+'snow-background.jpg',image]]);
  fs.writeFileSync(staged,pack(current,changes),{flag:'wx'});
  const after=load(staged);
  assert.equal(current.entries.size,after.entries.size);
  const preserved=verify(current,after,changes);
  const native=nativeRead(staged,sha(css),sha(image));
  assert.equal(digest(target),expected);
  const data={status:'staged',target,exe,version:'1.18.29',expectedHash:expected,staged,patchedHash:digest(staged),imagePath:sourceImage,imageHash:sha(image),cssHash:sha(css),originalBackup:prev.backup,originalHash:prev.originalHash,preservedEntries:preserved,changedEntries:[...changes.keys()],...native};
  writeJSON(record,data);
  console.log(JSON.stringify(data,null,2));
}
function apply() {
  closed(); checkFuses(exe);
  const data=readJSON(record);
  assert.equal(data.status,'staged');
  assert.equal(data.target,target);
  assert.equal(digest(target),expected);
  assert.equal(digest(staged),data.patchedHash);
  assert.equal(sha(sourceImageBytes()),data.imageHash);
  const prevBytes=fs.readFileSync(oldRecord),prev=JSON.parse(prevBytes);
  assert.equal(prev.patchedHash,expected);
  assert.equal(digest(prev.backup),prev.originalHash);
  const dir=path.join(base,'backups','arknights-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(dir,{recursive:true});
  data.previousBackup=path.join(dir,'app.asar');
  data.previousManifest=path.join(dir,'manifest-before-update.json');
  fs.copyFileSync(target,data.previousBackup,fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(data.previousManifest,prevBytes,{flag:'wx'});
  data.previousManifestHash=sha(prevBytes);
  assert.equal(digest(data.previousBackup),expected);
  data.status='prepared'; writeJSON(record,data);
  closed(); assert.equal(digest(target),expected);
  try {
    fs.copyFileSync(staged,target);
    assert.equal(digest(target),data.patchedHash);
    nativeRead(target,data.cssHash,data.imageHash);
    prev.revisions ||= [];
    prev.revisions.push({backup:data.previousBackup,hash:expected,created:new Date().toISOString(),theme:'snowfield-v2'});
    prev.patchedHash=data.patchedHash; prev.imageHash=data.imageHash;
    prev.themeRevision=3;prev.themeName='arknights-warm-gold';prev.updated=new Date().toISOString();
    writeJSON(oldRecord,prev);
    data.status='applied';data.applied=prev.updated;writeJSON(record,data);
  } catch(e) {
    fs.copyFileSync(data.previousBackup,target);
    assert.equal(digest(target),expected,'Rollback verification failed.');
    fs.writeFileSync(oldRecord,prevBytes);
    data.status='rolled-back';data.error=e.message;writeJSON(record,data);throw e;
  }
  console.log(JSON.stringify(data,null,2));
}
function restore() {
  closed(); checkFuses(exe);
  const data=readJSON(record);
  assert.equal(data.status,'applied');
  assert.equal(data.target,target);
  assert.equal(data.expectedHash,expected);
  assert.equal(digest(target),data.patchedHash,'App was updated or modified; refusing stale restore.');
  assert.equal(digest(data.previousBackup),expected);
  assert.equal(digest(data.previousManifest),data.previousManifestHash);
  closed(); assert.equal(digest(target),data.patchedHash);
  fs.copyFileSync(data.previousBackup,target);
  assert.equal(digest(target),expected);
  fs.copyFileSync(data.previousManifest,oldRecord);
  data.status='restored-snow-theme';writeJSON(record,data);
  console.log('Accepted snow wallpaper and palette restored; original backup still retained.');
}
const action=process.argv[2];
if(action==='stage')stage();else if(action==='apply')apply();else if(action==='restore')restore();else throw new Error('Use stage|apply|restore');
