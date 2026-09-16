'use strict';
// Pure state-machine probes: transpile current TS in memory, use fake process,
// archive library and child process. No real ASAR operation, spawn or deletion.
//
// N1 修复（错峰并发）之后，本脚本对归档窗口部分改为断言**修复后的正确行为**：
// 独立调用必须排队，结束时不得泄漏 noAsar。N2（worker 异步 error 无监听）尚未修复，
// 仍以「复现缺陷」的形式断言，故该段的存在是预期内的。
// 历史说明：修复前 exit 0 = 成功复现 N1+N2；现在 N1 段落应全部通过，
// 脚本整体退出码由尚未修复的 N2 决定。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
// 修复后 archive-io 用 AsyncLocalStorage 建立「窗口所有权」上下文；
// 内存沙箱必须放行这个内建模块，否则模块加载就失败（见 load 的 require 白名单）。
const asyncHooks = require('node:async_hooks');
const root = path.resolve(process.argv[2]);
const requireProject = createRequire(path.join(root, 'package.json'));
const ts = requireProject('typescript');
const sourceHashes = {};
function load(rel, overrides, fakeProcess) {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  sourceHashes[rel] = crypto.createHash('sha256').update(source).digest('hex');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports,
    require(id) { if (Object.hasOwn(overrides, id)) return overrides[id]; throw new Error(`Unexpected import ${id}`); },
    process: fakeProcess, __dirname: path.dirname(file), console, Buffer, setTimeout, clearTimeout }, { filename: file });
  return module.exports;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
(async () => {
  const fakeProcess = { noAsar: false, versions: { electron: 'simulated' } };
  const archive = load('src/core/patch/archive-io.ts', { '@electron/asar': {}, 'node:async_hooks': asyncHooks }, fakeProcess);
  const aStarted = deferred(), aRelease = deferred(), bRelease = deferred();
  const timeline = [];
  const a = archive.withArchiveIoIn('independent-A', async () => {
    timeline.push('A enters'); aStarted.resolve(); await aRelease.promise;
    timeline.push('A completes');
  }, { toggleNoAsar: true });
  await aStarted.promise;
  // This call originates from outside A's callback, after A is already awaiting.
  const b = archive.withArchiveIoIn('independent-B', async () => {
    timeline.push('B enters while A is still open'); await bRelease.promise;
    timeline.push(`B completes with noAsar=${archive.archiveIoNoAsarOpen()}`);
  }, { toggleNoAsar: true });
  const enteredConcurrently = archive.archiveIoDepth() === 2;
  aRelease.resolve(); await a;
  const noAsarWhileBActive = archive.archiveIoNoAsarOpen();
  bRelease.resolve(); await b;
  const after = { depth: archive.archiveIoDepth(), noAsar: archive.archiveIoNoAsarOpen() };
  // N1 修复后的正确行为：B 必须排队等 A 退出，不能叠进 A 的窗口。
  // 注意此处 A 结束时 B 已获准进入（串行化），因此此刻开关为 true 是**正确的**：
  // 这是 B 自己的窗口，不是 A 泄漏下来的状态。真正的判据是「全部结束后零泄漏」。
  assert.equal(enteredConcurrently, false, 'N1：独立调用不得与 A 并发进入窗口');
  assert.equal(noAsarWhileBActive, true, 'N1：A 退出后应轮到 B 的窗口');
  assert.equal(after.depth, 0, 'N1：所有任务结束后 depth 归零');
  assert.equal(after.noAsar, false, 'N1：不得把 noAsar 泄漏为 true');
  assert.equal(archive.archiveIoActiveWindows(), 0, 'N1：不得残留有效窗口令牌');
  // 时间线必须严格串行：A 退出早于 B 进入
  assert.ok(
    timeline.indexOf('A completes') < timeline.indexOf('B enters while A is still open'),
    `N1：时间线必须串行，实际 ${JSON.stringify(timeline)}`,
  );

  let fakeChild;
  const children = [];
  const fakeFork = () => {
    fakeChild = new EventEmitter(); fakeChild.send = () => {};
    fakeChild.kill = () => { fakeChild.killCalled = true; return true; };
    children.push(fakeChild); return fakeChild;
  };
  const pack = load('src/core/patch/pack.ts', {
    'node:child_process': { fork: fakeFork }, 'node:fs': { existsSync: () => true }, 'node:path': path,
    '../../shared/errors': { ok: data => ({ success: true, data }),
      fail: (code, message, recoveryHint, detail) => ({ success: false, error: { code, message, recoveryHint, detail } }) },
  }, { versions: {}, env: {}, cwd: () => root });
  const job = { appDir: 'IN_MEMORY_ONLY', stagedArchive: 'IN_MEMORY_ONLY', files: [] };
  const pending = pack.packArchiveInWorker(job, { workerPath: 'FAKE_WORKER', timeoutMs: 1000 });
  const child = fakeChild;
  const errorListeners = child.listenerCount('error');
  let escapedError;
  try { child.emit('error', Object.assign(new Error('fixture async spawn EAGAIN'), { code: 'EAGAIN' })); }
  catch (e) { escapedError = e.message; }
  child.emit('exit', 1); await pending; // finish fake lifecycle and clear timer
  assert.equal(errorListeners, 0); assert.match(escapedError, /EAGAIN/);
  const successful = pack.packArchiveInWorker(job, { workerPath: 'FAKE_WORKER', timeoutMs: 1000 });
  fakeChild.emit('message', { ok: true });
  const success = await successful;
  assert.equal(success.success, true);
  const results = { kind: 'in-memory-current-source-probes-not-real-runtime-test', root,
    timestamp: new Date().toISOString(), sourceHashes,
    archiveConcurrency: { enteredConcurrently, noAsarWhileBActive, finalState: after, timeline },
    workerAsyncError: { errorListeners, escapedError },
    workerSuccessLifecycle: { resolvedBeforeExitEvent: true, killCalledOnSuccess: Boolean(fakeChild.killCalled),
      note: 'Confirmed ordering only; not proof that this caused the historical file locks.' },
  };
  console.log(JSON.stringify(results, null, 2));
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(results, null, 2), { flag: 'wx' });
})().catch(e => { console.error(e); process.exitCode = 1; });
