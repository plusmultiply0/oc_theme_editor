/**
 * S3 发布门禁核验（tools/verify-release.cjs）单元测试。
 *
 * 覆盖计划（handoff/review-2026-09-13-r2）S3 的三个负例 + 正例：
 *   1. 只改 ImageStore 的旧候选被拒——候选 asar 内 out/** 与登记冻结清单
 *      不一致（changed/missing/extra）必须失败，且 REQUIRED_MODULES 覆盖
 *      ImageStore / generate / image-probe 三模块；
 *   2. dist 产物与登记不同被拒——本地 out/** 与 manifest.out 不一致、
 *      buildId 不匹配（禁止回落历史 manifest）、候选目录与登记不一致、
 *      登记提交 ≠ HEAD、工作树已跟踪文件漂移，全部失败关闭；
 *   3. zip 混旧 asar 被拒——zip 条目 CRC32/大小与候选目录磁盘文件不一致、
 *      条目缺/多都必须失败（补上「zip hash 相符 ≠ zip 内部就是所检目录」缺口）。
 *
 * asar 与 zip 夹具都在测试内合成（store 不压缩、CRC32 查表），
 * 不依赖真实构建产物，也不触碰真实 candidate-manifest.json。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkTestTmp } from '../fixtures/test-tmp';

interface OutEntry { bytes: number; sha256: string; error?: string }
interface OutManifest { files: Record<string, OutEntry> }
interface ManifestLike {
  schema?: string;
  buildId?: string;
  candidateDir?: string;
  sourceCommit?: string;
  out?: OutManifest;
}
interface BindingInput {
  manifest?: ManifestLike;
  root?: string;
  candidateDir?: string;
  buildId?: string;
  sourceCommit?: string;
  headCommit?: string;
}
interface ZipEntry { name: string; crc32: number; size: number }
interface ZipEntryRecord {
  rawName: string;
  name: string;
  pathKey: string;
  isDir: boolean;
  method: number;
  problems: string[];
}
interface VerifyReleaseApi {
  REQUIRED_MODULES: string[];
  OUT_PREFIX: string;
  validateOutKey: (rel: string) => string | null;
  crc32: (buf: Buffer) => number;
  outManifestOfDir: (dir: string) => OutManifest;
  outManifestOfAsar: (asarPath: string) => OutManifest;
  diffOutManifest: (expected: OutManifest, actual: OutManifest) => {
    missing: string[]; extra: string[]; changed: string[];
  };
  checkBinding: (input: BindingInput) => string[];
  checkSourceFreeze: (porcelain: string) => string[];
  readZipCentral: (zipPath: string) => ZipEntry[];
  checkZipMatchesDir: (zipPath: string, dir: string) => string[];
  deepVerifyZip: (zipPath: string) => string[];
  listDirsRecursive: (dir: string) => string[];
  normalizeZipEntryName: (raw: string) => { name: string; pathKey: string; isDir: boolean; problem: string | null };
  parseZip: (zipPath: string) => { entries: ZipEntryRecord[]; problems: string[] };
}

// Bundler moduleResolution 下显式 .cjs 相对导入不走 .d.ts 映射（TS7016），
// 与 run-suite-wrapper.test.ts 同法：createRequire + 本地接口引用。
const require = createRequire(import.meta.url);
const vr = require('../../tools/verify-release.cjs') as VerifyReleaseApi;

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

// 本文件用例都在安全临时根下自建目录；用后即清，不在 tmp 根堆积残留
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function mkTmp(prefix: string): string {
  const dir = mkTestTmp(prefix);
  tmpDirs.push(dir);
  return dir;
}

// ---------- 合成夹具 ----------

/** 从扁平 rel->content 构造 asar 头树（嵌套 files 节点） */
function asarHeaderTree(nodes: Record<string, { size: number; offset: string; unpacked?: boolean }>) {
  const root: { files: Record<string, unknown> } = { files: {} };
  for (const [rel, meta] of Object.entries(nodes)) {
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = node.files[parts[i]] as { files: Record<string, unknown> } | undefined;
      node.files[parts[i]] = next ?? { files: {} };
      node = node.files[parts[i]] as { files: Record<string, unknown> };
    }
    node.files[parts[parts.length - 1]] = { size: meta.size, offset: meta.offset, ...(meta.unpacked ? { unpacked: true } : {}) };
  }
  return root;
}

/**
 * 合成最小可用 asar：头部格式与 readAsarHeader 约定一致
 * （magic=4 @0，dataStart = 8 + u32@4，JSON 头长度 u32@12，JSON @16，数据紧随其后）。
 * unpacked 列表中的条目标记 unpacked 且内容不进归档（测试自行写到
 * <asar路径>.unpacked/ 下，覆盖 readAsarEntryBuf 的磁盘读取分支）。
 */
function makeAsar(files: Record<string, Buffer>, unpacked: string[] = []): Buffer {
  const entries = Object.entries(files);
  let dataOffset = 0;
  const nodes: Record<string, { size: number; offset: string; unpacked?: boolean }> = {};
  for (const [rel, buf] of entries) {
    nodes[rel] = { size: buf.length, offset: String(dataOffset), ...(unpacked.includes(rel) ? { unpacked: true } : {}) };
    if (!unpacked.includes(rel)) dataOffset += buf.length;
  }
  const jsonBuf = Buffer.from(JSON.stringify(asarHeaderTree(nodes)), 'utf8');
  const pre = Buffer.alloc(16);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(8 + jsonBuf.length, 4); // dataStart = 16 + jsonLen
  pre.writeUInt32LE(jsonBuf.length, 8);
  pre.writeUInt32LE(jsonBuf.length, 12);
  const packed = entries.filter(([rel]) => !unpacked.includes(rel)).map(([, b]) => b);
  return Buffer.concat([pre, jsonBuf, ...packed]);
}

/** 合成 store（不压缩）zip：本地文件头 + 数据 + 中央目录 + EOCD */
function makeStoredZip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(vr.crc32(content), 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, content);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(vr.crc32(content), 16);
    c.writeUInt32LE(content.length, 20);
    c.writeUInt32LE(content.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + content.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

interface RawZipEntry {
  name: string;
  content?: Buffer;
  /** 覆盖压缩数据（默认 store 用原内容、deflate 用 deflateRawSync(内容)） */
  body?: Buffer;
  /** 压缩方法；用例可以给 12 等「不支持的方法」 */
  method?: number;
  flags?: number;
  /** 覆盖中央目录/本地头声明的 CRC 与大小（构造「声明与实际不符」） */
  declaredCrc32?: number;
  declaredSize?: number;
  declaredCsize?: number;
}

/**
 * 合成 zip（复审 R1–R3 夹具）：支持 store/deflate、任意条目名（含 `\` 与目录结尾）
 * 以及声明值覆盖，用来构造「坏输入」；断言一律调用发布实际使用的
 * checkZipMatchesDir / deepVerifyZip，不只测夹具生成器。
 */
function makeZip(entries: RawZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const content = e.content ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const isDir = e.name.endsWith('/') || e.name.endsWith('\\');
    const body = isDir ? Buffer.alloc(0) : e.body ?? (method === 8 ? zlib.deflateRawSync(content) : content);
    const crc = isDir ? 0 : e.declaredCrc32 ?? vr.crc32(content);
    const usize = isDir ? 0 : e.declaredSize ?? content.length;
    const csize = isDir ? 0 : e.declaredCsize ?? body.length;
    const flags = e.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);

    parts.push(local, nameBuf, body);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

function writeFile(rel: string, content: Buffer, base: string): void {
  const p = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ---------- 测试 ----------

describe('crc32', () => {
  it('标准向量 "123456789" = 0xcbf43926', () => {
    expect(vr.crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('REQUIRED_MODULES（S3：核对集合必须覆盖图片修复模块）', () => {
  it('包含 ImageStore / theme generate / image-probe 三个构建产物', () => {
    expect(vr.REQUIRED_MODULES).toEqual([
      'out/main/services/image-store.js',
      'out/core/theme/generate.js',
      'out/core/theme/image-probe.js',
    ]);
  });
});

describe('out/** 清单键规范（B1：磁盘与归档必须同为 out/... 前缀）', () => {
  it('真实调用 outManifestOfDir(fixture/out)：键带一次 out/，三个图片模块命中', () => {
    const root = mkTmp('vr-out-');
    writeFile('out/main/index.js', Buffer.from('main'), root);
    writeFile('out/main/services/image-store.js', Buffer.from('store'), root);
    writeFile('out/core/theme/generate.js', Buffer.from('generate'), root);
    writeFile('out/core/theme/image-probe.js', Buffer.from('probe'), root);
    // 真实调用：参数就是 out 目录本身，不是 fixture 根
    const m = vr.outManifestOfDir(path.join(root, 'out'));
    expect(Object.keys(m.files).sort()).toEqual([
      'out/core/theme/generate.js', 'out/core/theme/image-probe.js',
      'out/main/index.js', 'out/main/services/image-store.js',
    ]);
    expect(m.files['out/main/index.js']).toEqual({ bytes: 4, sha256: sha256(Buffer.from('main')) });
    for (const mod of vr.REQUIRED_MODULES) expect(Object.keys(m.files)).toContain(mod);
    // 绝不能出现 out/out/ 或裸 main/
    for (const k of Object.keys(m.files)) {
      expect(k.startsWith('out/out/')).toBe(false);
      expect(vr.validateOutKey(k)).toBeNull();
    }
  });

  it('B1 回归：磁盘清单与同内容 ASAR 逐文件一致（不再整批缺/多）', () => {
    const root = mkTmp('vr-out-vs-asar-');
    const content: Record<string, Buffer> = {
      'out/main/index.js': Buffer.from('main'),
      'out/main/services/image-store.js': Buffer.from('store fixed'),
      'out/core/theme/generate.js': Buffer.from('generate'),
      'out/core/theme/image-probe.js': Buffer.from('probe'),
      'out/renderer/index.html': Buffer.from('<html></html>'),
    };
    for (const [rel, buf] of Object.entries(content)) writeFile(rel, buf, root);
    const asarPath = path.join(root, 'app.asar');
    fs.writeFileSync(asarPath, makeAsar(content));
    const disk = vr.outManifestOfDir(path.join(root, 'out'));
    const archived = vr.outManifestOfAsar(asarPath);
    expect(vr.diffOutManifest(disk, archived)).toEqual({ missing: [], extra: [], changed: [] });
    expect(Object.keys(disk.files)).toHaveLength(Object.keys(content).length);
  });

  it('B1 回归：仅改 ImageStore 时只报该文件变化，不出现整批缺/多', () => {
    const root = mkTmp('vr-out-one-change-');
    const content: Record<string, Buffer> = {
      'out/main/index.js': Buffer.from('main'),
      'out/main/services/image-store.js': Buffer.from('store fixed'),
      'out/core/theme/generate.js': Buffer.from('generate'),
      'out/core/theme/image-probe.js': Buffer.from('probe'),
    };
    for (const [rel, buf] of Object.entries(content)) writeFile(rel, buf, root);
    fs.writeFileSync(path.join(root, 'app.asar'), makeAsar({
      ...content, 'out/main/services/image-store.js': Buffer.from('store OLD'),
    }));
    const diff = vr.diffOutManifest(
      vr.outManifestOfDir(path.join(root, 'out')),
      vr.outManifestOfAsar(path.join(root, 'app.asar')),
    );
    expect(diff).toEqual({ missing: [], extra: [], changed: ['out/main/services/image-store.js'] });
  });

  it('空清单直接抛错（不允许「传错目录」静默产出空清单）', () => {
    const root = mkTmp('vr-out-empty-');
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    expect(() => vr.outManifestOfDir(path.join(root, 'out'))).toThrow(/清单为空/);
  });

  it('validateOutKey：拒绝反斜杠/绝对路径/重复前缀/越界段', () => {
    expect(vr.validateOutKey('out/main/index.js')).toBeNull();
    expect(vr.validateOutKey('main/index.js')).toMatch(/不以 out\//);
    expect(vr.validateOutKey('out/out/main/index.js')).toMatch(/重复 out\//);
    expect(vr.validateOutKey('out\\main\\index.js')).toMatch(/反斜杠/);
    expect(vr.validateOutKey('D:/out/main/index.js')).toMatch(/绝对路径/);
    expect(vr.validateOutKey('out/../src/index.ts')).toMatch(/空段/);
    expect(vr.validateOutKey('out/')).toMatch(/为空/);
    expect(vr.validateOutKey('')).toMatch(/为空/);
  });

  it('中文与空格路径按规范保留且可比较', () => {
    const root = mkTmp('vr-out-cjk-');
    const rel = 'out/renderer/assets/主题 面板-1.js';
    writeFile(rel, Buffer.from('cjk'), root);
    const m = vr.outManifestOfDir(path.join(root, 'out'));
    expect(Object.keys(m.files)).toEqual([rel]);
    expect(vr.validateOutKey(rel)).toBeNull();
    fs.writeFileSync(path.join(root, 'app.asar'), makeAsar({ [rel]: Buffer.from('cjk') }));
    expect(vr.diffOutManifest(m, vr.outManifestOfAsar(path.join(root, 'app.asar'))))
      .toEqual({ missing: [], extra: [], changed: [] });
  });
});

describe('out/** 清单 diff', () => {
  it('diff：identical 为空；missing/extra/changed 各自命中', () => {
    const a: OutManifest = { files: { 'out/x.js': { bytes: 1, sha256: 'aa' } } };
    const same: OutManifest = { files: { 'out/x.js': { bytes: 1, sha256: 'aa' } } };
    expect(vr.diffOutManifest(a, same)).toEqual({ missing: [], extra: [], changed: [] });
    expect(vr.diffOutManifest(a, { files: {} }).missing).toEqual(['out/x.js']);
    expect(vr.diffOutManifest(a, { files: { 'out/x.js': { bytes: 1, sha256: 'aa' }, 'out/y.js': { bytes: 2, sha256: 'bb' } } }).extra).toEqual(['out/y.js']);
    expect(vr.diffOutManifest(a, { files: { 'out/x.js': { bytes: 1, sha256: 'cc' } } }).changed).toEqual(['out/x.js']);
  });

  it('负例1（只改 ImageStore 的旧候选被拒）：asar 内 out 与登记清单不一致必须暴露', () => {
    const dir = mkTmp('vr-asar-');
    const fixed = Buffer.from('image-store WITH S2/S4 fixes');
    const stale = Buffer.from('image-store OLD build');
    const outFiles = {
      'out/main/index.js': Buffer.from('main'),
      'out/main/services/image-store.js': fixed,
      'out/core/theme/generate.js': Buffer.from('generate'),
      'out/core/theme/image-probe.js': Buffer.from('probe'),
    };
    // 登记清单来自真实磁盘（以 fixed 内容落盘后调用），不是手写对象
    const root = mkTmp('vr-asar-disk-');
    for (const [rel, buf] of Object.entries(outFiles)) writeFile(rel, buf, root);
    const registered = vr.outManifestOfDir(path.join(root, 'out'));
    // 候选 asar：image-store 是旧内容（其余一致）
    const asarBuf = makeAsar({ ...outFiles, 'out/main/services/image-store.js': stale });
    const asarPath = path.join(dir, 'app.asar');
    fs.writeFileSync(asarPath, asarBuf);
    const diff = vr.diffOutManifest(registered, vr.outManifestOfAsar(asarPath));
    expect(diff.changed).toEqual(['out/main/services/image-store.js']);
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    // 候选缺模块 → missing
    const lacking = makeAsar({
      'out/main/index.js': Buffer.from('main'),
      'out/core/theme/generate.js': Buffer.from('generate'),
    });
    const lackingPath = path.join(dir, 'lacking.asar');
    fs.writeFileSync(lackingPath, lacking);
    const diff2 = vr.diffOutManifest(registered, vr.outManifestOfAsar(lackingPath));
    // 顺序取决于目录遍历，只断言集合
    expect([...diff2.missing].sort()).toEqual([
      'out/core/theme/image-probe.js', 'out/main/services/image-store.js',
    ]);
    expect(diff2.changed).toEqual([]);
    // 候选多出登记外文件 → extra
    const extra = makeAsar({ ...outFiles, 'out/main/services/leftover.js': Buffer.from('x') });
    const extraPath = path.join(dir, 'extra.asar');
    fs.writeFileSync(extraPath, extra);
    expect(vr.diffOutManifest(registered, vr.outManifestOfAsar(extraPath)).extra).toEqual(['out/main/services/leftover.js']);
  });

  it('asar unpacked 条目从 app.asar.unpacked 磁盘读取', () => {
    const dir = mkTmp('vr-unpacked-');
    const unpackedContent = Buffer.from('native payload');
    const asarBuf = makeAsar({
      'out/main/index.js': Buffer.from('main'),
      'out/main/services/native-addon.node': unpackedContent,
    }, ['out/main/services/native-addon.node']);
    const asarPath = path.join(dir, 'app.asar');
    fs.writeFileSync(asarPath, asarBuf);
    writeFile('out/main/services/native-addon.node', unpackedContent, asarPath + '.unpacked');
    const m = vr.outManifestOfAsar(asarPath);
    expect(m.files['out/main/services/native-addon.node']).toEqual({
      bytes: unpackedContent.length, sha256: sha256(unpackedContent),
    });
  });
});

describe('checkBinding（负例2：dist 产物与登记不同被拒，禁止回落历史 manifest）', () => {
  const base: ManifestLike = {
    schema: 'candidate-manifest/2',
    buildId: 'b-20260913-1',
    candidateDir: 'cand/win-unpacked.new',
    sourceCommit: 'a'.repeat(40),
  };

  it('全一致 → 无问题', () => {
    const root = mkTmp('vr-bind-');
    expect(vr.checkBinding({
      manifest: base, root, candidateDir: path.join(root, 'cand', 'win-unpacked.new'),
      buildId: 'b-20260913-1', headCommit: base.sourceCommit,
    })).toEqual([]);
  });

  it('buildId 不匹配 → 拒绝且点名「回落」', () => {
    const problems = vr.checkBinding({ manifest: base, buildId: 'b-OLD' });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('回落');
  });

  it('显式候选目录与登记不一致 → 拒绝（不自动重登记掩盖）', () => {
    const root = mkTmp('vr-bind2-');
    const problems = vr.checkBinding({
      manifest: base, root, candidateDir: path.join(root, 'cand', 'win-unpacked.other'),
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('不一致');
  });

  it('登记提交 ≠ HEAD → 拒绝（不要只改 sourceCommit 而不重建）', () => {
    const problems = vr.checkBinding({ manifest: base, headCommit: 'b'.repeat(40) });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('HEAD');
  });

  it('schema /1 旧登记 → 拒绝（缺 out/** 冻结清单不得通过发布门禁）', () => {
    const problems = vr.checkBinding({ manifest: { ...base, schema: 'candidate-manifest/1' }, buildId: base.buildId });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('candidate-manifest/3');
  });

  it('schema /3 与 /2 均被接受（/2 为过渡兼容）', () => {
    expect(vr.checkBinding({ manifest: { ...base, schema: 'candidate-manifest/3' }, buildId: base.buildId })).toEqual([]);
    expect(vr.checkBinding({ manifest: { ...base, schema: 'candidate-manifest/2' }, buildId: base.buildId })).toEqual([]);
  });

  it('manifest 缺失 → 失败关闭', () => {
    expect(vr.checkBinding({})[0]).toContain('不存在');
  });
});

describe('checkSourceFreeze（构建前冻结源码提交）', () => {
  it('空输出与纯未跟踪行都算冻结', () => {
    expect(vr.checkSourceFreeze('')).toEqual([]);
    expect(vr.checkSourceFreeze('?? handoff/review-2026-09-13-r2/\n')).toEqual([]);
  });
  it('已跟踪文件改动 → 拒绝并披露', () => {
    const problems = vr.checkSourceFreeze(' M src/main/services/image-store.ts\n?? handoff/\n');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('冻结');
    expect(problems[0]).toContain('image-store.ts');
  });
});

describe('zip 一致性（负例3：zip 混旧 asar 被拒）', () => {
  const exe = Buffer.alloc(64, 1);
  const asarNew = Buffer.from('asar content NEW build');
  const asarOld = Buffer.from('asar content OLD build');
  const pak = Buffer.from('locale data');
  const dirFiles = {
    'OpenCodeThemeSwitcher.exe': exe,
    'resources/app.asar': asarNew,
    'resources/app.asar.unpacked/node_modules/x.node': Buffer.from('native'),
    'locales/zh-CN.pak': pak,
  };

  // 布局与真实发布一致：候选目录 cand/ 内是包文件，zip 是其兄弟文件（不能放进
  // 候选目录，否则「磁盘有 zip 没有」会造成假失败）
  function setupCandidate(prefix: string): { cand: string; writeZip(name: string, files: Record<string, Buffer>): string } {
    const base = mkTmp(prefix);
    const cand = path.join(base, 'cand');
    for (const [rel, buf] of Object.entries(dirFiles)) writeFile(rel, buf, cand);
    return {
      cand,
      writeZip(name, files) {
        const zipPath = path.join(base, name);
        fs.writeFileSync(zipPath, makeStoredZip(files));
        return zipPath;
      },
    };
  }

  it('readZipCentral：条目名/CRC/大小正确解析', () => {
    const { writeZip } = setupCandidate('vr-zip-');
    const zipPath = writeZip('dist.zip', {
      'OpenCodeThemeSwitcher.exe': exe,
      'resources/app.asar': asarNew,
      'locales/zh-CN.pak': pak,
    });
    const entries = vr.readZipCentral(zipPath);
    expect(entries.map((e) => e.name)).toEqual(['OpenCodeThemeSwitcher.exe', 'resources/app.asar', 'locales/zh-CN.pak']);
    expect(entries[1]).toEqual({ name: 'resources/app.asar', crc32: vr.crc32(asarNew), size: asarNew.length });
  });

  it('同源 zip 与候选目录一致 → 通过', () => {
    const { cand, writeZip } = setupCandidate('vr-zip-ok-');
    const zipPath = writeZip('dist.zip', dirFiles);
    expect(vr.checkZipMatchesDir(zipPath, cand)).toEqual([]);
  });

  it('zip 混入旧 asar（CRC 不一致）→ 拒绝并点名文件', () => {
    const { cand, writeZip } = setupCandidate('vr-zip-stale-');
    const zipPath = writeZip('dist.zip', { ...dirFiles, 'resources/app.asar': asarOld });
    const problems = vr.checkZipMatchesDir(zipPath, cand);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('resources/app.asar');
    expect(problems[0]).toContain('不一致');
  });

  it('deepVerifyZip：完好的 zip 通过（实读内容 CRC 与声明一致）', () => {
    const { writeZip } = setupCandidate('vr-deep-ok-');
    const zipPath = writeZip('dist.zip', dirFiles);
    expect(vr.deepVerifyZip(zipPath)).toEqual([]);
  });

  it('deepVerifyZip：数据被篡改（内容与声明 CRC 不符）→ 拒绝，不只看中央目录', () => {
    const root = mkTmp('vr-deep-tamper-');
    const zipPath = path.join(root, 'dist.zip');
    fs.writeFileSync(zipPath, makeStoredZip({ 'a.txt': Buffer.from('HELLO') }));
    // 原始内容 'HELLO' → 篡改为 'WORLD'（同长度），中央目录 CRC 仍是旧的
    const buf = fs.readFileSync(zipPath);
    const idx = buf.indexOf(Buffer.from('HELLO'));
    expect(idx).toBeGreaterThan(0);
    buf.write('WORLD', idx, 'utf8');
    fs.writeFileSync(zipPath, buf);
    const problems = vr.deepVerifyZip(zipPath);
    expect(problems.some((p) => p.includes('CRC') && p.includes('a.txt'))).toBe(true);
  });

  it('deepVerifyZip：目录逃逸条目（../）→ 拒绝', () => {
    const root = mkTmp('vr-deep-escape-');
    const zipPath = path.join(root, 'dist.zip');
    fs.writeFileSync(zipPath, makeStoredZip({ '../evil.txt': Buffer.from('x') }));
    expect(vr.deepVerifyZip(zipPath).some((p) => p.includes('越界'))).toBe(true);
  });

  it('zip 缺条目 / 多条目 → 分别拒绝', () => {
    const { cand, writeZip } = setupCandidate('vr-zip-miss-');
    const missing = writeZip('missing.zip', {
      'OpenCodeThemeSwitcher.exe': exe,
      'resources/app.asar': asarNew,
      // 少了 locales/zh-CN.pak 与 unpacked
    });
    const missProblems = vr.checkZipMatchesDir(missing, cand);
    expect(missProblems.some((p) => p.includes('缺少') && p.includes('locales/zh-CN.pak'))).toBe(true);

    const extra = writeZip('extra.zip', { ...dirFiles, 'stale-from-old-candidate.txt': Buffer.from('old') });
    const extraProblems = vr.checkZipMatchesDir(extra, cand);
    expect(extraProblems.some((p) => p.includes('多出') && p.includes('stale-from-old-candidate.txt'))).toBe(true);
  });
});

/**
 * 复审 R1（Windows 目录条目误判）：
 *   旧实现「先按原始名判目录、后转分隔符」，于是 `resources\` 被当成文件参加比较，
 *   合法候选必然报「多出」，发布被误判阻断。这里锁住修复后的目录策略。
 */
describe('ZIP 目录条目与隐式父目录（复审 R1）', () => {
  const disk: Record<string, Buffer> = {
    'resources/app.asar': Buffer.from('asar v2'),
    'resources/app.asar.unpacked/node_modules/x.node': Buffer.from('native'),
    'OpenCodeThemeSwitcher.exe': Buffer.alloc(48, 3),
    'empty.txt': Buffer.alloc(0),
  };
  const asEntries = (sep: string): RawZipEntry[] =>
    Object.entries(disk).map(([name, content]) => ({ name: name.split('/').join(sep), content }));

  function setup(prefix: string, entries: RawZipEntry[]): { dir: string; zipPath: string } {
    const base = mkTmp(prefix);
    const dir = path.join(base, 'cand');
    for (const [rel, buf] of Object.entries(disk)) writeFile(rel, buf, dir);
    const zipPath = path.join(base, 'dist.zip');
    fs.writeFileSync(zipPath, makeZip(entries));
    return { dir, zipPath };
  }

  it('反斜杠目录条目（Compress-Archive 写 `resources\\`）不再被当成多余文件 → 通过', () => {
    const { dir, zipPath } = setup('vr-r1-backslash-', [{ name: 'resources\\' }, ...asEntries('\\')]);
    expect(vr.checkZipMatchesDir(zipPath, dir)).toEqual([]);
    expect(vr.deepVerifyZip(zipPath)).toEqual([]);
  });

  it('正斜杠显式目录条目（含多层父目录）→ 通过', () => {
    const { dir, zipPath } = setup('vr-r1-slash-dir-', [
      ...asEntries('/'),
      { name: 'resources/' },
      { name: 'resources/app.asar.unpacked/' },
      { name: 'resources/app.asar.unpacked/node_modules/' },
    ]);
    expect(vr.checkZipMatchesDir(zipPath, dir)).toEqual([]);
  });

  it('只用文件条目隐式表达父目录 → 通过（不得要求磁盘每个目录都显式出现）', () => {
    const { dir, zipPath } = setup('vr-r1-implicit-', asEntries('/'));
    expect(vr.checkZipMatchesDir(zipPath, dir)).toEqual([]);
    expect(vr.parseZip(zipPath).problems).toEqual([]);
  });

  it('零字节普通文件仍参与比较，不因 size===0 被当成目录 → 通过', () => {
    const withAll = setup('vr-r1-empty-ok-', asEntries('/'));
    expect(vr.checkZipMatchesDir(withAll.zipPath, withAll.dir)).toEqual([]);

    // 同一份磁盘 + 凭空多出的零字节文件 → 必须拒绝（证明零字节文件也在集合比较里）
    const withGhost = setup('vr-r1-empty-ghost-', [...asEntries('/'), { name: 'ghost.txt', content: Buffer.alloc(0) }]);
    const problems = vr.checkZipMatchesDir(withGhost.zipPath, withGhost.dir);
    expect(problems.some((p) => p.includes('多出') && p.includes('ghost.txt'))).toBe(true);
  });

  it('zip 凭空多出的目录条目 → 拒绝并点名', () => {
    const { dir, zipPath } = setup('vr-r1-ghost-dir-', [...asEntries('/'), { name: 'not-on-disk/' }]);
    const problems = vr.checkZipMatchesDir(zipPath, dir);
    expect(problems.some((p) => p.includes('多出') && p.includes('not-on-disk/'))).toBe(true);
  });
});

/**
 * 复审 R2（「深度校验」其实没验证压缩内容）：
 *   旧实现对 method !== 0 只检查数据范围，不 inflate、不比对实际长度/CRC；
 *   目录一致性检查也只信中央目录里的 CRC/大小，因此两道检查组合仍会放行坏流。
 * 断言全部调用发布实际使用的 checkZipMatchesDir / deepVerifyZip。
 */
describe('ZIP 真实解压校验（复审 R2）', () => {
  function zipWith(prefix: string, entries: RawZipEntry[], diskFiles: Record<string, Buffer> = {}) {
    const base = mkTmp(prefix);
    const dir = path.join(base, 'cand');
    for (const [rel, buf] of Object.entries(diskFiles)) writeFile(rel, buf, dir);
    const zipPath = path.join(base, 'dist.zip');
    fs.writeFileSync(zipPath, makeZip(entries));
    return {
      dir,
      zipPath,
      match: (): string[] => vr.checkZipMatchesDir(zipPath, dir),
      deep: (): string[] => vr.deepVerifyZip(zipPath),
    };
  }

  it('有效 DEFLATE 条目 → 两道检查通过', () => {
    const content = Buffer.from('hello deflate');
    const z = zipWith('vr-r2-deflate-ok-', [{ name: 'a/b.txt', content, method: 8 }], { 'a/b.txt': content });
    expect(z.match()).toEqual([]);
    expect(z.deep()).toEqual([]);
  });

  it('store 与 DEFLATE 混合 → 通过（不因方法不同误报）', () => {
    const a = Buffer.from('store content');
    const b = Buffer.from('deflate content');
    const z = zipWith('vr-r2-mixed-', [
      { name: 'a.txt', content: a },
      { name: 'b.txt', content: b, method: 8 },
    ], { 'a.txt': a, 'b.txt': b });
    expect(z.match()).toEqual([]);
    expect(z.deep()).toEqual([]);
  });

  it('损坏的 DEFLATE 流（中央目录声明完全正确）→ 两道检查都拒绝', () => {
    const content = Buffer.from('hello');
    const z = zipWith(
      'vr-r2-corrupt-',
      [{ name: 'file.txt', content, method: 8, body: Buffer.from([7, 0, 0]) }],
      { 'file.txt': content },
    );
    expect(z.match().some((p) => p.includes('DEFLATE 解压失败'))).toBe(true);
    expect(z.deep().some((p) => p.includes('DEFLATE 解压失败'))).toBe(true);
  });

  it('未知压缩方法（method=12）→ 显式拒绝，不静默跳过', () => {
    const content = Buffer.from('bz2?');
    const z = zipWith('vr-r2-method-', [{ name: 'file.txt', content, method: 12 }], { 'file.txt': content });
    expect(z.match().some((p) => p.includes('不支持的压缩方法'))).toBe(true);
    expect(z.deep().some((p) => p.includes('不支持的压缩方法'))).toBe(true);
  });

  it('加密条目（flag bit0）→ 拒绝', () => {
    const content = Buffer.from('secret');
    const z = zipWith('vr-r2-encrypted-', [{ name: 'file.txt', content, flags: 0x1 }], { 'file.txt': content });
    expect(z.match().some((p) => p.includes('加密'))).toBe(true);
    expect(z.deep().some((p) => p.includes('加密'))).toBe(true);
  });

  it('压缩数据超出文件末尾（声明 csize 大于实际数据）→ 拒绝', () => {
    const content = Buffer.from('hello');
    const z = zipWith(
      'vr-r2-bounds-',
      [{ name: 'file.txt', content, declaredCsize: 4096 }],
      { 'file.txt': content },
    );
    const all = [...z.match(), ...z.deep()].join('；');
    expect(all).toMatch(/超出文件末尾|长度 .* 与声明大小/);
  });

  it('解压后实际长度与声明不符 → 拒绝', () => {
    const content = Buffer.from('hello');
    const z = zipWith('vr-r2-ulen-', [{ name: 'file.txt', content, method: 8, declaredSize: 99 }], { 'file.txt': content });
    const all = [...z.match(), ...z.deep()].join('；');
    expect(all).toMatch(/实际长度|长度/);
  });

  it('实读内容 CRC 与中央目录声明不符 → deepVerifyZip 拒绝', () => {
    const content = Buffer.from('hello');
    const z = zipWith('vr-r2-crc-', [{ name: 'file.txt', content, declaredCrc32: 0xdeadbeef }], { 'file.txt': content });
    expect(z.deep().some((p) => p.includes('CRC') && p.includes('file.txt'))).toBe(true);
  });
});

/**
 * 复审 R3（路径规范化不统一）：重复别名、大小写冲突、正反斜杠越界、UNC/盘符、
 * 文件与同名目录都必须有明确拒绝用例，且两道检查都走同一套规则。
 */
describe('ZIP 条目路径规范化（复审 R3）', () => {
  function checks(prefix: string, entries: RawZipEntry[], diskFiles: Record<string, Buffer> = {}) {
    const base = mkTmp(prefix);
    const dir = path.join(base, 'cand');
    for (const [rel, buf] of Object.entries(diskFiles)) writeFile(rel, buf, dir);
    const zipPath = path.join(base, 'dist.zip');
    fs.writeFileSync(zipPath, makeZip(entries));
    return {
      match: vr.checkZipMatchesDir(zipPath, dir),
      deep: vr.deepVerifyZip(zipPath),
      parsed: vr.parseZip(zipPath),
    };
  }

  it('混合分隔符重复别名（a/b.txt 与 a\\b.txt）→ 两道检查都拒绝', () => {
    const content = Buffer.from('hello');
    const r = checks(
      'vr-r3-alias-',
      [{ name: 'a/b.txt', content }, { name: 'a\\b.txt', content }],
      { 'a/b.txt': content },
    );
    expect(r.match.some((p) => p.includes('重复'))).toBe(true);
    expect(r.deep.some((p) => p.includes('重复'))).toBe(true);
  });

  it('大小写冲突（A/x.txt 与 a/x.txt，Windows 下同一路径）→ 拒绝', () => {
    const content = Buffer.from('hello');
    const r = checks(
      'vr-r3-case-',
      [{ name: 'A/x.txt', content }, { name: 'a/x.txt', content }],
      { 'A/x.txt': content },
    );
    expect(r.match.some((p) => p.includes('大小写冲突'))).toBe(true);
    expect(r.deep.some((p) => p.includes('大小写冲突'))).toBe(true);
  });

  it('反斜杠越界（..\\escape.txt）→ 两道检查都拒绝，不只 deep', () => {
    const r = checks('vr-r3-traversal-', [{ name: '..\\escape.txt', content: Buffer.from('x') }]);
    expect(r.match.some((p) => p.includes('越界'))).toBe(true);
    expect(r.deep.some((p) => p.includes('越界'))).toBe(true);
  });

  it('正斜杠越界（sub/../../escape.txt）与 UNC / 盘符 → 拒绝', () => {
    const traversal = checks('vr-r3-traversal2-', [{ name: 'sub/../../escape.txt', content: Buffer.from('x') }]);
    expect(traversal.match.join('；')).toContain('越界');

    const drive = checks('vr-r3-drive-', [{ name: 'C:\\evil.txt', content: Buffer.from('x') }]);
    expect(drive.match.join('；')).toContain('越界');
    expect(drive.deep.join('；')).toContain('越界');

    const unc = checks('vr-r3-unc-', [{ name: '\\\\server\\share\\x.txt', content: Buffer.from('x') }]);
    expect(unc.match.join('；')).toContain('越界');
    expect(unc.deep.join('；')).toContain('越界');
  });

  it('同名条目既是文件又是目录 → 拒绝（内容会互相覆盖）', () => {
    const r = checks(
      'vr-r3-file-dir-',
      [{ name: 'a', content: Buffer.from('file') }, { name: 'a/b.txt', content: Buffer.from('inner') }],
      { 'a/b.txt': Buffer.from('inner') },
    );
    expect(r.match.some((p) => p.includes('既是文件又是目录'))).toBe(true);
    expect(r.deep.some((p) => p.includes('既是文件又是目录'))).toBe(true);
  });

  it('规范名解析：统一分隔符后再判目录，并保留原有越界判定', () => {
    expect(vr.normalizeZipEntryName('resources\\')).toEqual({ name: 'resources/', pathKey: 'resources', isDir: true, problem: null });
    expect(vr.normalizeZipEntryName('a\\b.txt')).toEqual({ name: 'a/b.txt', pathKey: 'a/b.txt', isDir: false, problem: null });
    expect(vr.normalizeZipEntryName('CON.txt').problem).toContain('保留设备名');
    expect(vr.normalizeZipEntryName('a//b.txt').problem).toContain('空路径段');
    expect(vr.normalizeZipEntryName('a/b.txt ').problem).toContain('点或空格结尾');
    expect(vr.normalizeZipEntryName('a/b?.txt').problem).toContain('非法字符');
    expect(vr.normalizeZipEntryName('\\server\\share\\x.txt').problem).toContain('越界');
  });

  it('listDirsRecursive 只列目录（供显式目录条目核对）', () => {
    const base = mkTmp('vr-r3-dirs-');
    writeFile('a/b/c.txt', Buffer.from('x'), base);
    expect(vr.listDirsRecursive(base).sort()).toEqual(['a', 'a/b']);
  });
});
