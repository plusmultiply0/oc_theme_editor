/* R5 第二轮：区分锁触发条件——扩展名 / 目录 / 时间线 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPackageWithOptions } = require('@electron/asar');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkSrc(base) {
  const srcDir = path.join(base, '_src');
  fs.mkdirSync(path.join(srcDir, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'package.json'), '{"name":"t","version":"1.0.0","main":"./out/main/index.js"}');
  fs.writeFileSync(path.join(srcDir, 'out', 'main', 'index.js'), 'console.log(1);');
  return srcDir;
}

async function tryRename(file) {
  const aside = file + '.probe';
  try {
    fs.renameSync(file, aside);
    fs.renameSync(aside, file);
    return 'unlocked';
  } catch (e) {
    return `LOCKED(${e.code})`;
  }
}

async function timeline(label, file, checkpoints) {
  const results = {};
  for (const ms of checkpoints) {
    if (ms > 0) await sleep(ms - checkpoints[checkpoints.indexOf(ms) - 1] || ms);
    results[`t+${ms}ms`] = await tryRename(file);
  }
  console.log(`${label}: ${JSON.stringify(results)}`);
}

async function main() {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-r5-2-'));
  const dBase = 'D:\\ots-r5-probe-' + Date.now();
  fs.mkdirSync(dBase, { recursive: true });
  const srcT = mkSrc(tempBase);
  const srcD = mkSrc(dBase);

  // 4 个文件同时创建，然后并行走时间线
  const jobs = [
    ['TEMP .asar', path.join(tempBase, 'a.asar'), srcT],
    ['TEMP .bin ', path.join(tempBase, 'b.bin'), srcT],
    ['TEMP .zip ', path.join(tempBase, 'c.zip'), srcT],
    ['D:\\  .asar', path.join(dBase, 'd.asar'), srcD],
  ];
  for (const [, file, src] of jobs) {
    await createPackageWithOptions(src, file, {});
  }

  const checkpoints = [0, 1000, 3000, 6000];
  await Promise.all(
    jobs.map(async ([label, file]) => {
      const results = {};
      let prev = 0;
      for (const ms of checkpoints) {
        if (ms - prev) await sleep(ms - prev);
        prev = ms;
        results[`t+${ms}ms`] = await tryRename(file);
      }
      console.log(`${label}: ${JSON.stringify(results)}`);
    }),
  );

  // 10 秒后最终状态 + 删除测试
  await sleep(4000);
  for (const [label, file] of jobs) {
    const st = await tryRename(file);
    let rm = 'ok';
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      rm = `FAIL(${e.code})`;
    }
    console.log(`final ${label}: rename=${st} rmSync=${rm}`);
  }

  try {
    fs.rmSync(tempBase, { recursive: true, force: true });
    console.log('cleanup TEMP base: ok');
  } catch (e) {
    console.log(`cleanup TEMP base: FAIL(${e.code})`);
  }
  try {
    fs.rmSync(dBase, { recursive: true, force: true });
    console.log('cleanup D base: ok');
  } catch (e) {
    console.log(`cleanup D base: FAIL(${e.code})`);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
