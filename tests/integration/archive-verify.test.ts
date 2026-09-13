/**
 * 归档不可变校验回归（事故 F2，见 handoff/startup-incident-2026-09-11/RECOVERY_AND_FIX.md）。
 *
 * 核心教训：哈希是内容身份，不是有效性证明。
 * 事故里打包器为坏内容重算了自洽的 hash，于是「错误数为零」一路绿灯到 applied。
 * 所以这里的门禁必须同时具备：逐条完整性、共享 offset 一致性、脚本可解析、与接管基线一致。
 *
 * 全部使用临时目录构造的合成安装，不触碰任何真实安装。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import {
  buildBaseline,
  checkScripts,
  compareWithBaseline,
  findSharedOffsetConflicts,
  scanArchive,
  verifyIntegrity,
  verifyPackedResult,
} from '../../src/core/patch/archive-verify';
import { applyTheme } from '../../src/core/patch/apply';
import { sha256File } from '../../src/core/patch/asar';
import { ensureDirs, runtimeDirs } from '../../src/core/patch/layout';
import { instanceIdFromPath } from '../../src/core/patch/paths';
import { ADAPTER } from './helpers/adapter';

const installs: SyntheticInstall[] = [];
const runtimes: string[] = [];

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(testTmpRoot(), prefix));
}

async function fixture(opts: Parameters<typeof makeSyntheticInstall>[0] = {}) {
  const inst = await makeSyntheticInstall(opts);
  installs.push(inst);
  return inst;
}

afterEach(() => {
  while (installs.length) installs.pop()?.cleanup();
  while (runtimes.length) fs.rmSync(runtimes.pop() as string, { recursive: true, force: true, maxRetries: 3 });
});

const isAllowed = (entry: string): boolean => ADAPTER.allowedChanges.includes(entry);

type HeaderNode = {
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
  integrity?: { algorithm: string; hash: string; blockSize: number; blocks: string[] };
  files?: Record<string, HeaderNode>;
};

/** ASAR 头部是按目录嵌套的，取条目要逐级下钻 */
function getEntry(root: HeaderNode, entry: string): HeaderNode | undefined {
  let node: HeaderNode = root;
  for (const part of entry.split('/')) {
    const next = node.files?.[part];
    if (!next) return undefined;
    node = next;
  }
  return node;
}

/** 读取归档头部（JSON 部分）与数据区起点 */
function readHeader(archive: string): { header: HeaderNode; dataStart: number; raw: Buffer } {
  const raw = fs.readFileSync(archive);
  const dataStart = 8 + raw.readUInt32LE(4);
  const jsonSize = raw.readUInt32LE(12);
  const header = JSON.parse(raw.subarray(16, 16 + jsonSize).toString('utf8')) as HeaderNode;
  return { header, dataStart, raw };
}

/** 把改过的头部写回一个新归档（不改原 fixture） */
function writeHeader(archive: string, header: HeaderNode): string {
  const { raw, dataStart } = readHeader(archive);
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pre = Buffer.alloc(16);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(json.length + 8, 4);
  pre.writeUInt32LE(json.length + 4, 8);
  pre.writeUInt32LE(json.length, 12);
  const out = path.join(tmp('ots-hdr-'), 'patched.asar');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([pre, json, raw.subarray(dataStart)]));
  return out;
}

/** 在归档内某个条目的数据区写内容（长度不变），模拟「内容被换掉」 */
function overwriteEntry(archive: string, entry: string, content: string): void {
  const { header, dataStart } = readHeader(archive);
  const node = getEntry(header, entry);
  if (!node || node.offset === undefined) throw new Error(`fixture 缺少条目 ${entry}`);
  const size = node.size ?? 0;
  const bytes = Buffer.from(content, 'utf8');
  // 自适应到条目长度：长了截断、短了补零，保证不改头部声明的 size
  const payload = bytes.length >= size ? bytes.subarray(0, size) : Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
  const fd = fs.openSync(archive, 'r+');
  try {
    fs.writeSync(fd, payload, 0, payload.length, dataStart + Number(node.offset));
  } finally {
    fs.closeSync(fd);
  }
}

async function targetOf(inst: SyntheticInstall) {
  const { inspectRoot } = await import('../../src/core/patch/discover');
  const r = await inspectRoot(inst.root);
  if (!r.success || r.data.kind !== 'target') throw new Error('fixture 不是可识别目标');
  return r.data.target;
}

describe('逐条完整性校验', () => {
  it('健康归档全部通过', async () => {
    const inst = await fixture();
    const scan = scanArchive(inst.archivePath);
    expect(scan.success).toBe(true);
    if (!scan.success) return;
    const r = await verifyIntegrity(scan.data);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.checked).toBeGreaterThan(0);
  });

  it('非白名单条目被改动（字节级）→ 按头部完整性发现，绝不放行', async () => {
    const inst = await fixture({
      files: { 'node_modules/jsonfile/index.js': 'module.exports = { good: true };\n' },
    });
    // 直接改写该条目在归档里的字节：头部完整性字段不会跟着变
    overwriteEntry(
      inst.archivePath,
      'node_modules/jsonfile/index.js',
      'module.exports = { good: false };\n',
    );
    const scan = scanArchive(inst.archivePath);
    if (!scan.success) throw new Error(scan.error.message);
    const res = await verifyIntegrity(scan.data);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.detail).toContain('jsonfile');
  });

  it('共享 offset 且长度不同的条目被识别（事故的直接形态）', async () => {
    // 手工构造一个「两个条目指向同一段数据、长度不同」的归档头
    const inst = await fixture();
    const { header } = readHeader(inst.archivePath);
    const a = getEntry(header, 'out/main/index.js');
    if (!a || a.offset === undefined) throw new Error('fixture 缺少 out/main/index.js');
    // 再造一个条目共享同一 offset，但 size 更小（截断读取的形态）
    header.files = header.files ?? {};
    header.files['node_modules'] = header.files['node_modules'] ?? { files: {} };
    header.files['node_modules'].files = header.files['node_modules'].files ?? {};
    header.files['node_modules'].files!['jsonfile'] = { files: {} };
    header.files['node_modules'].files!['jsonfile'].files = { 'index.js': { size: (a.size ?? 0) - 10, offset: a.offset } };

    const out = writeHeader(inst.archivePath, header);
    const scan = scanArchive(out);
    expect(scan.success).toBe(true);
    const shared = scan.success ? findSharedOffsetConflicts(scan.data) : null;
    expect(shared?.success).toBe(false);
  });
});

describe('脚本可解析检查（哈希不能证明内容是好的）', () => {
  it('截断的 CJS 文件即使 hash 自洽也会被拦下（本次事故形态）', async () => {
    const inst = await fixture({
      files: {
        // 结尾停在块中间：这就是事故里「Unexpected end of input」的形态
        'node_modules/jsonfile/index.js': "'use strict';\nmodule.exports = function () {\n  try {\n",
      },
    });
    // 把该条目的 integrity 改成与截断内容一致（模拟「打包器为坏内容重算 hash」）
    const { header, dataStart, raw } = readHeader(inst.archivePath);
    const entry = getEntry(header, 'node_modules/jsonfile/index.js');
    if (!entry || entry.offset === undefined) throw new Error('fixture 缺少 jsonfile 条目');
    const bytes = raw.subarray(
      dataStart + Number(entry.offset),
      dataStart + Number(entry.offset) + (entry.size ?? 0),
    );
    const { createHash } = await import('node:crypto');
    entry.integrity = {
      algorithm: 'SHA256',
      hash: createHash('sha256').update(bytes).digest('hex'),
      blockSize: 4 * 1024 * 1024,
      blocks: [createHash('sha256').update(bytes).digest('hex')],
    };
    const out = writeHeader(inst.archivePath, header);

    // 完整性自检此时是「通过」的 —— 这正是事故里自校验绿灯的原因
    const scan2 = scanArchive(out);
    if (!scan2.success) throw new Error(scan2.error.message);
    const integrity = await verifyIntegrity(scan2.data);
    expect(integrity.success).toBe(true);

    // 但脚本解析检查能把它拦下来
    const scripts = await checkScripts(scan2.data, { isAllowed });
    expect(scripts.success).toBe(false);
    if (!scripts.success) expect(scripts.error.detail).toContain('jsonfile');
  });

  it('正常 ESM 不会被 CJS 包装器误判为损坏', async () => {
    const inst = await fixture({
      files: { 'node_modules/esm-pkg/index.js': "import { x } from './x.js';\nexport const y = x;\n" },
    });
    const scan = scanArchive(inst.archivePath);
    if (!scan.success) throw new Error(scan.error.message);
    const scripts = await checkScripts(scan.data, { isAllowed });
    // 运行时支持 SourceTextModule 时应通过；不支持时跳过（不误判）
    expect(scripts.success).toBe(true);
  });

  it('非法 JSON 被拦下', async () => {
    const inst = await fixture({ files: { 'node_modules/broken/package.json': '{ not json' } });
    const scan = scanArchive(inst.archivePath);
    if (!scan.success) throw new Error(scan.error.message);
    const scripts = await checkScripts(scan.data, { isAllowed });
    expect(scripts.success).toBe(false);
  });
});

describe('接管基线比对（输入不可信必须拒绝）', () => {
  it('首次接管以接手时状态为基线；之后被外部改动的归档必须拒绝', async () => {
    const inst = await fixture();
    const baseline = await buildBaseline(inst.archivePath, isAllowed);
    expect(baseline.success).toBe(true);
    if (!baseline.success) return;
    expect(baseline.data.size).toBeGreaterThan(0);

    // 外部改动一个非白名单条目（语义上等价于「已被外部工具改过」）
    overwriteEntry(inst.archivePath, 'out/main/index.js', 'console.log(2);\n');
    const cmp = await compareWithBaseline(inst.archivePath, baseline.data, { isAllowed });
    expect(cmp.success).toBe(false);
    if (!cmp.success) expect(cmp.error.message).toContain('首次接管');
  });

  it('白名单条目允许与基线不同（它们本来就是要被替换的）', async () => {
    const inst = await fixture();
    const baseline = await buildBaseline(inst.archivePath, isAllowed);
    if (!baseline.success) throw new Error(baseline.error.message);
    // 伪造一个「白名单条目内容不同」的归档：直接改 HTML 的前 15 字节
    overwriteEntry(inst.archivePath, 'out/renderer/index.html', '<!doctype html>');
    const cmp = await compareWithBaseline(inst.archivePath, baseline.data, { isAllowed });
    expect(cmp.success).toBe(true);
  });
});

describe('端到端：损坏输入不能一路走到 applied', () => {
  async function applyOn(inst: SyntheticInstall, opts: { corruptNonTheme?: boolean } = {}) {
    const runtime = tmp('ots-verify-runtime-');
    runtimes.push(runtime);
    const layout = runtimeDirs(runtime, instanceIdFromPath(inst.root));
    await ensureDirs(layout);

    if (opts.corruptNonTheme) {
      // 把内容改坏但保持长度不变（模拟「内容被换掉」而不是「被截断」）
      overwriteEntry(inst.archivePath, 'node_modules/jsonfile/index.js', 'module.exports = 1;');
    }

    const target = await targetOf(inst);
    const before = await sha256File(inst.archivePath);
    const r = await applyTheme({
      target,
      runtimeRoot: runtime,
      css: ':root { --background-base: #111111; }',
      imageBytes: Buffer.from('image'),
      themeSummary: '验证用主题',
      hooks: { probe: async () => 'idle' },
    });
    return { r, before, layout };
  }

  it('首次接管：健康安装正常走完（基线以接手时状态为准）', async () => {
    const inst = await fixture();
    const { r } = await applyOn(inst);
    expect(r.success).toBe(true);
  });

  it('非首次接管：安装被外部改动后拒绝，且目标 hash 不变', async () => {
    const inst = await fixture();
    // 第一次：建立基线
    const first = await applyOn(inst);
    expect(first.r.success).toBe(true);
    const afterFirst = await sha256File(inst.archivePath);

    // 外部改动（非白名单）
    overwriteEntry(inst.archivePath, 'out/main/index.js', 'console.log(2);\n');
    const corrupted = await sha256File(inst.archivePath);
    expect(corrupted).not.toBe(afterFirst);

    const second = await applyOn(inst);
    expect(second.r.success).toBe(false);
    if (!second.r.success) {
      expect(['ARCHIVE_CORRUPT', 'ARCHIVE_VERIFY_FAILED']).toContain(second.r.error.code);
    }
    expect(await sha256File(inst.archivePath)).toBe(corrupted);
  });

  it('输入本身已损坏（内容换掉但长度不变）时，第一次接管也会被脚本解析检查拦下', async () => {
    const inst = await fixture({
      files: { 'node_modules/jsonfile/index.js': 'module.exports = { good: true };\n' },
    });
    const { r, before } = await applyOn(inst, { corruptNonTheme: true });
    // 长度不变时完整性字段不符 → 拦下
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('ARCHIVE_CORRUPT');
    expect(await sha256File(inst.archivePath)).toBe(before);
  });
});

describe('重打包结果校验（verifyPackedResult）', () => {
  it('unpacked 集合与原始不一致时拒绝，一致时通过', async () => {
    const inst = await fixture({
      files: { 'node_modules/native/x.node': 'native-binary' },
      unpack: '*.node',
    });
    const scan = scanArchive(inst.archivePath);
    if (!scan.success) throw new Error(scan.error.message);
    const entries = new Set([...scan.data.entries.keys()]);
    const realUnpacked = new Set([...scan.data.entries.values()].filter((e) => e.unpacked).map((e) => e.path));
    expect(realUnpacked.size).toBeGreaterThan(0);

    // unpacked 集合对不上 → 拒绝（原生模块会因此无法加载）
    const bad = await verifyPackedResult({
      stagedArchive: inst.archivePath,
      originalEntries: entries,
      unpackedOriginal: new Set(['node_modules/does-not-exist/x.node']),
      allowedChanges: ADAPTER.allowedChanges,
    });
    expect(bad.success).toBe(false);

    // 一致 → 通过
    const good = await verifyPackedResult({
      stagedArchive: inst.archivePath,
      originalEntries: entries,
      unpackedOriginal: realUnpacked,
      allowedChanges: ADAPTER.allowedChanges,
    });
    expect(good.success).toBe(true);
  });

  it('白名单条目内容与预期不符时拒绝', async () => {
    const inst = await fixture();
    const scanHere = scanArchive(inst.archivePath);
    if (!scanHere.success) throw new Error(scanHere.error.message);
    const r = await verifyPackedResult({
      stagedArchive: inst.archivePath,
      originalEntries: new Set([...scanHere.data.entries.keys()]),
      unpackedOriginal: new Set([...scanHere.data.entries.values()].filter((e) => e.unpacked).map((e) => e.path)),
      allowedChanges: ADAPTER.allowedChanges,
      expected: new Map([['out/renderer/oc-theme-custom.css', ':root{--x:1}']]),
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.detail).toContain('oc-theme-custom.css');
  });
});
describe('真实安装上的合法形态不得误判（恢复后体检 2026-09-11）', () => {
  it('空文件（size=0、块=[sha256(空)]）与相邻文件共享 offset 是合法产物', async () => {
    const inst = await fixture();
    const { header } = readHeader(inst.archivePath);
    // 造一个空文件条目：共享 package.json 的 offset，integrity 是官方打包器对空文件的记法
    const { createHash } = await import('node:crypto');
    const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    header.files = header.files ?? {};
    header.files['node_modules'] = header.files['node_modules'] ?? { files: {} };
    header.files['node_modules'].files = header.files['node_modules'].files ?? {};
    header.files['node_modules'].files!['empty-stub'] = {
      files: {
        'stub.js': {
          size: 0,
          offset: getEntry(header, 'node_modules/@standard-schema/spec/package.json')?.offset ?? '0',
          integrity: { algorithm: 'SHA256', hash: emptyHash, blockSize: 4 * 1024 * 1024, blocks: [emptyHash] },
        },
      },
    };
    const out = writeHeader(inst.archivePath, header);
    const scan = scanArchive(out);
    if (!scan.success) throw new Error(scan.error.message);
    const integrity = await verifyIntegrity(scan.data);
    expect(integrity.success).toBe(true);
    const shared = findSharedOffsetConflicts(scan.data);
    expect(shared.success).toBe(true);
  });

  it('顶层 return 是合法 CJS（mkdirp/bin/cmd.js 形态），不得判为损坏', async () => {
    const inst = await fixture({
      files: {
        'node_modules/legacy/bin.js': '#!/usr/bin/env node\nvar fs = require(\'fs\');\nif (process.argv.length < 3) return;\nconsole.log(1);\n',
      },
    });
    const scan = scanArchive(inst.archivePath);
    if (!scan.success) throw new Error(scan.error.message);
    const scripts = await checkScripts(scan.data, { isAllowed });
    if (!scripts.success) throw new Error(`${scripts.error.message} | ${scripts.error.detail ?? ''}`);
    expect(scripts.data.checked).toBeGreaterThan(0);
  });

  it('行中 export（注释后跟 export）不被误判为损坏 —— ESM 不可用时按无法判定跳过', async () => {
    const inst = await fixture({
      files: {
        'node_modules/esm-mixed/index.js': '/* oxlint-disable */\n/** @internal */export const javascript = 1;\n',
      },
    });
    const scan = scanArchive(inst.archivePath);
    if (!scan.success) throw new Error(scan.error.message);
    const scripts = await checkScripts(scan.data, { isAllowed });
    if (!scripts.success) throw new Error(`${scripts.error.message} | ${scripts.error.detail ?? ''}`);
    // SourceTextModule 可用的运行时应解析通过；不可用时应计入 unsupported 而不是 problems
    if (typeof (await import('node:vm')).SourceTextModule !== 'function') {
      expect(scripts.data.unsupported).toBeGreaterThan(0);
    }
  });
});
