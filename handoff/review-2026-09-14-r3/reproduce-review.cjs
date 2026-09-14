'use strict';
// Review fixtures only. Never launches the fake exe, builds the project, deletes
// files, or changes an installation. Real register/verify CLIs are exercised.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const project = path.resolve(process.argv[2]);
const req = createRequire(path.join(project, 'package.json'));
const vr = req('./tools/verify-release.cjs');
const rb = req('./tools/release-build.cjs');
const suite = req('./tools/r5-run-suite.cjs');
const eligibility = req('./tools/release-eligibility.cjs');
const evidenceDir = fs.mkdtempSync(path.join(__dirname, 'evidence-run-'));
const root = path.join(evidenceDir, 'fixture');
fs.mkdirSync(root);
function write(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function git(args) {
  const r = cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function cli(name, args, logName) {
  const r = cp.spawnSync(process.execPath, [path.join(project, 'tools', name), '--root', root, ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  write(path.join(evidenceDir, logName + '.log'), `status=${r.status}\n${r.stdout}\n${r.stderr}`);
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
}
function zipStore(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const n = Buffer.from(name); const crc = vr.crc32(body);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, body); centrals.push(central, n); offset += local.length + n.length + body.length;
  }
  const c = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, c, end]);
}
(async () => {
  if (process.env.OTS_STEP_STUB || process.env.OTS_NODE_BIN) throw new Error('Unexpected injected environment; stop, do not clear it');
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'review-fixture', version: '0.1.0-alpha.1' }));
  write(path.join(root, 'package-lock.json'), '{}');
  write(path.join(root, '.gitignore'), 'out/\ncandidate-*/\ncandidate-*.zip\n');
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Review Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture only']);
  const commit = git(['rev-parse', 'HEAD']);
  const cand = path.join(root, 'candidate-renamed');
  const unpacked = path.join(cand, 'win-unpacked');
  const modulePaths = ['out/main/index.js', ...vr.REQUIRED_MODULES];
  for (const rel of modulePaths) { write(path.join(root, rel), '// synthetic fixture\n'); write(path.join(cand, 'stage', rel), '// synthetic fixture\n'); }
  const exe = path.join(unpacked, 'OpenCodeThemeSwitcher.exe');
  const asar = path.join(unpacked, 'resources', 'app.asar');
  write(exe, 'FAKE EXE - NEVER EXECUTE'); fs.mkdirSync(path.dirname(asar), { recursive: true });
  await req('@electron/asar').createPackage(path.join(cand, 'stage'), asar);
  const zip = path.join(root, 'candidate-renamed.zip');
  write(zip, zipStore({ 'OpenCodeThemeSwitcher.exe': fs.readFileSync(exe), 'resources/app.asar': fs.readFileSync(asar) }));
  // NOTE (2026-09-15): this script originally asserted the DEFECT behavior. After
  // S1–S5 landed the same inputs now have the CORRECT expectations below; the
  // fixture inputs are unchanged, only the assertions were flipped.
  const record = rb.writeBuildRecord(root, cand, 'original-build', eligibility.RELEASE_REQUIRED_STEPS.map(name => ({ name, code: 0, secs: 1 })));
  const manifest = path.join(cand, 'candidate-manifest.json');
  // candidate-manifest command requires subcommand before options.
  const register = (extra) => cp.spawnSync(process.execPath, [path.join(project, 'tools/candidate-manifest.cjs'), 'register', '--root', root,
    '--manifest', manifest, '--candidate-dir', unpacked, '--build-record', record, '--zip', zip, ...extra],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });

  // S1: record=A，显式 --build-id=B → **登记阶段即拒绝**（修复后预期）
  const regMismatch = register(['--build-id', 'renamed-build', '--pack-method', 'electron-builder']);
  write(path.join(evidenceDir, 'register-mismatched-build-id.log'), `status=${regMismatch.status}\n${regMismatch.stdout}\n${regMismatch.stderr}`);
  assert.notEqual(regMismatch.status, 0, 'S1 修复：record 与显式 buildId 不一致必须拒绝登记');
  assert.match(regMismatch.stdout + regMismatch.stderr, /不一致/, '点名身份不一致');

  // S5: 打包方式必须显式声明（不再有 manual-repack 兜底默认）
  const regNoMethod = register(['--build-id', 'original-build']);
  write(path.join(evidenceDir, 'register-without-pack-method.log'), `status=${regNoMethod.status}\n${regNoMethod.stdout}\n${regNoMethod.stderr}`);
  assert.notEqual(regNoMethod.status, 0, 'S5 修复：缺 --pack-method 必须拒绝登记');
  assert.match(regNoMethod.stdout + regNoMethod.stderr, /--pack-method/, '点名 --pack-method');

  // 正例：身份一致 + 显式打包方式 → 登记成功
  const reg = register(['--build-id', 'original-build', '--pack-method', 'electron-builder']);
  write(path.join(evidenceDir, 'register.log'), `status=${reg.status}\n${reg.stdout}\n${reg.stderr}`);
  assert.equal(reg.status, 0, reg.stderr);
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(m.packMethod, 'electron-builder', 'S5：正常 builder 链登记为 electron-builder');

  const args = ['--manifest', manifest, '--candidate-dir', unpacked, '--build-id', 'original-build'];
  // S2: core 只给阶段性结论，不得出现发布级成功标记
  const core = cli('verify-release.cjs', args, 'core-without-receipt');
  assert.equal(core.exit, 0, core.stdout + core.stderr);
  assert.match(core.stdout, /CORE_VERIFY_GREEN/, 'core 打印 CORE_VERIFY_GREEN');
  assert.doesNotMatch(core.stdout, /RELEASE_GREEN/, 'S2：core 不得打印发布级 RELEASE_GREEN');
  assert.match(core.stdout, /stage=core publishable=false/, 'core 输出结构化阶段标记');
  const missingReceipt = cli('verify-release.cjs', [...args, '--require-release-eligibility'], 'full-without-receipt');
  assert.notEqual(missingReceipt.exit, 0, '缺完成回执 → 发布级拒绝');
  rb.writeReleaseReceipt(cand, 'original-build', commit, manifest, record);
  const full = cli('verify-release.cjs', [...args, '--require-release-eligibility'], 'full-bound-receipt');
  assert.equal(full.exit, 0, full.stdout + full.stderr);
  assert.match(full.stdout, /RELEASE_GREEN/, '身份一致的完整绑定 → 发布级通过');
  // Machine-result parser: corrupt/absent assertions must FAIL closed (S3).
  const malformed = suite.checkStrictCompleteness({ repo: project, expected: ['tests/unit/theme.test.ts'],
    result: { success: true, numTotalTests: 0, numFailedTests: 0,
      testResults: [{ name: path.join(project, 'tests/unit/theme.test.ts'), status: 'passed' }] } });
  assert.equal(malformed.ok, false, 'S3：畸形机器报告必须失败关闭');
  // Argument rewriting is observed through a fake collector process, not executed.
  let listArgs;
  suite.collectExpectedFiles({ repo: project, vitestArgs: ['run', 'tests/unit/theme.test.ts', '--reporter', 'dot', '--outputFile.json', 'my-report.json'],
    env: {}, spawn: (_cmd, args) => { listArgs = args; return { status: 0, stdout: path.join(project, 'tests/unit/theme.test.ts'), stderr: '' }; } });
  assert.ok(!listArgs.includes('dot') && !listArgs.includes('my-report.json'),
    `S4：两段式报告参数的值不得成为过滤条件（实际 ${JSON.stringify(listArgs)}）`);
  const result = { kind: 'synthetic-review-fixture-not-release-evidence', project, evidenceDir,
    assertionMode: 'post-fix (S1-S5): correct behavior, not defect reproduction',
    sourceHashes: Object.fromEntries(['release-build.cjs','r5-run-suite.cjs','release-eligibility.cjs','verify-release.cjs','candidate-manifest.cjs','release-gate.sh'].map(n =>
      [n, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(project, 'tools', n))).digest('hex')])),
    identity: { recordBuildId: JSON.parse(fs.readFileSync(record, 'utf8')).buildId, manifestBuildId: m.buildId,
      mismatchedRegisterExit: regMismatch.status, registerExit: reg.status, fullVerifyExit: full.exit },
    stageMarker: { coreWithoutReceiptExit: core.exit, corePrintsCoreGreen: /CORE_VERIFY_GREEN/.test(core.stdout),
      corePrintsReleaseGreen: /RELEASE_GREEN/.test(core.stdout), finalWithoutReceiptExit: missingReceipt.exit },
    malformedMachineResultRejected: !malformed.ok, collectorStripsOptionValues: listArgs,
    registration: { packMethod: m.packMethod, reproducibleBuild: m.reproducibleBuild,
      requiresExplicitPackMethod: regNoMethod.status !== 0 },
  };
  write(path.join(evidenceDir, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
