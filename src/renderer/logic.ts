/**
 * 界面纯逻辑（不碰 DOM，便于单测）。
 * 放在这里是为了让「状态判定」这类容易写错的规则可以被测试覆盖，
 * 而不是埋在组件里靠肉眼看。
 */
import type { ErrorCode } from '../shared/errors';
import type { ContrastReport, ThemeSpec } from '../shared/schema';

export const DEFAULT_SPEC: Omit<ThemeSpec, 'imageId'> = {
  schemaVersion: 1,
  mode: 'auto',
  palette: ['#404558', '#787e9f', '#a0a7c9'],
  overlayOpacity: 0.35,
  panelOpacity: 0.86,
  blurPx: 0,
  reducedTransparency: false,
};

export function makeSpec(imageId = ''): ThemeSpec {
  return { ...DEFAULT_SPEC, imageId };
}

/** 重置参数但保留当前图片 */
export function resetSpec(spec: ThemeSpec): ThemeSpec {
  return { ...DEFAULT_SPEC, imageId: spec.imageId };
}

/** 界面滑杆可能给出越界值，回写前统一夹紧到 schema 允许的范围 */
export function clampSpec(spec: ThemeSpec): ThemeSpec {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  return {
    ...spec,
    overlayOpacity: clamp(spec.overlayOpacity, 0, 1),
    panelOpacity: clamp(spec.panelOpacity, 0, 1),
    blurPx: clamp(Math.round(spec.blurPx), 0, 20),
    // 老版本存在 localStorage 里的参数没有这个字段，缺省按「不减少透明度」处理
    reducedTransparency: spec.reducedTransparency === true,
  };
}

/**
 * 失败时安装处于什么状态。这句话必须由工具说清楚，
 * 不能只丢一个堆栈给用户（T55）。
 */
export type ErrorScope = 'unmodified' | 'maybe-modified' | 'unknown';

const UNMODIFIED: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'IMAGE_NOT_FOUND',
  'IMAGE_INVALID_FORMAT',
  'IMAGE_DECODE_FAILED',
  'IMAGE_TOO_LARGE',
  'IMAGE_UNCHANGED',
  'IMAGE_CONTENT_MISMATCH',
  'IMAGE_ANIMATED',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'TARGET_UNSUPPORTED',
  'TARGET_RUNNING',
  'TARGET_VERSION_MISMATCH',
  'TARGET_SIGNATURE_PROTECTED',
  'STRUCTURAL_CONFIRM_REQUIRED',
  'RUNTIME_IO_UNAVAILABLE',
  'ARCHIVE_CORRUPT',
  'ARCHIVE_VERIFY_FAILED',
  'THEME_CONFLICT',
  'PERMISSION_DENIED',
  'DISK_FULL',
  'FILE_LOCKED',
  'TRANSACTION_IN_PROGRESS',
  'STAGE_FAILED',
  'BACKUP_FAILED',
  'BACKUP_HASH_MISMATCH',
  'BACKUP_MISSING',
  'CONTRAST_BELOW_TARGET',
  'THEME_GENERATION_FAILED',
  'INVALID_PARAMS',
]);

const MODIFIED: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NEEDS_RECOVERY',
  'ROLLBACK_FAILED',
  'TARGET_HASH_MISMATCH',
]);

export function errorScope(code: ErrorCode): ErrorScope {
  if (UNMODIFIED.has(code)) return 'unmodified';
  if (MODIFIED.has(code)) return 'maybe-modified';
  return 'unknown';
}

export function scopeText(scope: ErrorScope): string {
  if (scope === 'unmodified') return '安装未被修改，可以放心重试。';
  if (scope === 'maybe-modified') return '安装可能已被修改，请不要手动替换文件。';
  return '安装状态无法自动判定，请先不要对该安装做任何改动。';
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const mb = n / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 九类界面状态（T51） */
export type UiState =
  | { kind: 'empty' }
  | { kind: 'analyzing' }
  | { kind: 'ready' }
  | { kind: 'staging' }
  | { kind: 'confirming' }
  | { kind: 'applying'; phase: string; percent?: number }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string; hint: string; scope: ErrorScope }
  | { kind: 'needsRecovery'; message: string; hint: string };

export function isBusy(state: UiState): boolean {
  return state.kind === 'analyzing' || state.kind === 'staging' || state.kind === 'applying';
}

/**
 * 应用按钮的可用条件（T54、R6）。
 * 目标与完成度共同决定：没有已验证目标、或有待人工处理的未完成事务时都不放行。
 * W3 起对比度不再是按钮级硬闸：未达标仍可点「应用」，由服务端拦下并弹出显式确认区。
 * 按钮禁用只是辅助，后端 precheck 同样会拦。
 */
export interface GateInput {
  hasImage: boolean;
  hasPreview: boolean;
  /** 已识别到的目标数量 */
  targetCount: number;
  targetSupported: boolean;
  /** 目标存在但未验证时的原因 */
  targetRejectReason?: string;
  reportPassed: boolean;
  /** 存在待人工处理的未完成事务（R7），此时后端也会拒绝写入 */
  recoveryBlocking: boolean;
}

export function canStage(args: GateInput & { busy: boolean }): boolean {
  return (
    args.hasImage &&
    args.hasPreview &&
    args.targetSupported &&
    !args.recoveryBlocking &&
    !args.busy
  );
}

/** 禁用原因必须具体，不能说「没有已验证目标」就完事（R6） */
export function blockedReason(args: GateInput): string | null {
  if (args.recoveryBlocking) {
    return '存在待处理的未完成事务，请先在「待恢复」面板中处理后再应用。';
  }
  if (!args.hasImage || !args.hasPreview) return '请先选择图片并等待配色生成完成。';
  if (args.targetCount === 0) {
    return '没有发现 OpenCode 安装：请点「重新检测」，或用「选择安装目录」手动指定（目录里应有 resources 文件夹）。';
  }
  if (!args.targetSupported) {
    return args.targetRejectReason
      ? `当前目标未经验证，只能预览不能应用：${args.targetRejectReason}`
      : '当前目标未经验证，只能预览不能应用；请重新检测目标。';
  }
  // W3：对比度不再是按钮禁用理由——点击后由服务端拦下并弹出显式确认区（默认仍不放行）
  return null;
}

/** 底部就绪文案：由目标与对比度共同决定，不能与禁用原因互相矛盾 */
export function readyText(args: GateInput): string {
  if (args.recoveryBlocking) return '待处理事务未清空，已暂停写入。';
  if (!args.hasImage) return '请选择一张本地图片开始。';
  if (!args.hasPreview) return '正在提取配色…';
  const blocked = blockedReason(args);
  if (blocked) return blocked;
  if (!args.reportPassed) return '存在未达标的可读性项：仍可点「应用」，但需要你在确认区显式接受后果。';
  return '配色与可读性均已通过，可以应用；应用前请先退出 OpenCode。';
}

/* ---------- F3「自动调整」：确定性推导，纯函数便于单测 ---------- */

export const AUTO_TUNE = {
  overlayMin: 0.55,
  overlayMax: 0.85,
  panelOpacity: 0.85,
  blurLow: 4,
  blurHigh: 8,
  /** 有边缘感的像素占比低于此值视为平坦图，不给模糊 */
  edgeFracLow: 0.15,
  /** 占比达到此值即给满 blurHigh */
  edgeFracHigh: 0.4,
  /** 对比度不达标时遮罩的步进与上限（宁停上限不越界） */
  stepUp: 0.05,
  stepUpCap: 0.95,
  maxAttempts: 8,
} as const;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** BT.601 相对亮度（与 core 的图片亮度口径一致），无法解析时按中灰 0.5 */
export function hexLuminance(hex: string): number {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Sobel 梯度可感（幅值 >0.5，纯黑白边约 4.9）的边缘像素占比，0..1 */
export function edgeFractionFromRgba(data: Uint8ClampedArray, width: number, height: number): number {
  if (width < 3 || height < 3 || data.length < width * height * 4) return 0;
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  }
  let edgePixels = 0;
  let total = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1] +
        gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      total++;
      if (Math.hypot(gx, gy) > 0.5) edgePixels++;
    }
  }
  return total > 0 ? edgePixels / total : 0;
}

/**
 * 按图片代表色与边缘占比推导三个滑杆值（不随机、不读网络）：
 * 浅图高遮罩、深图低遮罩（0.55–0.85 线性）；面板固定 0.85 减少自由度；
 * 边缘占比达门槛才给 4–8px 模糊，平坦图 0。
 */
export function autoTuneParams(
  palette: string[],
  edgeFrac: number,
): { overlayOpacity: number; panelOpacity: number; blurPx: number } {
  const lums = palette.map(hexLuminance);
  const brightness = lums.length > 0 ? lums.reduce((a, b) => a + b, 0) / lums.length : 0.5;
  const overlayOpacity = round2(
    AUTO_TUNE.overlayMin + Math.min(1, Math.max(0, brightness)) * (AUTO_TUNE.overlayMax - AUTO_TUNE.overlayMin),
  );
  let blurPx = 0;
  if (edgeFrac >= AUTO_TUNE.edgeFracLow) {
    const t = Math.min(1, (edgeFrac - AUTO_TUNE.edgeFracLow) / (AUTO_TUNE.edgeFracHigh - AUTO_TUNE.edgeFracLow));
    blurPx = Math.round(AUTO_TUNE.blurLow + t * (AUTO_TUNE.blurHigh - AUTO_TUNE.blurLow));
  }
  return { overlayOpacity, panelOpacity: AUTO_TUNE.panelOpacity, blurPx };
}

/** 推导值未达标时的遮罩步进：每次 +0.05，封顶 stepUpCap 后原地不动 */
export function overlayStepUp(v: number): number {
  return Math.min(AUTO_TUNE.stepUpCap, round2(v + AUTO_TUNE.stepUp));
}

/** 报告里余量最差的一项（ratio/required 最小值）；空报告按 Infinity */
export function worstMargin(report: ContrastReport): number {
  return report.entries.reduce((a, e) => Math.min(a, e.ratio / e.required), Infinity);
}
