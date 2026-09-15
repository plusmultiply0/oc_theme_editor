// Isolated reproductions. Only this directory's newly-created fixture files are mutated.
// No real npm build, install, application launch, or source modification occurs.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const project = 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher';
const r = createRequire(path.join(project, 'package.json'));
const sharp = r('sharp');
const { ImageStore } = require(path.join(project, 'out/main/services/image-store.js'));
async function main() {
  const runDir = fs.mkdtempSync(path.join(__dirname, 'isolated-'));
  const evidence = { scope: 'Synthetic fixtures only; no real build or installation writes', runDir };
  const originalGate = fs.readFileSync(path.join(project, 'tools/release-gate.sh'), 'utf8');
  const log = path.join(runDir, 'mock-gate.log').replace(/\\/g, '/');
  const adjusted = originalGate.replace(/^cd .*$/m, ': # stay in isolated cwd').replace(/^LOG=.*$/m, `LOG='${log}'`);
  if (adjusted === originalGate || adjusted.includes('LOG=/tmp/a4-gate.txt')) throw new Error('Isolation patch failed');
  const mock = 'npm() { if [ "$*" = "run dist" ]; then echo MOCK_DIST_FAILED; return 17; fi; echo "MOCK_NPM $*"; return 0; }\n';
  const gate = spawnSync('D:/SOFTWARE/Git/bin/bash.exe', ['--noprofile', '--norc', '-s'], {
    input: mock + adjusted, cwd: runDir, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  evidence.releaseGate = { status: gate.status, stdout: gate.stdout, stderr: gate.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null };
  const png = await sharp({ create: { width: 24, height: 18, channels: 3, background: '#568abc' } }).png().toBuffer();
  const store = new ImageStore({ runtimeRoot: runDir, picker: async () => null, limits: { maxBytes: 4096, maxPixels: 40000000 } });
  const imported = await store.importData('fixture.png', png);
  if (!imported.success) throw new Error(JSON.stringify(imported));
  const record = store.peek(imported.data.imageId);
  const before = await store.previewDataUrl(record.imageId);
  const removed = await store.cleanOrphanCaches([record.imageId]);
  const after = await store.previewDataUrl(record.imageId);
  evidence.thumbnailCleanup = {
    imageId: record.imageId, thumbnailId: record.thumbnailId, beforeSuccess: before.success,
    removed, contentExists: fs.existsSync(record.copyPath), thumbnailExists: fs.existsSync(record.thumbnailPath),
    afterSuccess: after.success, afterError: after.success ? null : after.error,
  };
  // Bounded 64KiB tamper fixture: prove readBytes reads more than its configured 4KiB cap.
  fs.writeFileSync(record.copyPath, Buffer.alloc(65536, 65));
  const originalReadFile = fsp.readFile; let observed = 0;
  fsp.readFile = async function (...args) { const out = await originalReadFile.apply(this, args); if (String(args[0]) === record.copyPath) observed = out.length; return out; };
  try {
    const read = await store.readBytes(record.imageId);
    evidence.uncappedRead = { configuredMax: 4096, actualReadBytes: observed, success: read.success, error: read.success ? null : read.error.code };
  } finally { fsp.readFile = originalReadFile; }
  evidence.assertions = {
    failedDistReportedAllGreen: gate.status === 0 && gate.stdout.includes('EXIT dist = 17') && gate.stdout.includes('ALL_GREEN'),
    referencedThumbnailDeleted: before.success && removed > 0 && !after.success && fs.existsSync(record.copyPath),
    cachedReadExceedsLimitBeforeRejection: observed > 4096,
  };
  fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(evidence, null, 2));
  if (Object.values(evidence.assertions).some(x => !x)) process.exitCode = 2;
}
const timeout = setTimeout(() => { console.error('Reproduction timed out'); process.exit(3); }, 55000);
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
