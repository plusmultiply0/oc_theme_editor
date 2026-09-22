/**
 * 归档不可变校验（事故 F2 硬门禁）。
 *
 * 背景：handoff/startup-incident-2026-09-11/RECOVERY_AND_FIX.md。
 * 之前 stage 只比对「解包目录」，打包后只检查条目名与 unpacked 集合，
 * 从不验证每个输出条目与输入字节一致；commit 又只校验最终文件是否等于 staged 文件。
 * 于是「staged 本来就坏了」也能一路走到 applied，而且每次都会为坏内容重算出
 * 自洽的 hash —— 当前错误数为零不等于内容正确。
 *
 * 这里的三条独立防线（互相独立，缺一条都拦不住这次事故）：
 *  1. `verifyIntegrity`：逐条按归档头里的完整性字段核对内容（hash + 分块）。
 *     能拦住「字节被改动但头部没跟上」。
 *  2. `checkScripts`：对非白名单的 .js/.json 按各自语义做解析检查。
 *     能拦住「内容自洽但本身就是截断/坏文件」——本次事故的形态，
 *     坏内容的 hash 是打包器重新算出来的，自校验必然通过。
 *  3. `compareWithBaseline`：与首次接管快照的逐条基线比对，产出**结构化差异**。
 *     输入侧由调用方分类裁决（官方整体更新→重新接管；零星改动→拒绝，见 classifyDrift）；
 *     产物侧（`verifyPackedResult`）不放宽——staged 有任何差异即拒绝提交。
 *
 * 另有 `findSharedOffsetConflicts`：同 offset 条目必须同内容同长度。
 * 事故里两个不同文件共享 offset 且 size 不同，这条能直接抓住。
 *
 * 哈希是内容身份，不是有效性证明 —— 所以 1 和 2 缺一不可。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { fail, ok, type Result } from '../../shared/errors';
// 注意：这里必须用物理 fs。Electron 主进程的 `node:fs` 被包装过，
// `.asar` 路径会被当成虚拟目录，校验会直接 ENOENT（与事故 R1 同源）。
import { physicalFs, physicalFsp } from './physical-fs';

export interface ArchiveIntegrity {
  algorithm: string;
  hash: string;
  blockSize: number;
  blocks: string[];
}

export interface ArchiveEntry {
  path: string;
  size: number;
  offset: number;
  unpacked: boolean;
  link?: string;
  integrity?: ArchiveIntegrity;
}

export interface ArchiveScan {
  archivePath: string;
  archiveSize: number;
  /** 数据区起点：条目 offset 以这里为基准 */
  dataStart: number;
  entries: Map<string, ArchiveEntry>;
}

export interface EntryBaseline {
  path: string;
  size: number;
  sha256: string;
  unpacked: boolean;
}

/** 基线文件的伴生元数据（v2 信封）；旧格式数组没有这些字段 */
export interface BaselineMeta {
  /** 基线对应归档的 package.json version；无法判定时为 null */
  version: string | null;
  /** 基线对应归档的 sha256 指纹 */
  fingerprint: string | null;
  /** 基线对应归档的 unpacked 条目路径集合（官方更新的天然信号之一） */
  unpackedPaths: string[];
}

export interface StoredBaseline {
  entries: Map<string, EntryBaseline>;
  /** null = 旧格式（裸数组），无元数据 */
  meta: BaselineMeta | null;
}

export const BASELINE_FILENAME = 'baseline.json';

/** 解析归档头与全部条目，并做边界检查；不做内容校验 */
export function scanArchive(archivePath: string): Result<ArchiveScan> {
  let header: Record<string, unknown>;
  let dataStart = 0;
  let archiveSize = 0;
  try {
    const fd = physicalFs.openSync(archivePath, 'r');
    try {
      const pre = Buffer.alloc(16);
      physicalFs.readSync(fd, pre, 0, 16, 0);
      if (pre.readUInt32LE(0) !== 4) {
        return fail(
      'ARCHIVE_CORRUPT',
      '不是有效的 ASAR 归档（magic 不符）',
      '该安装可能已被损坏；请先恢复，不要继续换肤。',
    );
      }
      // ASAR 布局：[u32=4][u32=头 pickle 大小][u32=载荷长度][u32=JSON 长度][JSON…][数据区]
      const headerPickleSize = pre.readUInt32LE(4);
      const headerJsonSize = pre.readUInt32LE(12);
      archiveSize = physicalFs.fstatSync(fd).size;
      dataStart = 8 + headerPickleSize;
      // 边界检查：JSON 必须落在头部区之内，数据区起点必须落在文件之内
      if (16 + headerJsonSize > dataStart || dataStart > archiveSize) {
        return fail(
          'ARCHIVE_CORRUPT',
          '归档头部越界',
          '该安装可能已被损坏；请先恢复，不要继续换肤。',
          `dataStart=${dataStart} jsonSize=${headerJsonSize} fileSize=${archiveSize}`,
        );
      }
      const buf = Buffer.alloc(headerJsonSize);
      physicalFs.readSync(fd, buf, 0, headerJsonSize, 16);
      header = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    } finally {
      physicalFs.closeSync(fd);
    }
  } catch (e) {
    return fail(
      'ARCHIVE_CORRUPT',
      '归档头部无法解析',
      '该安装可能已被损坏；请先恢复，不要继续换肤。',
      e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    );
  }

  const entries = new Map<string, ArchiveEntry>();
  const problems: string[] = [];
  (function walk(node: Record<string, unknown>, parts: string[]): void {
    const files = (node.files ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, value] of Object.entries(files)) {
      const rel = [...parts, name].join('/');
      if (value.files) {
        walk(value, [...parts, name]);
        continue;
      }
      const size = typeof value.size === 'number' ? value.size : NaN;
      const offset = typeof value.offset === 'string' ? Number(value.offset) : NaN;
      const unpacked = value.unpacked === true;
      const link = typeof value.link === 'string' ? value.link : undefined;
      const entry: ArchiveEntry = { path: rel, size, offset, unpacked, ...(link ? { link } : {}) };
      if (typeof value.integrity === 'object' && value.integrity !== null) {
        const ig = value.integrity as Partial<ArchiveIntegrity>;
        if (typeof ig.hash === 'string' && typeof ig.blockSize === 'number' && Array.isArray(ig.blocks)) {
          entry.integrity = {
            algorithm: String(ig.algorithm ?? 'SHA256'),
            hash: ig.hash,
            blockSize: ig.blockSize,
            blocks: ig.blocks,
          };
        }
      }
      // 边界检查：unpacked / link 条目没有归档内数据区，不参与
      if (unpacked || link) {
        entries.set(rel, entry);
        continue;
      }
      if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < 0 || size < 0) {
        problems.push(`${rel}（offset/size 非法：${String(value.offset)}/${String(value.size)}）`);
        entries.set(rel, entry);
        continue;
      }
      if (offset + size > archiveSize - dataStart) {
        problems.push(`${rel}（条目越界：${offset}+${size} 超出数据区 ${archiveSize - dataStart}）`);
      }
      entries.set(rel, entry);
    }
  })(header, []);

  if (problems.length > 0) {
    return fail(
      'ARCHIVE_CORRUPT',
      `归档条目边界异常（${problems.length} 条）`,
      '该安装可能已被损坏或被其他程序改动；请先恢复，不要继续换肤。',
      problems.slice(0, 10).join('；'),
    );
  }

  return ok({ archivePath, archiveSize, dataStart, entries });
}

function readEntryBytes(scan: ArchiveScan, entry: ArchiveEntry): Buffer {
  const buf = Buffer.alloc(entry.size);
  const fd = physicalFs.openSync(scan.archivePath, 'r');
  try {
    physicalFs.readSync(fd, buf, 0, entry.size, scan.dataStart + entry.offset);
  } finally {
    physicalFs.closeSync(fd);
  }
  return buf;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 逐条按头部完整性字段核对内容（hash + 分块） */
export async function verifyIntegrity(
  scan: ArchiveScan,
): Promise<Result<{ checked: number; skipped: number }>> {
  const problems: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const entry of scan.entries.values()) {
    if (entry.unpacked || entry.link) {
      skipped += 1;
      continue;
    }
    if (!entry.integrity) {
      // 头部没有完整性字段：无法证明内容，按异常处理
      problems.push(`${entry.path}（缺少完整性字段）`);
      continue;
    }
    if (entry.integrity.algorithm && entry.integrity.algorithm.toUpperCase() !== 'SHA256') {
      problems.push(`${entry.path}（未知完整性算法 ${entry.integrity.algorithm}）`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readEntryBytes(scan, entry);
    } catch (e) {
      problems.push(`${entry.path}（读取失败：${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    if (bytes.length !== entry.size) {
      problems.push(`${entry.path}（实际 ${bytes.length} 字节，头部声明 ${entry.size}）`);
      continue;
    }
    const whole = sha256(bytes);
    if (whole !== entry.integrity.hash) {
      problems.push(`${entry.path}（整体 hash 不符）`);
      continue;
    }
    const bs = entry.integrity.blockSize;
    if (!Number.isInteger(bs) || bs <= 0) {
      problems.push(`${entry.path}（分块大小非法 ${bs}）`);
      continue;
    }
    /*
     * 空文件（size=0）没有可分块的字节：整体 hash 已按空内容核对通过，
     * 分块比较没有意义（真实安装里打包器给空文件记 [sha256(空)] 或不记块，两种都合法）。
     * drizzle-orm 等包里就有一批真实空文件（哈希 e3b0c442…）。
     */
    if (bytes.length > 0) {
      const blocks: string[] = [];
      for (let o = 0; o < bytes.length; o += bs) {
        blocks.push(sha256(bytes.subarray(o, o + bs)));
      }
      if (blocks.length !== entry.integrity.blocks.length) {
        problems.push(`${entry.path}（分块数不符：算出 ${blocks.length}，头部 ${entry.integrity.blocks.length}）`);
        continue;
      }
      for (let i = 0; i < blocks.length; i += 1) {
        if (blocks[i] !== entry.integrity.blocks[i]) {
          problems.push(`${entry.path}（第 ${i + 1} 块 hash 不符）`);
          break;
        }
      }
    }
    checked += 1;
    // 让出事件循环：大归档逐条 hash 不能把主进程卡死
    if (checked % 200 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  if (problems.length > 0) {
    return fail(
      'ARCHIVE_CORRUPT',
      `归档内容与头部完整性不符（${problems.length} 条）`,
      '该安装可能已被损坏；请先恢复，不要继续换肤。',
      problems.slice(0, 10).join('；'),
    );
  }
  return ok({ checked, skipped });
}

/**
 * 同 offset 的条目必须同内容同长度。
 * 事故形态：两个不同文件共享 offset 且 size 不同，第二个读出来是第一个的前 N 字节。
 */
export function findSharedOffsetConflicts(scan: ArchiveScan): Result<{ groups: number }> {
  const byOffset = new Map<number, ArchiveEntry[]>();
  for (const entry of scan.entries.values()) {
    /*
     * 空文件（size=0）排除：它没有内容，打包器给它们分配「当前 offset」
     * 且不推进数据区，因此与相邻文件共享 offset 是合法产物
     * （真实安装取证：drizzle-orm / @standard-schema 的一批空占位文件）。
     * 事故形态是**两个非空**文件共享 offset 且长度不同 —— 仍然要拦。
     */
    if (entry.unpacked || entry.link || entry.size === 0) continue;
    const list = byOffset.get(entry.offset) ?? [];
    list.push(entry);
    byOffset.set(entry.offset, list);
  }
  const problems: string[] = [];
  let groups = 0;
  for (const list of byOffset.values()) {
    if (list.length < 2) continue;
    groups += 1;
    const first = list[0];
    for (const other of list.slice(1)) {
      if (other.size !== first.size) {
        problems.push(
          `${other.path}（${other.size}B）与 ${first.path}（${first.size}B）共享 offset ${first.offset} 但长度不同`,
        );
        continue;
      }
      const a = sha256(readEntryBytes(scan, first));
      const b = sha256(readEntryBytes(scan, other));
      if (a !== b) {
        problems.push(`${other.path} 与 ${first.path} 共享 offset ${first.offset} 但内容不同`);
      }
    }
  }
  if (problems.length > 0) {
    return fail(
      'ARCHIVE_CORRUPT',
      `共享 offset 的条目内容不一致（${problems.length} 条）`,
      '这是打包内容来源混用的典型形态；请先恢复，不要继续换肤。',
      problems.slice(0, 10).join('；'),
    );
  }
  return ok({ groups });
}

/** 无法判定的标记（例如运行时不支持 vm.SourceTextModule）；跳过并如实计数，绝不误判 */
const SKIP_UNSUPPORTED = '__skip_unsupported__';

/**
 * 判断一个脚本的语法是否完好。
 *
 * 三级策略（真实安装取证后确定，误报会挡住正常安装）：
 * 1. 剥掉 shebang 后按 **Node 的 CJS 模块包装器** 解析 ——
 *    顶层 `return`（mkdirp/bin/cmd.js）、`require` 都是合法 CJS，裸 vm.Script 会误判；
 * 2. 失败再按 ESM 解析 —— `export *`、行中 export（httpApiSwagger.js 里
 *    export 出现在行内注释之后）都能覆盖；
 * 3. 两者都失败才是损坏；ESM 能力不可用时，若形态表明是 ESM，
 *    如实按「无法判定」跳过并计数，绝不误判为损坏。
 */
function syntaxProblem(rel: string, source: string): string | null {
  const body = source.replace(/^#![^\n]*/, '');
  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${body}\n});`;
  try {
    new vm.Script(wrapped, { filename: rel });
    return null;
  } catch (cjsError) {
    if (typeof vm.SourceTextModule === 'function') {
      try {
        new vm.SourceTextModule(source, { identifier: rel });
        return null;
      } catch (esmError) {
        return esmError instanceof Error ? `${esmError.name}: ${esmError.message}` : String(esmError);
      }
    }
    // ESM 不可用：能安全判定的只有「确定不是 ESM 形态」的损坏
    const esmShaped =
      /\b(?:import|export)[\s{*(]/.test(source) ||
      /\bimport\s*\(/.test(source) ||
      /'export'|'import'/.test(String(cjsError));
    if (esmShaped) return SKIP_UNSUPPORTED;
    return cjsError instanceof Error ? `${cjsError.name}: ${cjsError.message}` : String(cjsError);
  }
}

/**
 * 非白名单的 .js/.json 逐条解析检查。
 * 哈希只能证明「内容和打包时一样」，不能证明「内容是好的」——
 * 本次事故的坏文件正是打包器为它重算了 hash 才一路绿灯。
 */
export async function checkScripts(
  scan: ArchiveScan,
  opts: { isAllowed: (entry: string) => boolean },
): Promise<Result<{ checked: number; skipped: number; unsupported: number }>> {
  const problems: string[] = [];
  let checked = 0;
  let skipped = 0;
  let unsupported = 0;
  for (const entry of scan.entries.values()) {
    if (entry.unpacked || entry.link) continue;
    if (opts.isAllowed(entry.path)) continue;
    const ext = path.extname(entry.path).toLowerCase();
    if (ext === '.json') {
      const text = readEntryBytes(scan, entry).toString('utf8');
      try {
        JSON.parse(text);
        checked += 1;
      } catch (e) {
        problems.push(`${entry.path}（JSON 解析失败：${e instanceof Error ? e.message : String(e)}）`);
      }
      continue;
    }
    if (!['.js', '.cjs', '.mjs', '.mts', '.cts'].includes(ext)) continue;
    const source = readEntryBytes(scan, entry).toString('utf8');
    const problem = syntaxProblem(entry.path, source);
    if (problem === SKIP_UNSUPPORTED) {
      unsupported += 1;
      continue;
    }
    if (problem === null) {
      checked += 1;
      continue;
    }
    problems.push(`${entry.path}（${problem}）`);
    skipped += 1;
  }
  if (problems.length > 0) {
    return fail(
      'ARCHIVE_CORRUPT',
      `归档内有无法解析的脚本（${problems.length} 条）`,
      '哈希自洽不代表内容正确；请先恢复，不要继续换肤。',
      problems.slice(0, 10).join('；'),
    );
  }
  return ok({ checked, skipped, unsupported });
}

/**
 * 从归档里建立非白名单条目的基线（size + 内容 sha256）+ unpacked 路径集合。
 * 白名单条目本来就会被替换/新增，不进基线。
 * unpacked 实体在归档外算不了 hash，但**路径集合**要随基线保存——
 * 重新接管判据条件⑤（原生模块集合是否一致）需要基线侧的记录。
 */
export async function buildBaseline(
  archivePath: string,
  isAllowed: (entry: string) => boolean,
): Promise<Result<{ entries: Map<string, EntryBaseline>; unpackedPaths: string[] }>> {
  const scan = scanArchive(archivePath);
  if (!scan.success) return scan;
  const baseline = new Map<string, EntryBaseline>();
  const unpackedPaths: string[] = [];
  for (const entry of scan.data.entries.values()) {
    if (isAllowed(entry.path)) continue;
    if (entry.unpacked || entry.link) {
      if (entry.unpacked) unpackedPaths.push(entry.path);
      continue;
    }
    baseline.set(entry.path, {
      path: entry.path,
      size: entry.size,
      sha256: sha256(readEntryBytes(scan.data, entry)),
      unpacked: false,
    });
    if (baseline.size % 500 === 0) await physicalFsp.readFile(archivePath).catch(() => undefined);
  }
  return ok({ entries: baseline, unpackedPaths: unpackedPaths.sort() });
}

export interface BaselineCompareOptions {
  /** 白名单条目允许与基线不同或不存在（它们本来就是要被替换/新增的） */
  isAllowed: (entry: string) => boolean;
}

/** 结构化差异清单（baseline-drift B1）：比对不再一票否决，由调用方分类裁决 */
export interface BaselineDriftChanged {
  path: string;
  why: 'size' | 'content';
  baselineSize: number;
  currentSize: number;
}

export interface BaselineDrift {
  /** 基线里有、当前也有，但大小或内容不同 */
  changed: BaselineDriftChanged[];
  /** 基线里有、当前缺失 */
  missing: string[];
  /** 当前新增、基线里没有（非白名单） */
  added: string[];
  /** 基线是打包条目，当前变成 unpacked/link */
  kindChanged: string[];
}

export function countDrift(drift: BaselineDrift): number {
  return drift.changed.length + drift.missing.length + drift.added.length + drift.kindChanged.length;
}

/** 供拒绝文案与明细复用的逐条描述（与旧 fail detail 口径一致） */
export function describeDrift(drift: BaselineDrift): string[] {
  return [
    ...drift.changed.map((c) =>
      c.why === 'size'
        ? `${c.path}（大小 ${c.currentSize}，基线 ${c.baselineSize}）`
        : `${c.path}（内容与首次接管时不同）`,
    ),
    ...drift.missing.map((p) => `${p}（基线里有，当前归档缺失）`),
    ...drift.kindChanged.map((p) => `${p}（基线是打包条目，当前变成了 unpacked/link）`),
    ...drift.added.map((p) => `${p}（首次接管时不存在，当前归档新增）`),
  ];
}

/**
 * 把当前归档的非白名单条目与基线比对，返回**结构化差异**而不是直接拒绝。
 * 基线来自首次接管快照 —— 那是本工具接手时的状态；差异如何裁决见 classifyDrift。
 */
export async function compareWithBaseline(
  archivePath: string,
  baseline: Map<string, EntryBaseline>,
  opts: BaselineCompareOptions,
): Promise<Result<{ compared: number; drift: BaselineDrift; currentUnpacked: string[] }>> {
  const scan = scanArchive(archivePath);
  if (!scan.success) return scan;
  const drift: BaselineDrift = { changed: [], missing: [], added: [], kindChanged: [] };
  let compared = 0;
  for (const [entry, want] of baseline) {
    if (opts.isAllowed(entry)) continue;
    const now = scan.data.entries.get(entry);
    if (!now) {
      drift.missing.push(entry);
      continue;
    }
    if (now.unpacked || now.link) {
      drift.kindChanged.push(entry);
      continue;
    }
    if (now.size !== want.size) {
      drift.changed.push({
        path: entry,
        why: 'size',
        baselineSize: want.size,
        currentSize: now.size,
      });
      continue;
    }
    const got = sha256(readEntryBytes(scan.data, now));
    if (got !== want.sha256) {
      drift.changed.push({
        path: entry,
        why: 'content',
        baselineSize: want.size,
        currentSize: now.size,
      });
      continue;
    }
    compared += 1;
    if (compared % 500 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  // 目标里新出现的非白名单打包条目：基线里没有，说明被外部塞进来了
  for (const entry of scan.data.entries.values()) {
    if (baseline.has(entry.path) || opts.isAllowed(entry.path)) continue;
    if (entry.unpacked || entry.link) continue;
    drift.added.push(entry.path);
  }
  // 与 buildBaseline 口径一致：白名单条目不参与 unpacked 集合比对
  const currentUnpacked = [...scan.data.entries.values()]
    .filter((e) => e.unpacked && !opts.isAllowed(e.path))
    .map((e) => e.path)
    .sort();
  return ok({ compared, drift, currentUnpacked });
}

/*
 * 重新接管（re-baseline）判据阈值 —— 命名常量，单测固定，不散落逻辑。
 * 官方整体更新会换掉绝大多数条目；零星改动不是。取保守值：
 * 差异规模不足一半、又没到「package.json 变了且 ≥100 条」的量级，一律按可疑处理。
 */
export const REBASELINE_DRIFT_RATIO = 0.5;
export const REBASELINE_DRIFT_MIN_COUNT = 100;

export type DriftVerdictKind = 'official-update' | 'suspicious';

export interface DriftConditionResult {
  key: 'versionChanged' | 'anchorUnique' | 'changeSetClean' | 'driftScale' | 'unpackedSet';
  passed: boolean;
  detail: string;
}

export interface DriftVerdict {
  verdict: DriftVerdictKind;
  driftCount: number;
  /** 五条件的逐条判定依据（通过与否都要留痕，供明细与文案消费） */
  conditions: DriftConditionResult[];
}

export interface DriftClassifyInput {
  drift: BaselineDrift;
  /** 基线条目总数（比例阈值分母） */
  baselineCount: number;
  /** 当前归档 package.json 的 version；读不到为 null */
  archiveVersion: string | null;
  /** 基线对应归档的 version；旧基线无记录时为 null */
  baselineVersion: string | null;
  /** verifyStructure 检查 1：注入锚点恰好 1 处 */
  anchorUnique: boolean;
  /** verifyStructure 检查 2：css/jpg 变更集合干净（不存在或本工具产物） */
  changeSetClean: boolean;
  currentUnpacked: readonly string[];
  /** 基线侧 unpacked 路径集合；旧基线无记录时为 null（按不可判定处理） */
  baselineUnpacked: readonly string[] | null;
}

/**
 * 差异分类裁决（纯函数，无 IO）：五条件**同时满足**才判 official-update，
 * 任一不过即 suspicious —— 宁拒勿纵。拒绝路径仍由调用方维持硬门禁语义。
 */
export function classifyDrift(input: DriftClassifyInput): DriftVerdict {
  const driftCount = countDrift(input.drift);
  const conditions: DriftConditionResult[] = [];

  // ① 版本确实变了（双方都得有记录才可比）
  const versionChanged =
    input.archiveVersion !== null &&
    input.baselineVersion !== null &&
    input.archiveVersion !== input.baselineVersion;
  conditions.push({
    key: 'versionChanged',
    passed: versionChanged,
    detail:
      input.archiveVersion === null
        ? '当前归档读不到 version，无法与基线比对'
        : input.baselineVersion === null
          ? '基线无对应 version 记录，无法证明版本变化'
          : `归档 version=${input.archiveVersion} 基线 version=${input.baselineVersion}${versionChanged ? '（不同）' : '（相同，非更新）'}`,
  });

  // ② 锚点仍唯一
  conditions.push({
    key: 'anchorUnique',
    passed: input.anchorUnique,
    detail: input.anchorUnique ? '注入锚点恰好 1 处' : '锚点消失或不唯一，补丁不适用',
  });

  // ③ 变更集合干净
  conditions.push({
    key: 'changeSetClean',
    passed: input.changeSetClean,
    detail: input.changeSetClean ? 'css/图片条目不存在或为本工具产物' : '变更集合被第三方占用',
  });

  // ④ 差异规模达到「整体替换」量级
  const ratioHit = driftCount >= input.baselineCount * REBASELINE_DRIFT_RATIO;
  const packageJsonChanged = input.drift.changed.some((c) => c.path === 'package.json');
  const minCountHit = packageJsonChanged && driftCount >= REBASELINE_DRIFT_MIN_COUNT;
  conditions.push({
    key: 'driftScale',
    passed: ratioHit || minCountHit,
    detail: `差异 ${driftCount}/${input.baselineCount} 条，阈值：≥${Math.ceil(input.baselineCount * REBASELINE_DRIFT_RATIO)} 条（50%）或 package.json 变化且 ≥${REBASELINE_DRIFT_MIN_COUNT} 条（package.json 变化=${packageJsonChanged}）`,
  });

  // ⑤ unpacked 原生模块路径集合一致（数量与路径，内容不验——官方更新必换内容）
  const wantUnpacked = input.baselineUnpacked === null ? null : [...input.baselineUnpacked].sort();
  const nowUnpacked = [...input.currentUnpacked].sort();
  const unpackedSet =
    wantUnpacked !== null &&
    wantUnpacked.length === nowUnpacked.length &&
    wantUnpacked.every((p, i) => p === nowUnpacked[i]);
  conditions.push({
    key: 'unpackedSet',
    passed: unpackedSet,
    detail:
      input.baselineUnpacked === null
        ? '基线无 unpacked 集合记录，无法核对原生模块结构'
        : `当前 ${input.currentUnpacked.length} 个 vs 基线 ${input.baselineUnpacked.length} 个${unpackedSet ? '（一致）' : '（不一致）'}`,
  });

  const verdict: DriftVerdictKind = conditions.every((c) => c.passed)
    ? 'official-update'
    : 'suspicious';
  return { verdict, driftCount, conditions };
}

/**
 * 把基线写进首次接管的备份目录（与备份一起保存）；先写临时文件再改名，避免半截 JSON。
 * v2 信封带元数据（version/fingerprint/unpackedPaths）——重新接管判据要读回它们。
 */
export async function writeBaselineFile(
  dir: string,
  baseline: Map<string, EntryBaseline>,
  meta: BaselineMeta,
): Promise<Result<void>> {
  try {
    const payload = [...baseline.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    const tmp = path.join(dir, `${BASELINE_FILENAME}.tmp`);
    await physicalFsp.mkdir(dir, { recursive: true });
    await physicalFsp.writeFile(
      tmp,
      JSON.stringify({ schema: 2, meta, entries: payload }, null, 2),
      'utf8',
    );
    await physicalFsp.rename(tmp, path.join(dir, BASELINE_FILENAME));
    return ok(undefined);
  } catch (e) {
    return fail('BACKUP_FAILED', '基线文件写入失败', '未对安装产生任何改动。', String(e));
  }
}

export async function readBaselineFile(
  dir: string,
): Promise<Result<StoredBaseline | null>> {
  const file = path.join(dir, BASELINE_FILENAME);
  try {
    const raw = JSON.parse(await physicalFsp.readFile(file, 'utf8')) as unknown;
    // 旧格式：裸数组，无元数据（重新接管判据会缺版本与 unpacked 记录，由调用方回退推导）
    if (Array.isArray(raw)) {
      const rows = raw as EntryBaseline[];
      return ok({ entries: new Map(rows.map((r) => [r.path, r] as const)), meta: null });
    }
    const envelope = raw as { schema?: number; meta?: BaselineMeta; entries?: EntryBaseline[] };
    if (envelope.schema !== 2 || !Array.isArray(envelope.entries)) return ok(null);
    const m = envelope.meta;
    return ok({
      entries: new Map(envelope.entries.map((r) => [r.path, r] as const)),
      meta:
        m && Array.isArray(m.unpackedPaths)
          ? {
              version: typeof m.version === 'string' ? m.version : null,
              fingerprint: typeof m.fingerprint === 'string' ? m.fingerprint : null,
              unpackedPaths: m.unpackedPaths,
            }
          : null,
    });
  } catch {
    return ok(null);
  }
}

/**
 * 重新接管前把当前基线文件按序号归档（baseline.v1.json 递增）。
 * 旧基线永不覆盖删除——与备份同目录留存，可追溯。
 */
export async function archiveCurrentBaselineFile(dir: string): Promise<Result<number>> {
  try {
    const names = await physicalFsp.readdir(dir);
    let maxSeq = 0;
    for (const n of names) {
      const m = /^baseline\.v(\d+)\.json$/.exec(n);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    const seq = maxSeq + 1;
    await physicalFsp.rename(
      path.join(dir, BASELINE_FILENAME),
      path.join(dir, `baseline.v${seq}.json`),
    );
    return ok(seq);
  } catch (e) {
    return fail(
      'BACKUP_FAILED',
      '旧基线归档失败，未开始重新接管',
      '未对安装产生任何改动。',
      String(e),
    );
  }
}

export interface PackedVerifyInput {
  /** 重打包出来的归档 */
  stagedArchive: string;
  /** 原始归档的**全部**条目集合（用于「不能少、不能多」检查） */
  originalEntries: ReadonlySet<string>;
  /** 原始归档的 unpacked 集合（必须原样保留） */
  unpackedOriginal: ReadonlySet<string>;
  /** 非白名单条目基线（来自首次接管快照） */
  baseline?: Map<string, EntryBaseline>;
  /** 白名单条目的预期新内容（归档内路径 → 字节/文本） */
  expected?: Map<string, string | Buffer>;
  /** 白名单 */
  allowedChanges: readonly string[];
}

/**
 * F2 硬门禁（第二部分）：重打包结果的逐条不可变校验。
 *
 * 之前 stage 只比对解包目录、打包后只看条目名与 unpacked 集合，
 * 从不验证输出与输入字节一致 —— 事故里 staged 本来就坏了也能一路 applied。
 *
 * 检查项（任一失败都拒绝进入 committing）：
 *  1. 逐条按头部完整性字段核对；
 *  2. 同 offset 条目内容一致（事故的直接形态）；
 *  3. unpacked 集合与原始一致；
 *  4. 条目集合：原始条目一个不缺、新增只允许白名单；
 *  5. 非白名单条目与基线完全一致（基线来自首次接管快照）；
 *  6. 白名单条目等于预期新内容。
 */
export async function verifyPackedResult(input: PackedVerifyInput): Promise<Result<{
  checked: number;
  unpackedPreserved: boolean;
}>> {
  const scan = scanArchive(input.stagedArchive);
  if (!scan.success) return scan;

  const integrity = await verifyIntegrity(scan.data);
  if (!integrity.success) return integrity;

  const shared = findSharedOffsetConflicts(scan.data);
  if (!shared.success) return shared;

  const stagedUnpacked = new Set(
    [...scan.data.entries.values()].filter((e) => e.unpacked).map((e) => e.path),
  );
  const unpackedPreserved =
    stagedUnpacked.size === input.unpackedOriginal.size &&
    [...input.unpackedOriginal].every((p) => stagedUnpacked.has(p));
  if (!unpackedPreserved) {
    return fail(
      'ARCHIVE_VERIFY_FAILED',
      '重建后 unpacked 标记与原归档不一致',
      '原生模块可能因此无法加载；已拒绝提交。',
    );
  }

  const isAllowed = (entry: string): boolean => input.allowedChanges.includes(entry);

  // 条目集合：不能少、新增只能是白名单
  const missing = [...input.originalEntries].filter((p) => !scan.data.entries.has(p));
  if (missing.length > 0) {
    return fail(
      'ARCHIVE_VERIFY_FAILED',
      `重建后缺少条目（${missing.length} 个）`,
      '已拒绝提交；安装未被修改。',
      missing.slice(0, 10).join('；'),
    );
  }
  const unexpected = [...scan.data.entries.keys()].filter(
    (p) => !input.originalEntries.has(p) && !isAllowed(p),
  );
  if (unexpected.length > 0) {
    return fail(
      'ARCHIVE_VERIFY_FAILED',
      `重建后出现计划外条目（${unexpected.length} 个）`,
      '已拒绝提交；安装未被修改。',
      unexpected.slice(0, 10).join('；'),
    );
  }

  // 白名单条目必须等于预期新内容
  const contentProblems: string[] = [];
  if (input.expected) {
    for (const [entry, want] of input.expected) {
      const node = scan.data.entries.get(entry);
      if (!node) {
        contentProblems.push(`${entry}（白名单条目缺失）`);
        continue;
      }
      if (node.unpacked) {
        contentProblems.push(`${entry}（白名单条目被标成 unpacked）`);
        continue;
      }
      const wantBuf = typeof want === 'string' ? Buffer.from(want, 'utf8') : want;
      const got = readEntryBytes(scan.data, node);
      if (got.length !== wantBuf.length || !got.equals(wantBuf)) {
        contentProblems.push(
          `${entry}（内容与预期不符：实际 ${got.length}B，预期 ${wantBuf.length}B）`,
        );
      }
    }
  }
  if (contentProblems.length > 0) {
    return fail(
      'ARCHIVE_VERIFY_FAILED',
      `白名单条目与预期内容不符（${contentProblems.length} 条）`,
      '已拒绝提交；安装未被修改。',
      contentProblems.slice(0, 10).join('；'),
    );
  }

  // 非白名单条目与基线比对。
  // 注意：这里是**产物门禁**（staged 必须等于基线+白名单预期），与 apply 入口的
  // 「输入基线门」不同——输入门做差异分类放行，产物门禁不放宽：有任何差异即拒绝提交。
  let compared = 0;
  if (input.baseline && input.baseline.size > 0) {
    const cmp = await compareWithBaseline(input.stagedArchive, input.baseline, { isAllowed });
    if (!cmp.success) return cmp;
    const problems = describeDrift(cmp.data.drift);
    if (problems.length > 0) {
      return fail(
        'ARCHIVE_CORRUPT',
        `重建结果与首次接管快照不一致（${problems.length} 条）`,
        '已拒绝提交；安装未被修改。',
        problems.slice(0, 10).join('；'),
      );
    }
    compared = cmp.data.compared;
  }

  return ok({ checked: scan.data.entries.size + compared, unpackedPreserved: true });
}
