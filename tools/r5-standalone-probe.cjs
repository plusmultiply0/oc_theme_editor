/* R5 独立探针：脱离 vitest，验证 createPackageWithOptions 之后 .asar 是否被锁 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const { createPackageWithOptions } = require('@electron/asar');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-r5-standalone-'));
  const srcDir = path.join(base, '_src');
  const resources = path.join(base, 'install', 'resources');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'package.json'), '{"name":"t","version":"1.0.0","main":"./out/main/index.js"}');
  fs.mkdirSync(path.join(srcDir, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'out', 'main', 'index.js'), 'console.log(1);');

  const asar = path.join(resources, 'app.asar');
  const t0 = Date.now();
  await createPackageWithOptions(srcDir, asar, {});
  console.log(`createPackageWithOptions done in ${Date.now() - t0}ms, size=${fs.statSync(asar).size}`);

  // 对照组：普通 .tmp 文件
  const tmpFile = path.join(resources, 'plain.tmp');
  fs.writeFileSync(tmpFile, 'x');

  async function tryRename(label, file) {
    const aside = file + '.probe';
    try {
      fs.renameSync(file, aside);
      fs.renameSync(aside, file);
      console.log(`${label}: unlocked`);
      return true;
    } catch (e) {
      console.log(`${label}: LOCKED code=${e.code} ${String(e).slice(0, 120)}`);
      return false;
    }
  }

  for (let round = 0; round < 6; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 500));
    await tryRename(`round${round} asar`, asar);
    await tryRename(`round${round} tmp `, tmpFile);
  }

  // 第二次打包到同一位置（覆盖 rename 场景）
  const asar2 = path.join(resources, 'app2.asar');
  await createPackageWithOptions(srcDir, asar2, {});
  try {
    const staged = path.join(resources, 'app2.asar.ts-staged');
    fs.copyFileSync(asar2, staged);
    fs.renameSync(staged, asar2); // rename 覆盖
    console.log('rename-over existing asar: ok');
  } catch (e) {
    console.log(`rename-over existing asar: FAIL code=${e.code} ${String(e).slice(0, 120)}`);
  }

  // 清理
  try {
    fs.rmSync(base, { recursive: true, force: true });
    console.log('cleanup rmSync: ok');
  } catch (e) {
    console.log(`cleanup rmSync: FAIL code=${e.code}`);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
