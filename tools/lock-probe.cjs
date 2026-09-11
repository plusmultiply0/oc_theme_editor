/**
 * 只读诊断：Electron 下「重命名覆盖 app.asar」为什么会被占用。
 * 不触碰真实安装，全部在临时目录里做。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

app.disableHardwareAcceleration();

const OUT = path.join(__dirname, 'lock-probe-result.json');

function attempt(name, fn) {
  try {
    return { name, ok: true, value: fn() };
  } catch (e) {
    return { name, ok: false, error: `${e.code || e.name}: ${e.message}` };
  }
}

app.whenReady().then(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-lock-'));
  const results = { electron: process.versions.electron };

  const { createPackageWithOptions, getRawHeader, extractAll, extractFile, uncache } = require('@electron/asar');
  const physicalFs = require(path.join(__dirname, '..', 'out', 'core', 'patch', 'physical-fs'));

  // 造一个源目录
  const src = path.join(base, 'src');
  fs.mkdirSync(path.join(src, 'out/renderer'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: '@opencode-ai/desktop', version: '1.18.29' }));
  fs.writeFileSync(path.join(src, 'out/renderer/index.html'), '<html><head></head><body></body></html>');

  const target = path.join(base, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await createPackageWithOptions(src, target, {});

  const staged = path.join(base, 'staged.asar');
  fs.writeFileSync(staged, 'fake-staged-content');

  const dest = path.join(base, 'x.asar');
  fs.writeFileSync(dest, 'dest');

  results.baseline = attempt('baseline rename over .asar', () => {
    fs.renameSync(dest, target);
    return 'ok';
  });

  // 重新造一份，因为上面把它换掉了
  await createPackageWithOptions(src, target, {});
  fs.writeFileSync(dest, 'dest');

  results.afterGetRawHeader = attempt('after getRawHeader', () => {
    getRawHeader(target);
    fs.renameSync(dest, target);
    return 'ok';
  });

  await createPackageWithOptions(src, target, {});
  fs.writeFileSync(dest, 'dest');

  results.afterExtractAll = attempt('after extractAll', () => {
    extractAll(target, path.join(base, 'x'));
    fs.renameSync(dest, target);
    return 'ok';
  });

  await createPackageWithOptions(src, target, {});
  fs.writeFileSync(dest, 'dest');

  results.afterExtractFile = attempt('after extractFile', () => {
    extractFile(target, path.join('out', 'renderer', 'index.html'));
    fs.renameSync(dest, target);
    return 'ok';
  });

  await createPackageWithOptions(src, target, {});
  fs.writeFileSync(dest, 'dest');

  results.afterExtractFileThenUncache = attempt('after extractFile + uncache', () => {
    extractFile(target, path.join('out', 'renderer', 'index.html'));
    uncache(target);
    fs.renameSync(dest, target);
    return 'ok';
  });

  await createPackageWithOptions(src, target, {});
  fs.writeFileSync(dest, 'dest');

  results.originalFsRename = attempt('original-fs rename after extractFile', () => {
    extractFile(target, path.join('out', 'renderer', 'index.html'));
    physicalFs.physicalFs.renameSync(dest, target);
    return 'ok';
  });

  // 非 .asar 目标作为对照：同样的库调用之后还能不能重命名
  await createPackageWithOptions(src, target, {});
  const plain = path.join(base, 'plain.bin');
  fs.writeFileSync(plain, 'old');
  const dest2 = path.join(base, 'y.bin');
  fs.writeFileSync(dest2, 'new');
  results.plainFileAfterExtractFile = attempt('rename over non-asar after extractFile', () => {
    extractFile(target, path.join('out', 'renderer', 'index.html'));
    fs.renameSync(dest2, plain);
    return 'ok';
  });

  results.tempFileLocked = attempt('rename temp .asar over target .asar', () => {
    createPackageWithOptions(src, staged, {});
    const dest3 = path.join(base, 'z.asar');
    fs.writeFileSync(dest3, 'd');
    fs.renameSync(dest3, staged);
    return 'ok';
  });

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  console.log('LOCK_PROBE_DONE');
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 临时目录交给系统回收 */
  }
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
