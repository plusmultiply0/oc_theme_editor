'use strict';
// Independent read-only archive comparison; never imports or runs target JS.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const mod = require('node:module');
const base = path.join(process.env.LOCALAPPDATA, 'OpenCodeThemeSwitcher/instances/a67a928b01029b5c');
const tx = JSON.parse(fs.readFileSync(path.join(base, 'transactions/op-20260911T110935948Z-k8dfu2.json'), 'utf8'));
const prior = JSON.parse(fs.readFileSync(path.join(base, 'backups/previous/meta.json'), 'utf8'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function readExact(fd, size, position) {
  const b = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const n = fs.readSync(fd, b, offset, size-offset, position+offset); if (!n) throw new Error('Unexpected physical EOF'); offset += n; }
  return b;
}
function inspect(file) {
  const bytes = fs.readFileSync(file);
  const dataStart = 8 + bytes.readUInt32LE(4);
  const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString());
  const entries = new Map(); const errors = [];
  const walk = (node, prefix='') => {
    for (const [name,e] of Object.entries(node.files || {})) {
      const rel = prefix ? prefix+'/'+name : name;
      if(e.files) { walk(e,rel); continue; }
      if(e.link) { entries.set(rel,{link:e.link}); continue; }
      let b;
      if(e.unpacked) {
        try { b = fs.readFileSync(path.join(tx.targetPath+'.unpacked',...rel.split('/'))); }
        catch(err) { errors.push({rel,error:String(err)}); continue; }
      } else {
        const start=dataStart+Number(e.offset); const end=start+Number(e.size);
        if(end>bytes.length) errors.push({rel,error:'outside archive',start,end});
        b=bytes.subarray(start,end);
      }
      const sha=hash(b); const info={size:e.size,actualSize:b.length,sha,unpacked:!!e.unpacked,offset:e.offset};
      if(e.integrity?.hash && e.integrity.hash.toLowerCase()!==sha) errors.push({rel,unpacked:!!e.unpacked,error:'header integrity mismatch',expected:e.integrity.hash,sha});
      if(rel==='package.json') info.package=JSON.parse(b.toString());
      if(rel==='node_modules/jsonfile/index.js') {
        try { new vm.Script(b.toString(),{filename:rel}); info.syntax='pass (parse only, no execution)'; }
        catch(err) { info.syntax=String(err); }
      }
      entries.set(rel,info);
    }
  };
  walk(header);
  return {file,hash:hash(bytes),size:bytes.length,dataStart,entries,errors};
}
const archives = [tx.targetPath,...prior.map(r=>r.file)].map(inspect);
const current=archives[0];
const reports=archives.map(a=>({file:a.file,hash:a.hash,size:a.size,count:a.entries.size,dataStart:a.dataStart,errors:a.errors,main:a.entries.get('out/main/index.js'),jsonfile:a.entries.get('node_modules/jsonfile/index.js'),pkg:a.entries.get('package.json')?.package && {name:a.entries.get('package.json').package.name,version:a.entries.get('package.json').package.version,main:a.entries.get('package.json').package.main}}));
const comparisons=archives.slice(1).map(a=>{
  const diffs=[];
  for(const [rel,e] of current.entries){const before=a.entries.get(rel);if(!before||e.sha!==before.sha||e.link!==before.link)diffs.push({rel,before,after:e});}
  return {against:a.file,changedCount:diffs.length,removed:[...a.entries.keys()].filter(k=>!current.entries.has(k)),diffs};
});
const result={createdAt:new Date().toISOString(),transaction:tx.operationId,expectedAfterHash:tx.afterHash,reports,comparisons};
fs.writeFileSync(path.join(__dirname,'archive-evidence.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({reports:reports.map(r=>({...r,errors:r.errors.length,packedIntegrityErrors:r.errors.filter(e=>!e.unpacked).length})),comparisons:comparisons.map(c=>({against:c.against,changed:c.diffs.map(d=>d.rel),removed:c.removed}))},null,2));
