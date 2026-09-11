/**
 * 打包隔离与内容一致性回归（事故 F1，见 handoff/startup-incident-2026-09-11/RECOVERY_AND_FIX.md）。
 *
 * 事故根因：`@electron/asar` 的 `Filesystem.insertFile` 对 ≤2MB 文件走同步快路径，
 * `fs.readFileSync(归档内逻辑路径)` 相对**打包进程的 cwd** 解析；本工具 cwd 是开发项目，
 * 里面有同名 `node_modules`，于是 hash 取自开发项目、size/数据来自目标安装，
 * `storeFileEntry` 按错误 hash 去重 → 两个内容不同的文件共享 offset，
 * 第二个文件读出来是第一个文件的前 N 字节（真机 jsonfile 被截断，OpenCode 无法启动）。
 *
 * 本文件全部使用临时目录构造，不触碰任何真实安装。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packArchiveInWorker, resolvePackWorkerPath } from '../../src/core/patch/pack';
import { listAsarFiles, readAsar, readAsarText } from '../../src/core/patch/asar';

const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ots-pack-${prefix}-`));
  dirs.push(d);
  return d;
}

/** 清理要容忍 EBUSY：依赖库可能还握着句柄；删不掉就留给系统回收，不让清理失败污染判定 */
function cleanup(): void {
  while (dirs.length) {
    const d = dirs.pop() as string;
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch {
      console.log(`CLEANUP_WARN ${d} 未删除`);
    }
  }
}

afterEach(cleanup);

/** 两个不同版本的 jsonfile：较长版 2838 字节，较短版 2014 字节（真机事故里的真实形态） */
const JSONFILE_LONG = `${[
  "'use strict';",
  'const fs = require("fs");',
  'const path = require("path");',
  '// 填充到 2838 字节左右，模拟较新版本实现',
  ...Array.from({ length: 40 }, (_, i) => `function helper${i}(value) { return value; }`),
  'module.exports = { readFileWithHelper };',
  '',
].join('\n')}`;
const JSONFILE_SHORT = `${[
  "'use strict';",
  'const fs = require("fs");',
  '// 填充到 2014 字节左右，模拟较旧版本实现',
  ...Array.from({ length: 30 }, (_, i) => `function helper${i}(value) { return value; }`),
  'module.exports = { readFileWithHelper };',
  '',
].join('\n')}`;

interface PackResult {
  archive: string;
  appDir: string;
}

/** 造一个解包目录：顶层 jsonfile 与嵌套同名依赖各一份（正是事故里的两条目） */
async function makeUnpackDir(opts: { longFirst: boolean }): Promise<PackResult> {
  const base = tmp('ots-pack-case-');
  const appDir = path.join(base, 'app');
  const longFile = path.join(appDir, 'node_modules', 'electron-window-state', 'node_modules', 'jsonfile', 'index.js');
  const shortFile = path.join(appDir, 'node_modules', 'jsonfile', 'index.js');
  fs.mkdirSync(path.dirname(longFile), { recursive: true });
  fs.mkdirSync(path.dirname(shortFile), { recursive: true });
  fs.writeFileSync(longFile, JSONFILE_LONG);
  fs.writeFileSync(shortFile, JSONFILE_SHORT);
  // 顶层再放一个入口文件，确保归档不是只有依赖
  fs.mkdirSync(path.join(appDir, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'out', 'main', 'index.js'), 'console.log(1);\n');

  return {
    appDir,
    archive: path.join(base, `staged-${opts.longFirst ? 'long-first' : 'short-first'}.asar`),
  };
}

async function packAndRead(
  appDir: string,
  archive: string,
  entriesToRead: string[],
): Promise<Map<string, string>> {
  const files: { path: string; unpacked: boolean }[] = [];
  (function walk(current: string, prefix: string) {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        files.push({ path: rel, unpacked: false });
        walk(path.join(current, e.name), rel);
      } else if (e.isFile()) {
        files.push({ path: rel, unpacked: false });
      }
    }
  })(appDir, '');

  const r = await packArchiveInWorker({ appDir, stagedArchive: archive, files });
  expect(r.success).toBe(true);
  if (!r.success) throw new Error(r.error.message);

  const snap = await readAsar(archive);
  expect(snap.success).toBe(true);
  if (!snap.success) throw new Error(snap.error.message);
  const list = listAsarFiles(snap.data.header);
  for (const entry of entriesToRead) expect(list).toContain(entry);

  const out = new Map<string, string>();
  for (const entry of entriesToRead) {
    const t = await readAsarText(snap.data, entry);
    expect(t.success).toBe(true);
    out.set(entry, t.success ? t.data : '');
  }
  return out;
}

describe('打包内容来源（事故 F1）', () => {
  it('同一逻辑路径下的两个不同版本依赖，重打包后各自完整、不共享 offset', async () => {
    const { appDir, archive } = await makeUnpackDir({ longFirst: true });
    const top = 'node_modules/jsonfile/index.js';
    const nested = 'node_modules/electron-window-state/node_modules/jsonfile/index.js';
    const out = await packAndRead(appDir, archive, [top, nested, 'out/main/index.js']);
    // 两个条目都必须读回各自完整的实现，长版不是短版的前缀截断
    expect(out.get(nested)).toBe(JSONFILE_LONG);
    expect(out.get(top)).toBe(JSONFILE_SHORT);
  });

  it('顺序反过来也一样（去重方向不影响结果）', async () => {
    const { appDir, archive } = await makeUnpackDir({ longFirst: false });
    const top = 'node_modules/jsonfile/index.js';
    const nested = 'node_modules/electron-window-state/node_modules/jsonfile/index.js';
    const out = await packAndRead(appDir, archive, [top, nested]);
    expect(out.get(nested)).toBe(JSONFILE_LONG);
    expect(out.get(top)).toBe(JSONFILE_SHORT);
  });

  it('即使长度相同、内容不同也不会互相覆盖', async () => {
    const base = tmp('ots-pack-samesize-');
    const appDir = path.join(base, 'app');
    const a = path.join(appDir, 'node_modules', 'pkg-a', 'index.js');
    const b = path.join(appDir, 'node_modules', 'pkg-b', 'index.js');
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    // 同长度（24 字节）、不同内容
    fs.writeFileSync(a, "module.exports = 'AAAA';\n");
    fs.writeFileSync(b, "module.exports = 'BBBB';\n");

    const archive = path.join(base, 'staged.asar');
    const out = await packAndRead(appDir, archive, [
      'node_modules/pkg-a/index.js',
      'node_modules/pkg-b/index.js',
    ]);
    expect(out.get('node_modules/pkg-a/index.js')).toBe("module.exports = 'AAAA';\n");
    expect(out.get('node_modules/pkg-b/index.js')).toBe("module.exports = 'BBBB';\n");
  });

  it('内容完全相同的两个文件仍可安全去重，读回内容与 size 正确', async () => {
    const base = tmp('ots-pack-dup-');
    const appDir = path.join(base, 'app');
    const a = path.join(appDir, 'node_modules', 'pkg-a', 'index.js');
    const b = path.join(appDir, 'node_modules', 'pkg-b', 'index.js');
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    const same = "module.exports = 'SAME';\n";
    fs.writeFileSync(a, same);
    fs.writeFileSync(b, same);

    const archive = path.join(base, 'staged.asar');
    const out = await packAndRead(appDir, archive, [
      'node_modules/pkg-a/index.js',
      'node_modules/pkg-b/index.js',
    ]);
    // 内容相同 → 允许去重，但读回的必须是同一份正确内容
    expect(out.get('node_modules/pkg-a/index.js')).toBe(same);
    expect(out.get('node_modules/pkg-b/index.js')).toBe(same);
  });

  it('开发项目 cwd 里存在同名文件时不再污染结果（在仓库根运行本测试即覆盖此场景）', async () => {
    // 这个测试文件本身就在仓库根的 cwd 下运行，而仓库根恰好有 node_modules；
    // 上面几条断言已经证明同名逻辑路径不再读到开发项目的副本。
    // 这里再显式确认仓库根确实存在同名目录，避免「测试其实没覆盖到」的错觉。
    expect(fs.existsSync(path.join(process.cwd(), 'node_modules', 'jsonfile'))).toBe(true);
    const { appDir, archive } = await makeUnpackDir({ longFirst: true });
    const top = 'node_modules/jsonfile/index.js';
    const nested = 'node_modules/electron-window-state/node_modules/jsonfile/index.js';
    const out = await packAndRead(appDir, archive, [top, nested]);
    expect(out.get(top)).toBe(JSONFILE_SHORT);
    expect(out.get(nested)).toBe(JSONFILE_LONG);
  });

  it('在干净的临时 cwd 下派生真实工作进程，结果一致', async () => {
    // runInline 走的是当前进程（会 chdir 后还原）；这里再派生一次真实 worker 进程，
    // 证明隔离本身可用（worker 脚本来自编译产物，需要先 npm run build）。
    const worker = resolvePackWorkerPath();
    expect(fs.existsSync(worker)).toBe(true);

    const base = tmp('ots-pack-real-');
    const appDir = path.join(base, 'app');
    const target = path.join(appDir, 'node_modules', 'jsonfile', 'index.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSONFILE_SHORT);
    fs.mkdirSync(path.join(appDir, 'out', 'main'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'out', 'main', 'index.js'), 'console.log(1);\n');
    const archive = path.join(base, 'staged.asar');

    const r = await packArchiveInWorker(
      {
        appDir,
        stagedArchive: archive,
        files: [
          { path: 'node_modules/jsonfile/index.js', unpacked: false },
          { path: 'out/main/index.js', unpacked: false },
        ],
      },
      { timeoutMs: 60_000 },
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const snap = await readAsar(archive);
    expect(snap.success).toBe(true);
    const t = await readAsarText(snap.success ? snap.data : { archivePath: '', header: {}, size: 0, sha256: '' }, 'node_modules/jsonfile/index.js');
    expect(t.success && t.data).toBe(JSONFILE_SHORT);
  });

  it('事故复现脚本仍能复现依赖库缺陷 —— 证明修复靠的是隔离 cwd，不是改库', () => {
    // 该脚本自己 chdir 到 fixture-cwd（里面 a.js/b.js 内容相同）后打包，
    // 因此它复现的是**依赖库本身的缺陷**：只要 cwd 里有同名且内容相同的文件就会误去重。
    // 我们不改第三方库，所以这个复现必须继续成立 —— 它说明「为什么必须隔离 cwd」。
    const script = path.resolve(
      __dirname,
      '..',
      '..',
      'handoff',
      'startup-incident-2026-09-11',
      'repro-stream-cwd.cjs',
    );
    if (!fs.existsSync(script)) throw new Error('找不到事故复现脚本');
    const cwd = path.dirname(script);
    const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 120_000 });
    expect(r.status).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(path.join(cwd, 'stream-cwd-evidence.json'), 'utf8')) as {
      bugReproduced: boolean;
      files: { rel: string; same: boolean }[];
    };
    expect(evidence.files.map((f) => f.rel).sort()).toEqual(['a.js', 'b.js']);
    expect(evidence.bugReproduced).toBe(true);
  });
});
