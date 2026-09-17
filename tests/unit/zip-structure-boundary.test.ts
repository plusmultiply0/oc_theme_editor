/**
 * ZIP 结构边界与隐式目录冲突（复审 F4）。
 *
 * 背景：`tools/verify-release.cjs` 的内容解压/哈希校验是有效的，但**共享解析器**
 * 会放过若干构造出来的畸形输入：
 *   1. 中央目录最后一项声明 `commentLen=65535` 而实际没有注释 →
 *      遍历越出中央目录去读后续字节，反而「两个检查都无问题」；
 *   2. `flags bit3=1`、本地 CRC/大小为零占位，但**根本没有 data descriptor** →
 *      跳过本地字段比对之后就没有任何东西再核这段数据；
 *   3. 文件 `a` 与文件 `A/file.txt` → 隐式父目录冲突用**区分大小写**的集合比较，
 *      在 Windows 上必然落到同一路径却查不出来。
 *
 * 这一组用例直接调用生产函数（`parseZip` / `deepVerifyZip` / `checkZipMatchesDir`），
 * 不复制一份解析逻辑——否则测的是测试自己的实现。
 *
 * 同时保留正例：合法 zip（显式/隐式目录、空普通文件、store/DEFLATE）必须继续通过，
 * 避免「加严」变成「把所有 zip 都拒掉」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { mkTestTmp } from '../fixtures/test-tmp';

const requireCjs = createRequire(import.meta.url);
const vr = requireCjs('../../tools/verify-release.cjs') as {
  parseZip: (p: string) => {
    buf: Buffer;
    entries: {
      name: string;
      pathKey: string;
      isDir: boolean;
      flags: number;
      method: number;
      crc32: number;
      csize: number;
      usize: number;
      dataStart: number;
      problems: string[];
    }[];
    problems: string[];
    explicitDirs: Set<string>;
  };
  deepVerifyZip: (p: string) => string[];
  checkZipMatchesDir: (zip: string, dir: string) => string[];
  readZipCentral: (p: string) => { name: string; crc32: number; size: number }[];
  crc32: (b: Buffer) => number;
};

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }
});

function tmp(name: string): string {
  const d = mkTestTmp('ots-zip-f4-');
  tmpDirs.push(d);
  return path.join(d, name);
}

// ---------------- 极简 ZIP 构造器（只用于造夹具，不参与生产判定） ----------------

interface EntrySpec {
  name: string;
  data?: Buffer;
  /** 0 = store，8 = deflate */
  method?: 0 | 8;
  isDir?: boolean;
  /** bit 3：本地 CRC/大小为占位，真实值写在 data descriptor */
  descriptor?: boolean;
  /** 负例：声明 bit 3 但不写描述符 */
  omitDescriptor?: boolean;
  /** 负例：覆盖中央目录条目里的 commentLen 字段 */
  cdCommentLenOverride?: number;
  cdComment?: string;
}

interface ZipOpts {
  /** 负例：覆盖 EOCD 里的 commentLen 字段 */
  eocdCommentLenOverride?: number;
  eocdComment?: string;
}

/**
 * 构造一个 zip。字段布局按 PKWARE APPNOTE：
 * 本地头 30 字节、中央目录条目 46 字节、EOCD 22 字节。
 * 刻意保持「最小可用」——只写判定真正会读到的字段。
 */
function buildZip(entries: EntrySpec[], opts: ZipOpts = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const isDir = e.isDir ?? e.name.endsWith('/');
    const raw = e.data ?? Buffer.alloc(0);
    const method = isDir ? 0 : (e.method ?? 0);
    const stored = isDir || method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = vr.crc32(raw);
    const flags = e.descriptor ? 0x8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    // bit 3 时本地 CRC/大小为占位 0（ZIP 语义），否则写真实值
    local.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(e.descriptor ? 0 : stored.length, 18);
    local.writeUInt32LE(e.descriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const localOffset = offset;
    locals.push(local, nameBuf, stored);
    offset += 30 + nameBuf.length + stored.length;

    if (e.descriptor && !e.omitDescriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); // 有签名形式
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(stored.length, 8);
      dd.writeUInt32LE(raw.length, 12);
      locals.push(dd);
      offset += 16;
    }

    const cdComment = Buffer.from(e.cdComment ?? '', 'utf8');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(e.cdCommentLenOverride ?? cdComment.length, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(isDir ? 0x10 : 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBuf, cdComment);
  }

  const localBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(centrals);
  const eocdComment = Buffer.from(opts.eocdComment ?? '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(opts.eocdCommentLenOverride ?? eocdComment.length, 20);
  return Buffer.concat([localBuf, cdBuf, eocd, eocdComment]);
}

function writeZip(entries: EntrySpec[], opts: ZipOpts = {}, name = 'a.zip'): string {
  const p = tmp(name);
  fs.writeFileSync(p, buildZip(entries, opts));
  return p;
}

/** 落一个与 zip 对应的磁盘目录（供 checkZipMatchesDir 使用） */
function writeDir(files: Record<string, string>): string {
  const d = mkTestTmp('ots-zip-f4-dir-');
  tmpDirs.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(d, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return d;
}

// ---------------- 正例：加严不能误伤合法 zip ----------------

describe('F4 正例：合法 zip 必须继续通过', () => {
  it('显式目录 + store + DEFLATE + 空文件 → 三项检查全通过', () => {
    const zip = writeZip([
      { name: 'dir/', isDir: true },
      { name: 'dir/a.txt', data: Buffer.from('AAA'), method: 0 },
      { name: 'dir/b.txt', data: Buffer.from('BBB'.repeat(50)), method: 8 },
      { name: 'empty.bin', data: Buffer.alloc(0), method: 0 },
    ]);
    const dir = writeDir({ 'dir/a.txt': 'AAA', 'dir/b.txt': 'BBB'.repeat(50), 'empty.bin': '' });
    expect(vr.parseZip(zip).problems).toEqual([]);
    expect(vr.deepVerifyZip(zip)).toEqual([]);
    expect(vr.checkZipMatchesDir(zip, dir)).toEqual([]);
    expect(vr.readZipCentral(zip).map((e) => e.name)).toEqual([
      'dir/a.txt',
      'dir/b.txt',
      'empty.bin',
    ]);
  });

  it('隐式目录（只用文件条目表达父目录）→ 通过，不要求磁盘每个目录都显式出现', () => {
    const zip = writeZip([{ name: 'sub/deep/c.txt', data: Buffer.from('CCC'), method: 0 }]);
    const dir = writeDir({ 'sub/deep/c.txt': 'CCC' });
    expect(vr.parseZip(zip).problems).toEqual([]);
    expect(vr.checkZipMatchesDir(zip, dir)).toEqual([]);
  });

  it('反斜杠分隔的目录条目（PowerShell Compress-Archive 形态）→ 仍识别为目录', () => {
    const zip = writeZip([
      { name: 'res\\', isDir: true },
      { name: 'res\\x.txt', data: Buffer.from('X'), method: 0 },
    ]);
    const parsed = vr.parseZip(zip);
    expect(parsed.problems).toEqual([]);
    expect(parsed.explicitDirs.has('res')).toBe(true);
    expect(vr.checkZipMatchesDir(zip, writeDir({ 'res/x.txt': 'X' }))).toEqual([]);
  });

  it('合法的 data descriptor（有签名形式）→ 通过', () => {
    const zip = writeZip([{ name: 'd.bin', data: Buffer.from('DDDD'), method: 0, descriptor: true }]);
    expect(vr.parseZip(zip).problems).toEqual([]);
    expect(vr.deepVerifyZip(zip)).toEqual([]);
  });

  it('EOCD 带注释（commentLen 与实际一致）→ 通过', () => {
    const zip = writeZip([{ name: 'a.txt', data: Buffer.from('A'), method: 0 }], { eocdComment: 'hello' });
    expect(vr.parseZip(zip).problems).toEqual([]);
  });
});

// ---------------- 负例 1：中央目录变长字段越界 ----------------

describe('F4 负例一：中央目录变长字段越出范围', () => {
  it('最后一项声明 commentLen=65535 但实际没有注释 → 必须拒绝', () => {
    const zip = writeZip([
      { name: 'a.txt', data: Buffer.from('A'), method: 0 },
      { name: 'b.txt', data: Buffer.from('B'), method: 0, cdCommentLenOverride: 65535 },
    ]);
    // parseZip 是结构性错误 → 抛
    expect(() => vr.parseZip(zip)).toThrow(/变长字段|中央目录/);
    // 两个对外检查都必须失败关闭，而不是「无问题」
    expect(vr.deepVerifyZip(zip).join('；')).toMatch(/无法解析/);
    expect(vr.checkZipMatchesDir(zip, writeDir({ 'a.txt': 'A', 'b.txt': 'B' })).join('；')).toMatch(
      /无法解析/,
    );
  });

  it('EOCD 的 commentLen 与实际不符 → 必须拒绝', () => {
    const zip = writeZip([{ name: 'a.txt', data: Buffer.from('A'), method: 0 }], {
      eocdCommentLenOverride: 1000,
    });
    expect(() => vr.parseZip(zip)).toThrow(/注释长度/);
    expect(vr.deepVerifyZip(zip).join('；')).toMatch(/无法解析/);
  });

  it('中央目录项数与实际不符（声明多一项）→ 必须拒绝', () => {
    const buf = buildZip([{ name: 'a.txt', data: Buffer.from('A'), method: 0 }]);
    // EOCD 在末尾 22 字节；把总数从 1 改成 2
    const eocd = buf.length - 22;
    buf.writeUInt16LE(2, eocd + 8);
    buf.writeUInt16LE(2, eocd + 10);
    const zip = tmp('count-mismatch.zip');
    fs.writeFileSync(zip, buf);
    expect(() => vr.parseZip(zip)).toThrow(/中央目录/);
  });

  it('分卷 zip（EOCD 磁盘号非 0）→ 必须拒绝', () => {
    const buf = buildZip([{ name: 'a.txt', data: Buffer.from('A'), method: 0 }]);
    const eocd = buf.length - 22;
    buf.writeUInt16LE(1, eocd + 4);
    const zip = tmp('multidisk.zip');
    fs.writeFileSync(zip, buf);
    expect(() => vr.parseZip(zip)).toThrow(/分卷/);
  });

  it('中央目录范围超出文件末尾 → 必须拒绝', () => {
    const buf = buildZip([{ name: 'a.txt', data: Buffer.from('A'), method: 0 }]);
    const eocd = buf.length - 22;
    buf.writeUInt32LE(0xffffff, eocd + 12); // cdSize 夸张
    const zip = tmp('cd-oob.zip');
    fs.writeFileSync(zip, buf);
    expect(() => vr.parseZip(zip)).toThrow(/中央目录/);
  });
});

// ---------------- 负例 2：声明 bit 3 但没有 data descriptor ----------------

describe('F4 负例二：data descriptor 缺失', () => {
  it('flags bit3=1、本地零占位，但没有描述符 → 必须拒绝（不再「两检查都无问题」）', () => {
    const zip = writeZip([
      { name: 'x.bin', data: Buffer.from('XXXX'), method: 0, descriptor: true, omitDescriptor: true },
    ]);
    const parsed = vr.parseZip(zip);
    expect(parsed.problems.join('；')).toMatch(/描述符缺失|data descriptor/);
    expect(vr.deepVerifyZip(zip).join('；')).toMatch(/描述符/);
    expect(vr.checkZipMatchesDir(zip, writeDir({ 'x.bin': 'XXXX' })).join('；')).toMatch(/描述符/);
  });

  it('描述符存在但 CRC/大小与中央目录不符 → 必须拒绝', () => {
    const buf = buildZip([{ name: 'y.bin', data: Buffer.from('YYYY'), method: 0, descriptor: true }]);
    // 描述符 16 字节在数据之后、中央目录之前；篡改其中的 csize
    const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
    const ddStart = cdOffset - 16;
    buf.writeUInt32LE(0xdeadbeef, ddStart + 4); // crc 改成错的
    const zip = tmp('dd-bad.zip');
    fs.writeFileSync(zip, buf);
    expect(vr.parseZip(zip).problems.join('；')).toMatch(/data descriptor 与中央目录声明不符/);
  });

  it('无签名形式的合法描述符 → 通过（兼容两种合法写法）', () => {
    const data = Buffer.from('ZZZZ');
    const crc = vr.crc32(data);
    const nameBuf = Buffer.from('z.bin', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x8, 6); // bit 3
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(nameBuf.length, 26);
    const dd = Buffer.alloc(12); // 无签名：crc/csize/usize
    dd.writeUInt32LE(crc, 0);
    dd.writeUInt32LE(data.length, 4);
    dd.writeUInt32LE(data.length, 8);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x8, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 42);
    const body = Buffer.concat([local, nameBuf, data, dd]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + nameBuf.length, 12);
    eocd.writeUInt32LE(body.length, 16);
    const zip = tmp('dd-nosig.zip');
    fs.writeFileSync(zip, Buffer.concat([body, cd, nameBuf, eocd]));
    expect(vr.parseZip(zip).problems).toEqual([]);
    expect(vr.deepVerifyZip(zip)).toEqual([]);
  });
});

// ---------------- 负例 3：隐式父目录的大小写别名冲突 ----------------

describe('F4 负例三：文件与隐式父目录的大小写冲突', () => {
  it('文件 a 与文件 A/file.txt → 必须拒绝（Windows 下落到同一路径）', () => {
    const zip = writeZip([
      { name: 'a', data: Buffer.from('FILE-CONTENT'), method: 0 },
      { name: 'A/file.txt', data: Buffer.from('NESTED'), method: 0 },
    ]);
    const problems = vr.parseZip(zip).problems.join('；');
    expect(problems).toMatch(/大小写/);
    expect(vr.deepVerifyZip(zip).join('；')).toMatch(/大小写/);
  });

  it('显式目录与文件同名但大小写不同 → 同样拒绝', () => {
    const zip = writeZip([
      { name: 'B/', isDir: true },
      { name: 'b', data: Buffer.from('X'), method: 0 },
    ]);
    expect(vr.parseZip(zip).problems.join('；')).toMatch(/大小写|既是文件又是目录/);
  });

  it('大小写完全一致的文件/目录同名 → 仍按「既是文件又是目录」拒绝', () => {
    const zip = writeZip([
      { name: 'c/', isDir: true },
      { name: 'c', data: Buffer.from('X'), method: 0 },
    ]);
    expect(vr.parseZip(zip).problems.join('；')).toMatch(/既是文件又是目录/);
  });

  it('仅大小写不同的两个文件 → 拒绝（既有行为，防回归）', () => {
    const zip = writeZip([
      { name: 'readme.txt', data: Buffer.from('1'), method: 0 },
      { name: 'README.TXT', data: Buffer.from('2'), method: 0 },
    ]);
    expect(vr.parseZip(zip).problems.join('；')).toMatch(/大小写/);
  });

  it('互不冲突的普通多级路径 → 通过（避免把大小写检查做得过宽）', () => {
    const zip = writeZip([
      { name: 'a/b.txt', data: Buffer.from('1'), method: 0 },
      { name: 'a/c.txt', data: Buffer.from('2'), method: 0 },
      { name: 'd.txt', data: Buffer.from('3'), method: 0 },
    ]);
    expect(vr.parseZip(zip).problems).toEqual([]);
    expect(vr.checkZipMatchesDir(zip, writeDir({ 'a/b.txt': '1', 'a/c.txt': '2', 'd.txt': '3' }))).toEqual(
      [],
    );
  });
});

// ---------------- 负例 4：目录条目的异常元信息不再被略过 ----------------

describe('F4：目录条目的异常元信息不再被略过', () => {
  it('目录条目声明不支持的压缩方法 → 拒绝（旧实现 `if (isDir) continue` 会放过）', () => {
    const buf = buildZip([{ name: 'd/', isDir: true }, { name: 'd/f.txt', data: Buffer.from('F'), method: 0 }]);
    // 把第一条中央目录条目（目录）的 method 改成 99
    const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
    buf.writeUInt16LE(99, cdOffset + 10);
    // 本地头同步，避免先被「本地/中央不一致」拦下
    buf.writeUInt16LE(99, 8);
    const zip = tmp('dir-bad-method.zip');
    fs.writeFileSync(zip, buf);
    expect(vr.parseZip(zip).problems.join('；')).toMatch(/不支持的压缩方法/);
  });

  it('目录条目置加密位 → 拒绝', () => {
    const buf = buildZip([{ name: 'e/', isDir: true }, { name: 'e/f.txt', data: Buffer.from('F'), method: 0 }]);
    const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
    buf.writeUInt16LE(0x1, cdOffset + 8);
    buf.writeUInt16LE(0x1, 6); // 本地头 flags 同步
    const zip = tmp('dir-encrypted.zip');
    fs.writeFileSync(zip, buf);
    expect(vr.parseZip(zip).problems.join('；')).toMatch(/已加密/);
  });
});
