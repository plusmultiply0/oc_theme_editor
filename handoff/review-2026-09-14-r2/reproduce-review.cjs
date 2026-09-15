'use strict';
// Diagnostic only: execute current project functions with an in-memory filesystem
// and fake child_process. Never builds, deletes files, or launches applications.
// R1–R4 (fixed 2026-09-14): all sections now assert the CORRECT behavior —
// build-record/2 holds pre-register facts only (no pending self-reference, no
// finalize rewrite); a self-shrunk required-steps set is rejected; file-level
// failures are rejected by the text fallback; strict completeness (machine
// JSON + set equality) rejects truncated suites; ensureIntegrationPrereq is
// deleted (build-first ordering) and packaging is guarded by an out snapshot
// re-check via diffOutManifest (missing/extra/changed are all fatal).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher');
const localRequire = createRequire(path.join(root, 'package.json'));
const eligibility = localRequire('./tools/release-eligibility.cjs');
const runner = localRequire('./tools/r5-run-suite.cjs');
const memory = new Map();
const commands = [];
const logs = [];
const normalize = (p) => path.resolve(String(p));
const fakeFs = {
  existsSync: (p) => memory.has(normalize(p)),
  readdirSync: () => ['main'],
  readFileSync(p, enc) {
    const k = normalize(p);
    if (!memory.has(k)) throw new Error(`Unexpected read: ${k}`);
    return enc ? String(memory.get(k)) : Buffer.from(memory.get(k));
  },
  mkdirSync() {},
  writeFileSync(p, value) { memory.set(normalize(p), String(value)); },
};
memory.set(path.join(root, 'package.json'), '{"version":"0.1.0-alpha.1"}');
memory.set(path.join(root, 'package-lock.json'), '{}');
memory.set(path.join(root, 'out'), 'directory');
// Deliberately only the marker exists; pack-worker.js does NOT exist.
memory.set(path.join(root, 'out', 'main', 'index.js'), '// old fixture output');
function loadInMemory(relative, extra = '') {
  const filename = path.join(root, relative);
  const module = { exports: {} };
  const mockedRequire = (id) => {
    if (id === 'node:fs') return fakeFs;
    if (id === 'node:child_process') return { spawnSync(...args) {
      commands.push(args);
      if (args[0] === 'git') return { status: 0, stdout: 'fixture-commit\n' };
      throw new Error('Unexpected real command attempt intercepted');
    } };
    if (id === path.join(root, 'tools', 'verify-release.cjs')) {
      return { outManifestOfDir: () => ({ files: { 'out/main/index.js': { bytes: 1, sha256: 'fixture' } } }) };
    }
    if (id.startsWith('node:')) return require(id);
    return createRequire(filename)(id);
  };
  const sandbox = {
    module, exports: module.exports, require: mockedRequire,
    Buffer, // R3 的 checkCompleteness/stripAnsi 使用 Buffer.isBuffer，vm 沙箱需注入该全局
    __dirname: path.dirname(filename), __filename: filename,
    process: { platform: process.platform, env: {}, execPath: process.execPath, pid: 123,
      exit(code) { throw new Error(`Intercepted process.exit(${code})`); } },
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\n' + extra, sandbox, { filename });
  return module.exports;
}
const build = loadInMemory('tools/release-build.cjs',
  'module.exports.probe = { writeBuildRecord };').probe;
// R1 fixed behavior: build-record/2 records pre-register facts only. With all 12
// steps passed and no injection, eligibility recomputes to true without any
// pending self-reference or post-hoc finalize rewrite.
const stepsAll12 = eligibility.RELEASE_REQUIRED_STEPS
  .map((name) => ({ name, code: 0, secs: 1 }));
const candidate = path.join(root, 'IN_MEMORY_ONLY');
const recordPath = build.writeBuildRecord(root, candidate, 'fixture-only', stepsAll12);
const record = JSON.parse(memory.get(recordPath));
const facts = eligibility.checkRecordFacts(record);
assert.equal(record.schema, 'build-record/2');
assert.ok(!record.steps.some((s) => ['register', 'verify:release'].includes(s.step)),
  'build-record/2 must not contain post-register steps');
assert.equal(facts.ok, true);
assert.equal(facts.missing.length, 0);
assert.equal(record.releaseEligible, true);
// R2 fixed behavior: a record that shrinks the required set to ['build'] is now
// rejected (the old implementation accepted exactly this shape).
const subset = eligibility.checkReleaseEligibility({ releaseEligible: true,
  releaseRequiredSteps: ['build'], steps: [{ step: 'build', status: 'passed', exit: 0 }] });
assert.equal(subset.ok, false);

// R3 fixed behavior: the text fallback is best-effort (count-only match is
// still tolerated when no machine JSON is available), BUT a file-level
// failure is now rejected, and checkStrictCompleteness (machine JSON + set
// equality) rejects the truncated suite that sample 1 pretends about.
const samples = [
  { id: 'partial-files-with-expected-count', text: ' Test Files  7 passed (15)\n Tests  84 passed (84)\n', opts: { expectedFiles: 15 }, expectOk: true },
  { id: 'skips-in-default-release-call', text: ' Test Files  1 passed (1)\n Tests  1 passed | 9 skipped (10)\n', opts: {}, expectOk: true },
  { id: 'failed-file-zero-tests', text: ' Test Files  1 failed (1)\n Tests  0 passed (0)\n', opts: {}, expectOk: false },
];
const expected15 = Array.from({ length: 15 }, (_, i) => `tests/t${i}.test.ts`);
const strictRejectsTruncated = runner.checkStrictCompleteness({
  repo: root, expected: expected15,
  result: { numTotalTests: 7, numFailedTests: 0, success: true, startTime: Date.now(),
    testResults: expected15.slice(0, 7).map((f) => ({
      name: path.join(root, f), status: 'passed', message: '',
      assertionResults: [{ fullName: 'a', status: 'passed' }],
    })) },
  expectNoSkip: true, skipAllowlist: [],
});
assert.equal(strictRejectsTruncated.ok, false);
assert.ok(strictRejectsTruncated.problems.some((p) => /未完成文件/.test(p)),
  'strict 拒绝原因应包含「未完成文件」（完成集合不相等）');
const inMemoryRunner = loadInMemory('tools/r5-run-suite.cjs');
const completeness = samples.map((s) => {
  const result = runner.checkCompleteness(s.text, s.opts);
  const wrapped = inMemoryRunner.runSuite({ repo: root, completeness: s.opts,
    spawn: () => ({ status: 0, signal: null, stdout: s.text, stderr: '' }) });
  assert.equal(result.ok, s.expectOk);
  assert.equal(wrapped.exitCode, s.expectOk ? 0 : 1);
  return { ...s, actualAccepted: result.ok, wrapperExitWithSyntheticZeroExit: wrapped.exitCode, summary: result.summary };
});
// R4 fixed behavior: ensureIntegrationPrereq (marker-only skip) is deleted.
// The chain now builds first and re-checks an out snapshot before packaging;
// diffOutManifest treats missing/extra/changed as fatal (pure function here,
// no disk access — same isolation as the rest of this diagnostic).
const verify = localRequire('./tools/verify-release.cjs');
const snap = { files: {
  'out/main/index.js': { bytes: 3, sha256: 'a' },
  'out/core/patch/pack-worker.js': { bytes: 5, sha256: 'b' },
} };
const diffChanged = verify.diffOutManifest(snap, { files: { ...snap.files, 'out/main/index.js': { bytes: 4, sha256: 'z' } } });
assert.equal(diffChanged.changed.length, 1);
const diffMissing = verify.diffOutManifest(snap, { files: { 'out/main/index.js': { bytes: 3, sha256: 'a' } } });
assert.equal(diffMissing.missing.length, 1);
const diffExtra = verify.diffOutManifest(snap, { files: { ...snap.files, 'out/extra.js': { bytes: 1, sha256: 'c' } } });
assert.equal(diffExtra.extra.length, 1);
const result = {
  kind: 'diagnostic-regression-reproduction-not-release-evidence',
  root, timestamp: new Date().toISOString(),
  isolation: 'All build writes and subprocesses mocked in memory; actual source functions executed; no app launched.',
  lifecycle: { schema: record.schema, releaseEligible: record.releaseEligible,
    factsOk: facts.ok, missingCount: facts.missing.length,
    recordCanWeakenPolicy: subset },
  completeness,
  strictCompleteness: { truncatedSuiteAccepted: strictRejectsTruncated.ok, problems: strictRejectsTruncated.problems },
  outRecheck: { changedDetected: diffChanged.changed, missingDetected: diffMissing.missing, extraDetected: diffExtra.extra },
  console: logs,
};
console.log(JSON.stringify(result, null, 2));
if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(result, null, 2), { flag: 'wx' });
