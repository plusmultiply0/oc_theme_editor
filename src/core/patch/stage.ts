/**
 * 准备区生成与校验（T35、R3）。
 *
 * 关键点：
 * - 目标归档里存在 unpacked 条目（本机实测 47 个原生模块）与 `app.asar.unpacked` 目录。
 *   重打包必须原样保留 unpacked 标记，否则原生模块无法加载、应用直接打不开。
 *   因此这里按原始 header 的 unpacked 集合逐个条目重建，而不是无脑 createPackage。
 * - 只改白名单内的条目；其他条目必须逐字节不变，条目集合不得减少。
 * - HTML 注入幂等：重复换主题不会累积多条 link。
 * - **旧主题层必须先撤下**（R3）：原型时代的 snow-theme 用的是
 *   `html, body, #root { --x: … !important }`，只在后面追加新主题盖不住它。
 *   只撤下能确认来源与指纹的旧层；来源不明的第三方层直接拒绝，不自动覆盖。
 * - 不修改可执行文件，不动安全开关。
 *
 * R1：读取/解包/重打包全部走 physical-fs 与 archive-io，避免 Electron
 * 把 `*.asar` 当虚拟目录。
 */
import path from 'node:path';
import { fail, ok, type Result } from '../../shared/errors';
import type { TargetAdapter } from '../../adapters/types';
import { listAsarFiles, readAsar, readAsarText } from './asar';
import { extractArchive } from './archive-io';
import { packArchiveInWorker } from './pack';
import { physicalFsp, physicalSha256File } from './physical-fs';
import { isSafeArchiveEntry, safeJoin } from './paths';
import { analyzeThemeLayers, stripLinks } from './legacy-theme';
import { verifyPackedResult, type EntryBaseline } from './archive-verify';

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
  /**
   * 非白名单条目基线（来自首次接管快照）。
   * 提供后，重打包结果会与之逐条比对；事故 F2 的硬门禁。
   */
  baseline?: Map<string, EntryBaseline>;
}

export interface StageThemeLayers {
  /** 已撤下的旧主题层（id 与归档内路径） */
  removedLegacy: { id: string; entry: string }[];
  /** 留在归档里、没有动过的旧主题配套资源 */
  keptAssets: string[];
  /** 本工具的层是否已存在（用于判断是首次注入还是换主题） */
  selfPresent: boolean;
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
  /** 旧主题迁移预检的结果，供确认对话框展示 */
  themeLayers: StageThemeLayers;
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
      entries = await physicalFsp.readdir(current, { withFileTypes: true });
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
      const st = await physicalFsp.stat(abs);
      total += st.size;
      if (st.size > limits.maxSingleFileBytes || total > limits.maxTotalBytes) {
        return fail('STAGE_FAILED', '归档体积超限，疑似归档炸弹', '已中止，安装未被修改。');
      }
      out.set(rel, { rel, abs, size: st.size, sha256: await physicalSha256File(abs) });
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
  await physicalFsp.rm(input.workDir, { recursive: true, force: true });
  await physicalFsp.mkdir(appDir, { recursive: true });

  try {
    await extractArchive(input.archivePath, appDir);
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

  const readEntry = async (entry: string): Promise<string | null> => {
    const r = await readAsarText(snapshot.data, entry);
    return r.success ? r.data : null;
  };

  let themeLayers: StageThemeLayers = { removedLegacy: [], keptAssets: [], selfPresent: false };

  let html: string;
  try {
    html = await physicalFsp.readFile(htmlAbs, 'utf8');
  } catch (e) {
    return fail('STAGE_FAILED', '读取 HTML 入口失败', '安装未被修改；请重试。', String(e));
  }

  const analysis = await analyzeThemeLayers({ html, adapter, readEntry });

  // 来源不明的第三方主题层：拒绝叠加，不自动覆盖（R3）
  if (analysis.unknown.length > 0) {
    return fail(
      'THEME_CONFLICT',
      `目标里已有来源不明的样式层：${analysis.unknown.map((l) => l.entry).join('、')}`,
      '请先在原工具中移除该主题，或确认其来源后再重试；本工具不会覆盖未知样式。',
      analysis.unknown.map((l) => `${l.entry}：${l.reason ?? '来源不明'}`).join('；'),
    );
  }

  const injected = injectLink(
    stripLinks(html, analysis.removable),
    `./${path.basename(adapter.injection.cssFile)}`,
    adapter.injection.anchor,
  );
  if (!injected.success) return injected;

  try {
    await physicalFsp.mkdir(path.dirname(cssAbs), { recursive: true });
    await physicalFsp.writeFile(cssAbs, input.css, 'utf8');
    await physicalFsp.writeFile(imgAbs, input.imageBytes);
    await physicalFsp.writeFile(htmlAbs, injected.data, 'utf8');
  } catch (e) {
    return fail('STAGE_FAILED', '写入主题资源失败', '安装未被修改；请重试。', String(e));
  }

  themeLayers = {
    removedLegacy: analysis.knownLegacy.map((l) => ({
      id: l.source?.id ?? 'unknown',
      entry: l.entry,
    })),
    keptAssets: analysis.knownLegacy.flatMap((l) => l.source?.assets ?? []),
    selfPresent: analysis.self.length > 0,
  };

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

  // 按原始 unpacked 集合重建归档。
  // F1：打包必须在专用工作进程里做（cwd=解包根目录），不能在主进程里做——
  // 依赖库对 ≤2MB 文件会按「归档内逻辑路径」直接 readFileSync（相对 cwd），
  // 主进程 cwd 是开发项目时会把另一份同名文件的内容 hash 误用到目标安装上，
  // 导致两个不同文件被当成同一条、共享 offset（真机 jsonfile 被截断，OpenCode 无法启动）。
  const stagedArchive = path.join(input.workDir, 'staged.asar');
  const plan: { path: string; unpacked: boolean }[] = [];
  {
    const collect = async (current: string, prefix: string): Promise<void> => {
      const entries = await physicalFsp.readdir(current, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const abs = path.join(current, e.name);
        if (e.isDirectory()) {
          plan.push({ path: rel, unpacked: false });
          await collect(abs, rel);
          continue;
        }
        if (!e.isFile()) continue;
        plan.push({ path: rel, unpacked: unpackedOriginal.has(rel) });
      }
    };
    await collect(appDir, '');
  }
  const packed = await packArchiveInWorker(
    { appDir, stagedArchive, files: plan },
    { timeoutMs: 15 * 60 * 1000 },
  );
  if (!packed.success) {
    return fail(
      packed.error.code as 'STAGE_FAILED',
      packed.error.message,
      packed.error.recoveryHint,
      packed.error.detail,
    );
  }

  // F2 硬门禁：用独立读取器逐条核对重打包结果（不再只看条目名与 unpacked 集合）
  const verified = await verifyPackedResult({
    stagedArchive,
    originalEntries: new Set(listAsarFiles(snapshot.data.header)),
    unpackedOriginal,
    ...(input.baseline ? { baseline: input.baseline } : {}),
    allowedChanges: adapter.allowedChanges,
    expected: new Map<string, string | Buffer>([
      [adapter.injection.cssFile, input.css],
      [adapter.injection.imageFile, input.imageBytes],
      [adapter.injection.htmlEntry, injected.data],
    ]),
  });
  if (!verified.success) {
    return fail(
      verified.error.code as 'ARCHIVE_VERIFY_FAILED',
      verified.error.message,
      verified.error.recoveryHint,
      verified.error.detail,
    );
  }

  const afterHash = await physicalSha256File(stagedArchive);
  return ok({
    stagedArchive,
    afterHash,
    added,
    changed,
    removed,
    unpackedPreserved: verified.data.unpackedPreserved,
    fileCount: verified.data.checked,
    themeLayers,
  });
}



async function exists(p: string): Promise<boolean> {
  try {
    await physicalFsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 把 unpacked 实体目录内容并入解包目录，不覆盖已存在文件 */
async function copyDirInto(src: string, dst: string): Promise<void> {
  const rec = async (current: string, rel: string) => {
    const entries = await physicalFsp.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const s = path.join(current, e.name);
      const d = path.join(dst, r);
      if (e.isDirectory()) {
        await physicalFsp.mkdir(d, { recursive: true });
        await rec(s, r);
        continue;
      }
      if (!e.isFile()) continue;
      if (await exists(d)) continue;
      await physicalFsp.mkdir(path.dirname(d), { recursive: true });
      await physicalFsp.copyFile(s, d);
    }
  };
  await rec(src, '');
}
