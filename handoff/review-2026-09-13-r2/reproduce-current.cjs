// Read current TypeScript in memory. Write only synthetic fixtures beneath a new local directory.
// No project build, real installation write, or modification to existing evidence.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const project = path.resolve(process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher');
const req = createRequire(path.join(project, 'package.json'));
const ts = req('typescript');
const sharp = req('sharp');
require.extensions['.ts'] = (mod, file) => {
  if (!file.startsWith(project + path.sep)) throw new Error('Unexpected TypeScript path');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  mod._compile(js, file);
};
const { ImageStore } = require(path.join(project, 'src/main/services/image-store.ts'));
async function main() {
  const runDir = fs.mkdtempSync(path.join(__dirname, 'isolated-'));
  const evidence = { scope: 'Current source; synthetic fixtures only', runDir };
  const png = await sharp({ create: { width: 24, height: 18, channels: 3, background: '#568abc' } }).png().toBuffer();
  const makeStore = (name) => new ImageStore({ runtimeRoot: path.join(runDir, name), picker: async () => null });
  const raceStore = makeStore('race');
  await fsp.mkdir(path.join(runDir, 'race', 'content'), { recursive: true });
  const readdir = fsp.readdir;
  let release;
  let entered;
  const blocked = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { entered = r; });
  fsp.readdir = async function (...args) {
    if (path.resolve(String(args[0])) === path.join(runDir, 'race', 'content')) {
      entered();
      await blocked; // Import registers/writes AFTER cleanOrphanCaches takes its reference snapshot.
    }
    return readdir.apply(this, args);
  };
  let imported;
  let removed;
  try {
    const cleaning = raceStore.cleanOrphanCaches([]);
    await reached;
    imported = await raceStore.importData('new.png', png);
    release();
    removed = await cleaning;
  } finally { release(); fsp.readdir = readdir; }
  if (!imported.success) throw new Error(JSON.stringify(imported));
  const rec = raceStore.peek(imported.data.imageId);
  const read = await raceStore.readBytes(rec.imageId);
  evidence.cleanupRace = {
    imported: true, removed, contentExists: fs.existsSync(rec.copyPath),
    thumbnailExists: fs.existsSync(rec.thumbnailPath), readSuccess: read.success,
    readError: read.success ? null : read.error.code,
  };

  const thumbStore = makeStore('thumb');
  const ti = await thumbStore.importData('good.png', png);
  if (!ti.success) throw new Error(JSON.stringify(ti));
  const tr = thumbStore.peek(ti.data.imageId);
  fs.writeFileSync(tr.thumbnailPath, png.subarray(0, 16));
  const preview = await thumbStore.previewDataUrl(tr.imageId);
  let decodable = false;
  if (preview.success) {
    try { await sharp(Buffer.from(preview.data.split(',')[1], 'base64')).raw().toBuffer(); decodable = true; } catch {}
  }
  evidence.truncatedThumbnail = {
    previewSuccess: preview.success, returnedImageDecodable: decodable,
    thumbnailBytesAfterPreview: fs.statSync(tr.thumbnailPath).size,
    privateCopyHealthy: (await thumbStore.readBytes(tr.imageId)).success,
  };

  // Execute the actual wrapper with in-process mocks; suppress its fixed-path evidence writes.
  const stub = `const fs=require('node:fs');fs.mkdirSync=()=>{};fs.writeFileSync=()=>{};` +
    `require('node:child_process').spawnSync=()=>({status:23,signal:null,stdout:'MOCK_TEST_FAILED',stderr:''});` +
    `require(${JSON.stringify(path.join(project, 'tools/r5-run-suite.cjs'))});`;
  const wrapper = spawnSync(process.execPath, ['-e', stub], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  evidence.testWrapper = { childStatusInjected: 23, wrapperStatus: wrapper.status, output: wrapper.stdout };

  const gate = fs.readFileSync(path.join(project, 'tools/release-gate.sh'), 'utf8');
  const gateLog = path.join(runDir, 'mock-gate.log').replace(/\\/g, '/');
  const adjusted = gate.replace(/^cd .*$/m, ': # isolated cwd').replace(/^LOG=.*$/m, `LOG='${gateLog}'`);
  if (adjusted === gate) throw new Error('Gate isolation failed');
  const g = spawnSync('D:/SOFTWARE/Git/bin/bash.exe', ['--noprofile', '--norc', '-s'], {
    input: 'unset GATE_CANDIDATE_DIR\nnpm() { echo "MOCK $*"; if [ "$*" = "run dist" ]; then return 17; fi; return 0; }\n' + adjusted,
    cwd: runDir, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  evidence.distFailurePropagation = { status: g.status, allGreen: g.stdout.includes('ALL_GREEN'), output: g.stdout };

  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'candidate-manifest.json'), 'utf8'));
  const entry = 'out/main/services/image-store.js';
  const archiveBytes = fs.readFileSync(path.join(project, manifest.candidateDir, 'resources/app.asar'));
  const header = JSON.parse(archiveBytes.subarray(16, 16 + archiveBytes.readUInt32LE(12)).toString());
  let node = header;
  for (const part of entry.split('/')) node = node.files[part];
  const offset = 8 + archiveBytes.readUInt32LE(4) + Number(node.offset);
  const archived = archiveBytes.subarray(offset, offset + node.size).toString();
  const current = fs.readFileSync(path.join(project, 'src/main/services/image-store.ts'), 'utf8');
  evidence.candidate = { sourceCommit: manifest.sourceCommit, buildId: manifest.buildId,
    sourceHasKeepContentIds: current.includes('keepContentIds'), packageHasKeepContentIds: archived.includes('keepContentIds'),
    sourceHasReadThumbnail: current.includes('readThumbnail'), packageHasReadThumbnail: archived.includes('readThumbnail') };
  console.log(JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(runDir, 'reproductions.json'), JSON.stringify(evidence, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
