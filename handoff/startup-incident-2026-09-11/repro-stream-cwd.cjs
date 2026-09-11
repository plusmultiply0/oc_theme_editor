'use strict';
// Isolated generated archive only. Never reads or writes an OpenCode installation.
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const projectRequire=require('node:module').createRequire('D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/package.json');
const asar=projectRequire('@electron/asar');
(async()=>{
  process.chdir(path.join(__dirname,'fixture-cwd'));
  const sources={'a.js':Buffer.from("module.exports = 'AAA';\n"),'b.js':Buffer.from("module.exports = 'BBB';\n")};
  const entries=Object.entries(sources).map(([rel,b])=>({path:rel,type:'file',unpacked:false,stat:{size:b.length,mode:0o100644},streamGenerator:()=>Readable.from([b])}));
  const archive=path.join(__dirname,'fixture-stream-cwd.asar');
  await asar.createPackageFromStreams(archive,entries);
  const raw=fs.readFileSync(archive); const start=8+raw.readUInt32LE(4);
  const h=JSON.parse(raw.subarray(16,16+raw.readUInt32LE(12)).toString());
  const files=Object.entries(sources).map(([rel,b])=>{const e=h.files[rel];const actual=raw.subarray(start+Number(e.offset),start+Number(e.offset)+e.size);return {rel,offset:e.offset,expected:b.toString(),actual:actual.toString(),same:b.equals(actual)};});
  const result={library:'@electron/asar 4.3.0 (installed copy)',sameCwdContents:true,differentStreamContents:true,files,bugReproduced:files.some(f=>!f.same)};
  fs.writeFileSync(path.join(__dirname,'stream-cwd-evidence.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
