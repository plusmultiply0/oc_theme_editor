/**
 * 准备区生成与校验（T35）。
 *
 * 关键点：
 * - 目标归档里存在 unpacked 条目（本机实测 47 个原生模块）与 `app.asar.unpacked` 目录。
 *   重打包必须原样保留 unpacked 标记，否则原生模块无法加载、应用直接打不开。
 *   因此这里按原始 header 的 unpacked 集合逐个条目重建，而不是无脑 createPackage。
 * - 只改白名单内的条目；其他条目必须逐字节不变，条目集合不得减少。
 * - HTML 注入幂等：重复换主题不会累积多条 link。
 * - 不修改可执行文件，不动安全开关。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { createPackageFromStreams, extractAll } from '@electron/asar';
import type { TargetAdapter } from '../../adapters/types';
import { fail, ok, type Result } from '../../shared/errors';
import { readAsar, sha256File } from './asar';
import { isSafeArchiveEntry, safeJoin } from './paths';

export interface StageLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxSingleFileBytes: number;
}

export const DEFAULT_STAGE_LIMITS: StageLimits = {
  maxFiles: 50_000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxSingleFileBytes: 512 * 1024 * 1024,
};

export interface StageInput {
  adapter: TargetAdapter;
  archivePath: string;
  /** 准备区目录，函数内部会清空重建 */
  workDir: string;
  css: string;
  imageBytes: Buffer;
  limits?: StageLimits;
}

export interface StageResult {
  stagedArchive: string;
  afterHash: string;
  added: string[];
  changed: string[];
  removed: string[];
  /** 打包后复核：unpacked 标记是否与原始一致 */
  unpackedPreserved: boolean;
  fileCount: number;
}

interface FileEntry {
  rel: string;
  abs: string;
  size: number;
  sha256: string;
}

const INJECT_COMMENT = '<!-- opencode-theme-switcher -->';

async function walk(dir: string, limits: StageLimits): Promise<Result<Map<string, FileEntry>>> {
  const out = new Map<string, FileEntry>();
  let total = 0;
  let count = 0;

  async function rec(current: string, prefix: string): Promise<Result<true>> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (e) {
      return fail('STAGE_FAILED', '准备区目录无法读取', '请重试。', String(e));
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(current, e.name);
      if (!isSafeArchiveEntry(rel)) {
        return fail('STAGE_FAILED', `准备区出现非法路径：${rel}`, '已中止，安装未被修改。');
      }
      if (e.isDirectory()) {
        const r = await rec(abs, rel);
        if (!r.success) return r;
        continue;
      }
      if (!e.isFile()) continue;
      count += 1;
      if (count > limits.maxFiles) {
        return fail('STAGE_FAILED', '归档条目数量超限', '已中止，安装未被修改。');
      }
      const st = await fs.stat(abs);
      total += st.size;
      if (st.size > limits.maxSingleFileBytes || total > limits.maxTotalBytes) {
        return fail('STAGE_FAILED', '归档体积超限，疑似归档炸弹', '已中止，安装未被修改。');
      }
      out.set(rel, { rel, abs, size: st.size, sha256: await sha256File(abs) });
    }
    return ok(true);
  }

  const r = await rec(dir, '');
  if (!r.success) return r;
  return ok(out);
}

/** 原始 header 中标记为 unpacked 的条目集合 */
export function collectUnpacked(header: Record<string, unknown>): Set<string> {
  const set = new Set<string>();
  const rec = (node: Record<string, unknown>, prefix: string) => {
    const files = (node.files ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, child] of Object.entries(files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) rec(child, rel);
      else if (child.unpacked) set.add(rel);
    }
  };
  rec(header, '');
  return set;
}

/** 幂等注入：先移除本工具此前插入的 link，再插入新的 */
export function injectLink(html: string, cssHref: string, anchor: string): Result<string> {
  if (!html.includes(anchor)) {
    return fail('STAGE_FAILED', 'HTML 入口中找不到注入锚点', '该版本可能不兼容；安装未被修改。');
  }
  const markerStart = html.indexOf(INJECT_COMMENT);
  let cleaned = html;
  if (markerStart >= 0) {
    const lineStart = html.lastIndexOf('\n', markerStart) + 1;
    const lineEnd = html.indexOf('\n', markerStart);
    const end = lineEnd === -1 ? html.length : lineEnd + 1;
    cleaned = `${html.slice(0, lineStart)}${html.slice(end)}`;
  }
  const link = `<link rel="stylesheet" href="${cssHref}"> ${INJECT_COMMENT}\n`;
  return ok(cleaned.replace(anchor, `${link}${anchor}`));
}

export async function stageChanges(input: StageInput): Promise<Result<StageResult>> {
  const limits = input.limits ?? DEFAULT_STAGE_LIMITS;
  const { adapter } = input;

  const snapshot = await readAsar(input.archivePath);
  if (!snapshot.success) return snapshot;
  const unpackedOriginal = collectUnpacked(snapshot.data.header);

  const appDir = path.join(input.workDir, 'app');
  await fs.rm(input.workDir, { recursive: true, force: true });
  await fs.mkdir(appDir, { recursive: true });

  try {
    extractAll(input.archivePath, appDir);
  } catch (e) {
    return fail('STAGE_FAILED', '归档解包失败', '安装未被修改；请确认磁盘空间充足后重试。', String(e));
  }

  // unpacked 文件的实体在同级 .unpacked 目录，重打包需要它们就位
  const unpackedDir = `${input.archivePath}.unpacked`;
  if (await exists(unpackedDir)) {
    await copyDirInto(unpackedDir, appDir);
  }

  const baseline = await walk(appDir, limits);
  if (!baseline.success) return baseline;

  // 写入白名单内的新资源
  const cssAbs = path.join(appDir, adapter.injection.cssFile);
  const imgAbs = path.join(appDir, adapter.injection.imageFile);
  const htmlAbs = path.join(appDir, adapter.injection.htmlEntry);
  const guard = safeJoin(appDir, adapter.injection.cssFile);
  if (!guard.success) return guard;

  try {
    await fs.mkdir(path.dirname(cssAbs), { recursive: true });
    await fs.writeFile(cssAbs, input.css, 'utf8');
    await fs.writeFile(imgAbs, input.imageBytes);
    const html = await fs.readFile(htmlAbs, 'utf8');
    const injected = injectLink(html, `./${path.basename(adapter.injection.cssFile)}`, adapter.injection.anchor);
    if (!injected.success) return injected;
    await fs.writeFile(htmlAbs, injected.data, 'utf8');
  } catch (e) {
    return fail('STAGE_FAILED', '写入主题资源失败', '安装未被修改；请重试。', String(e));
  }

  const after = await walk(appDir, limits);
  if (!after.success) return after;

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [rel, e] of after.data) {
    const before = baseline.data.get(rel);
    if (!before) added.push(rel);
    else if (before.sha256 !== e.sha256) changed.push(rel);
  }
  for (const rel of baseline.data.keys()) {
    if (!after.data.has(rel)) removed.push(rel);
  }

  if (removed.length > 0) {
    return fail('STAGE_FAILED', `准备区出现条目丢失：${removed.slice(0, 3).join('、')}`, '已中止，安装未被修改。');
  }
  const touched = [...added, ...changed];
  const illegal = touched.filter((rel) => !adapter.allowedChanges.includes(rel));
  if (illegal.length > 0) {
    return fail(
      'STAGE_FAILED',
      `变更超出白名单：${illegal.slice(0, 3).join('、')}`,
      '已中止，安装未被修改。',
    );
  }
  if (!touched.includes(adapter.injection.htmlEntry)) {
    return fail('STAGE_FAILED', 'HTML 入口未被修改，注入可能失败', '已中止，安装未被修改。');
  }

  // 按原始 unpacked 集合重建归档，避免原生模块被塞回包内
  const stagedArchive = path.join(input.workDir, 'staged.asar');
  try {
    const streams = await buildStreams(appDir, unpackedOriginal);
    await createPackageFromStreams(stagedArchive, streams);
  } catch (e) {
    return fail('STAGE_FAILED', '归档重建失败', '安装未被修改；请重试。', String(e));
  }

  const verify = await readAsar(stagedArchive);
  if (!verify.success) return verify;
  const unpackedStaged = collectUnpacked(verify.data.header);
  const unpackedPreserved =
    unpackedStaged.size === unpackedOriginal.size &&
    [...unpackedOriginal].every((rel) => unpackedStaged.has(rel));
  if (!unpackedPreserved) {
    return fail(
      'STAGE_FAILED',
      '重建后 unpacked 标记与原归档不一致',
      '已中止，安装未被修改；原生模块可能因此无法加载。',
    );
  }

  const stagedFiles = new Set(listPaths(verify.data.header));
  for (const rel of after.data.keys()) {
    if (!stagedFiles.has(rel)) {
      return fail('STAGE_FAILED', `重建后缺少条目：${rel}`, '已中止，安装未被修改。');
    }
  }

  const afterHash = await sha256File(stagedArchive);
  return ok({
    stagedArchive,
    afterHash,
    added,
    changed,
    removed,
    unpackedPreserved,
    fileCount: stagedFiles.size,
  });
}

function listPaths(header: Record<string, unknown>): string[] {
  const out: string[] = [];
  const rec = (node: Record<string, unknown>, prefix: string) => {
    const files = (node.files ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, child] of Object.entries(files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) rec(child, rel);
      else out.push(rel);
    }
  };
  rec(header, '');
  return out;
}

/** 按目录内容构造 asar 流；unpacked 标记来自原始归档 */
async function buildStreams(appDir: string, unpacked: Set<string>) {
  // stat 必须是原始 fs.Stats：asar 内部直接取 stat.size / stat.mode
  const streams: {
    path: string;
    unpacked: boolean;
    stat: ReturnType<typeof statSync>;
    type: 'directory' | 'file';
    streamGenerator?: () => NodeJS.ReadableStream;
  }[] = [];

  const rec = async (current: string, prefix: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) {
        streams.push({
          path: rel,
          type: 'directory',
          unpacked: false,
          stat: statSync(abs),
        });
        await rec(abs, rel);
        continue;
      }
      if (!e.isFile()) continue;
      streams.push({
        path: rel,
        type: 'file',
        unpacked: unpacked.has(rel),
        stat: statSync(abs),
        streamGenerator: () => createReadStream(abs),
      });
    }
  };

  await rec(appDir, '');
  return streams as Parameters<typeof createPackageFromStreams>[1];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 把 unpacked 实体目录内容并入解包目录，不覆盖已存在文件 */
async function copyDirInto(src: string, dst: string): Promise<void> {
  const rec = async (current: string, rel: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const s = path.join(current, e.name);
      const d = path.join(dst, r);
      if (e.isDirectory()) {
        await fs.mkdir(d, { recursive: true });
        await rec(s, r);
        continue;
      }
      if (!e.isFile()) continue;
      if (await exists(d)) continue;
      await fs.mkdir(path.dirname(d), { recursive: true });
      await fs.copyFile(s, d);
    }
  };
  await rec(src, '');
}
