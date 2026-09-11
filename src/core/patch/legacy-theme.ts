/**
 * 旧主题层识别与迁移预检（R3）。
 *
 * 问题（已在真机复现）：目标 HTML 里同时挂着官方主 CSS、
 * 原型时代注入的 `<link rel="stylesheet" href="./snow-theme.css" data-local-theme="snowfield">`，
 * 以及本工具的 `oc-theme-custom.css`。
 * 旧主题用的是 `html, body, #root { --x: … !important }`，而且 `#root` 上的变量会
 * 遮蔽来自根节点的继承——新主题只靠「后加载」根本盖不住它，两套主题就混着显示。
 *
 * 处理原则：
 * - 只撤下**能确认来源**的旧主题链接；文件本体留在归档里，随时可恢复。
 * - 来源不明的第三方主题层**默认拒绝**（THEME_CONFLICT），不自动覆盖、不盲目删除。
 * - 本工具的注入是幂等的，重复换主题不会累积多条 link。
 *
 * 真机取证（2026-09-11，只读）：
 * - 原型的 `theme-tool.cjs` 注入的就是
 *   `<link rel="stylesheet" href="./snow-theme.css" data-local-theme="snowfield">`；
 * - 后续的粉彩工具**原地覆盖了 snow-theme.css 的内容**、没有再动 HTML，
 *   因此真机上「链接标记写着 snowfield，文件内容其实是粉彩」。
 * 结论：标记（来源）与文件内容（指纹）要分开看——标记证明来源，内容用来告诉用户
 * 到底撤下的是哪一套；两者不一致时说明「被覆盖过」，而不是直接判为未知。
 */
import type { TargetAdapter } from '../../adapters/types';

/** HTML 里的一枚样式链接 */
export interface ThemeLink {
  /** 整个 <link …> 标签原样，便于精确替换 */
  raw: string;
  /** href 属性值原样（可能带 query） */
  href: string;
  /** 归档内相对路径，例如 out/renderer/snow-theme.css */
  entry: string;
  /** 该标签上的全部属性 */
  attributes: Record<string, string>;
}

/** 同一来源下可能出现的主题变体：靠内容特征区分「这文件里装的到底是哪一套」 */
export interface LegacyThemeVariant {
  id: string;
  label: string;
  /** 全部命中即判定为该变体 */
  tokens: string[];
}

/** 已知旧主题来源 */
export interface LegacyThemeSource {
  id: string;
  label: string;
  /** 注入器写下的标记属性名 */
  markerName: string;
  /** 已知的标记取值 */
  markerValues: string[];
  /** 已知的旧主题样式文件（归档内相对路径） */
  entries: string[];
  /** 已知变体 */
  variants: LegacyThemeVariant[];
  /** 与它配套、留在归档里不动的资源 */
  assets: string[];
}

/**
 * 原型时代（本工具之前）的主题注入来源。
 * 依据：`OpenCode/_Theme/_Switcher/theme-tool.cjs` 的注入语句，以及 2026-09-11 的真机只读取证。
 */
export const KNOWN_LEGACY_SOURCES: LegacyThemeSource[] = [
  {
    id: 'prototype-local-theme',
    label: '原型时代注入的本地主题',
    markerName: 'data-local-theme',
    markerValues: ['snowfield', 'pastel', 'arknights'],
    entries: [
      'out/renderer/snow-theme.css',
      'out/renderer/pastel-theme.css',
      'out/renderer/arknights-theme.css',
    ],
    variants: [
      { id: 'snowfield', label: '雪景（深色）', tokens: ['--snow-primary'] },
      { id: 'pastel', label: '粉彩（浅色）', tokens: ['--pastel-primary'] },
      { id: 'arknights', label: '明日方舟（暖金）', tokens: ['--ark-primary'] },
    ],
    assets: [
      'out/renderer/snow-background.jpg',
      'out/renderer/pastel-background.png',
      'out/renderer/arknights-background.jpg',
    ],
  },
];

/** 官方自身资源的判定：主进程打包时都在 assets/ 下，且不带自定义标记 */
const OFFICIAL_HREF_RE = /^\.?\/?(?:assets|favicon|apple-touch|social-share)/i;

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    out[name] = value;
  }
  return out;
}

/** 把 href 归一成归档内相对路径；外部地址返回 null（外部样式表不归本工具管） */
export function hrefToArchiveEntry(href: string, htmlEntry: string): string | null {
  const clean = href.split(/[?#]/)[0] ?? '';
  if (!clean) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  const baseDir = htmlEntry.includes('/') ? htmlEntry.slice(0, htmlEntry.lastIndexOf('/')) : '';
  const parts = clean.startsWith('/')
    ? clean.replace(/^\/+/, '').split('/')
    : `${baseDir}/${clean}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/** 抽出 HTML 中所有样式表链接 */
export function parseThemeLinks(html: string, htmlEntry: string): ThemeLink[] {
  const out: ThemeLink[] = [];
  for (const m of html.matchAll(LINK_TAG_RE)) {
    const raw = m[0];
    const attributes = parseAttributes(raw);
    if ((attributes['rel'] ?? '').toLowerCase().split(/\s+/).includes('stylesheet') === false) continue;
    const href = attributes['href'] ?? '';
    if (!href) continue;
    const entry = hrefToArchiveEntry(href, htmlEntry);
    if (!entry) continue;
    out.push({ raw, href, entry, attributes });
  }
  return out;
}

export type ThemeLinkKind = 'official' | 'self' | 'known-legacy' | 'unknown';

/** 内容与标记的吻合程度 */
export type FingerprintState = 'matched' | 'drifted' | 'unreadable';

export interface ClassifiedThemeLink extends ThemeLink {
  kind: ThemeLinkKind;
  source?: LegacyThemeSource;
  /** 该文件内容实际属于哪个变体；无法判定为 null */
  observedVariant?: LegacyThemeVariant | null;
  fingerprint: FingerprintState;
  reason?: string;
}

export interface ThemeLayerAnalysis {
  links: ClassifiedThemeLink[];
  self: ClassifiedThemeLink[];
  knownLegacy: ClassifiedThemeLink[];
  unknown: ClassifiedThemeLink[];
  /** 需要从 HTML 中撤下的 link 标签原文（本工具的层由幂等注入单独处理） */
  removable: string[];
  /** 面向用户的来源说明，逐条给出「撤下什么、为什么可以撤」 */
  notes: string[];
}

export interface AnalyzeThemeLayersInput {
  html: string;
  adapter: TargetAdapter;
  /** 读归档内文本条目；用于核对旧主题文件的内容指纹 */
  readEntry(entry: string): Promise<string | null>;
}

function isSelfLink(link: ThemeLink, adapter: TargetAdapter): boolean {
  const selfEntry = adapter.injection.cssFile;
  return link.entry === selfEntry || link.entry.endsWith(`/${selfEntry.split('/').pop()}`);
}

function matchSourceByMarker(link: ThemeLink): LegacyThemeSource | undefined {
  return KNOWN_LEGACY_SOURCES.find((s) => {
    const v = link.attributes[s.markerName];
    return v !== undefined && s.markerValues.includes(v);
  });
}

function matchSourceByEntry(link: ThemeLink): LegacyThemeSource | undefined {
  return KNOWN_LEGACY_SOURCES.find((s) => s.entries.includes(link.entry));
}

function detectVariant(source: LegacyThemeSource, content: string): LegacyThemeVariant | null {
  return source.variants.find((v) => v.tokens.every((t) => content.includes(t))) ?? null;
}

/**
 * 判定 HTML 里活跃着几层主题。
 *
 * - 带本工具前辈标记的链接 → 来源已确认，可以撤（内容指纹只用于说明是哪一套）；
 * - 没有标记但文件名属于已知旧主题、且内容特征也对得上 → 同样可撤；
 * - 文件名像旧主题但内容认不出来，或其他完全未知的样式表 → unknown，拒绝处理。
 */
export async function analyzeThemeLayers(input: AnalyzeThemeLayersInput): Promise<ThemeLayerAnalysis> {
  const { html, adapter } = input;
  const links = parseThemeLinks(html, adapter.injection.htmlEntry);
  const classified: ClassifiedThemeLink[] = [];
  const notes: string[] = [];

  for (const link of links) {
    if (isSelfLink(link, adapter)) {
      classified.push({ ...link, kind: 'self', fingerprint: 'matched' });
      continue;
    }

    const byMarker = matchSourceByMarker(link);
    const byEntry = matchSourceByEntry(link);
    const source = byMarker ?? byEntry;

    if (!source) {
      if (OFFICIAL_HREF_RE.test(link.href)) {
        classified.push({ ...link, kind: 'official', fingerprint: 'matched' });
      } else {
        classified.push({
          ...link,
          kind: 'unknown',
          fingerprint: 'unreadable',
          reason: '该样式表不属于官方资源，也不是本工具或已确认的旧主题，来源不明。',
        });
      }
      continue;
    }

    const content = await input.readEntry(link.entry);
    if (content === null) {
      classified.push({
        ...link,
        kind: 'unknown',
        source,
        fingerprint: 'unreadable',
        reason: `归档内读不到 ${link.entry}，无法确认它到底是什么，因此不做处理。`,
      });
      continue;
    }

    const observed = detectVariant(source, content);

    if (!byMarker) {
      // 没有自家标记：必须文件名与内容特征同时对得上才敢撤
      if (!observed) {
        classified.push({
          ...link,
          kind: 'unknown',
          source,
          observedVariant: null,
          fingerprint: 'drifted',
          reason: `${link.entry} 的文件名像旧主题，但内容特征不属于任何已知变体，来源不明。`,
        });
        continue;
      }
    }

    const markerValue = link.attributes[source.markerName];
    const fingerprint: FingerprintState =
      observed === null ? 'drifted' : markerValue !== undefined && observed.id !== markerValue ? 'drifted' : 'matched';

    const noteParts = [`撤下「${source.label}」的一层：${link.entry}`];
    if (markerValue !== undefined) noteParts.push(`链接标记 ${source.markerName}="${markerValue}"`);
    noteParts.push(
      observed
        ? fingerprint === 'drifted'
          ? `文件内容实际为「${observed.label}」（说明该文件被后续主题覆盖过）`
          : `内容确认：${observed.label}`
        : '文件内容不属于任何已知变体，按「标记已确认来源」处理，文件本体保留',
    );
    notes.push(noteParts.join('；'));

    classified.push({
      ...link,
      kind: 'known-legacy',
      source,
      observedVariant: observed,
      fingerprint,
    });
  }

  const pick = (k: ThemeLinkKind) => classified.filter((l) => l.kind === k);
  const knownLegacy = pick('known-legacy');
  return {
    links: classified,
    self: pick('self'),
    knownLegacy,
    unknown: pick('unknown'),
    removable: knownLegacy.map((l) => l.raw),
    notes,
  };
}

/** 从 HTML 里精确移除若干 link 标签，并在该标签独占一行时连行一起删 */
export function stripLinks(html: string, raws: string[]): string {
  let out = html;
  for (const raw of raws) {
    const idx = out.indexOf(raw);
    if (idx < 0) continue;
    const lineStart = out.lastIndexOf('\n', idx) + 1;
    const lineEnd = out.indexOf('\n', idx);
    const end = lineEnd === -1 ? out.length : lineEnd + 1;
    const beforeOnLine = out.slice(lineStart, idx).trim();
    const afterOnLine = lineEnd === -1 ? '' : out.slice(idx + raw.length, lineEnd).trim();
    out =
      beforeOnLine === '' && afterOnLine === ''
        ? `${out.slice(0, lineStart)}${out.slice(end)}`
        : `${out.slice(0, idx)}${out.slice(idx + raw.length)}`;
  }
  return out;
}

/**
 * 「原版证据」用的改造标记汇总：归档 HTML 里出现的任何本地主题层。
 * 有标记 ≠ 一定不是原版，但**没有任何标记也不能证明是原版**——所以这里只用来
 * 生成可读说明，最终判定见 original-evidence.ts。
 */
export interface InjectionMarkers {
  selfInjected: boolean;
  legacyIds: string[];
  legacyEntries: string[];
  unknownCount: number;
  entries: string[];
}

export async function detectInjectionMarkers(input: AnalyzeThemeLayersInput): Promise<InjectionMarkers> {
  const analysis = await analyzeThemeLayers(input);
  return {
    selfInjected: analysis.self.length > 0,
    legacyIds: analysis.knownLegacy.map((l) => l.source?.id ?? 'unknown'),
    legacyEntries: analysis.knownLegacy.map((l) => l.entry),
    unknownCount: analysis.unknown.length,
    entries: analysis.links.filter((l) => l.kind !== 'official').map((l) => l.entry),
  };
}
