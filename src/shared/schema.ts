/**
 * 公共数据契约：TypeScript 类型 + 运行时 zod 校验（T12）。
 * 类型仅用于编译期；跨 IPC 边界与主进程复验一律走这里的 schema。
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

/** #rrggbb 或 #rrggbbaa */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, '必须是 #rrggbb 或 #rrggbbaa 形式的颜色');

export const ColorSchema = hexColor;

/** 语义状态色与主色分开存放，避免互相覆盖（T12） */
export const StatusColorsSchema = z.object({
  error: hexColor,
  warning: hexColor,
  success: hexColor,
  info: hexColor,
});

export const DiffColorsSchema = z.object({
  added: hexColor,
  removed: hexColor,
  context: hexColor,
});

export const ThemeTokensSchema = z.object({
  background: hexColor,
  panel: hexColor,
  text: hexColor,
  muted: hexColor,
  primary: hexColor,
  onPrimary: hexColor,
  hover: hexColor,
  pressed: hexColor,
  border: hexColor,
  focus: hexColor,
  selection: hexColor,
  /**
   * 用作正文尺寸的强调色（链接、强调文字）。
   * 主色本身只需在控件层面达到 3:1，当正文链接用就必须到 4.5，
   * 因此单列一个 token，避免「链接读不清但报告说通过」（R4）。
   */
  accentText: hexColor,
  status: StatusColorsSchema,
  diff: DiffColorsSchema,
});

export const ThemeModeSchema = z.enum(['light', 'dark', 'auto']);

/** T24 参数范围 */
export const PARAM_RANGES = {
  overlayOpacity: { min: 0, max: 1 },
  panelOpacity: { min: 0, max: 1 },
  blurPx: { min: 0, max: 20 },
} as const;

export const ThemeSpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** 主进程登记的图片 ID，不是路径 */
  imageId: z.string().min(1),
  mode: ThemeModeSchema,
  /** 从图片提取的代表色，作为生成与回显依据 */
  palette: z.array(hexColor).min(1).max(16),
  /** 用户指定的主色；留空则按图片代表色自动推导并校正可读性 */
  primary: hexColor.optional(),
  overlayOpacity: z.number().min(PARAM_RANGES.overlayOpacity.min).max(PARAM_RANGES.overlayOpacity.max),
  panelOpacity: z.number().min(PARAM_RANGES.panelOpacity.min).max(PARAM_RANGES.panelOpacity.max),
  blurPx: z.number().min(PARAM_RANGES.blurPx.min).max(PARAM_RANGES.blurPx.max),
  /**
   * 减少透明度：开启后面板退化为纯色。
   * 这是**真实主题参数**——预览、对比度报告与实际写入归档的 CSS 用的是同一个值；
   * 早先只存在 React 预览状态里，用户勾了却不会生效。
   */
  reducedTransparency: z.boolean().default(false),
});

export const TargetSupportSchema = z.enum(['supported', 'unsupported', 'unknown']);

/** supported 的两条来源通道（structural-compat 计划）：名单命中或结构验证通过 */
export const TargetVerifiedBySchema = z.enum(['whitelist', 'structural']);

/** 结构验证逐项结论（供 UI 确认框列证据；判据来自 core/patch/compat-check） */
export const TargetCompatCheckSchema = z.object({
  key: z.enum(['anchor', 'changeSet', 'unpacked']),
  name: z.string().min(1),
  status: z.enum(['PASS', 'WARN', 'FAIL']),
  detail: z.string(),
});

export const TargetInfoSchema = z.object({
  targetId: z.string().min(1),
  /** canonicalize 后的真实绝对路径，仅在主进程持有与展示 */
  installPath: z.string().min(1),
  channel: z.string().min(1),
  version: z.string().min(1),
  adapterId: z.string().min(1),
  /** 归档或关键资源指纹，用于变更前后的比对 */
  fingerprint: z.string().min(1),
  support: TargetSupportSchema,
  /** support 不为 supported 时的原因，UI 必须展示 */
  rejectReason: z.string().optional(),
  /** support 为 supported 时的放行通道；structural 表示非名单版本经代码结构验证 */
  verifiedBy: TargetVerifiedBySchema.optional(),
  /** structural 通道的逐项结构检查结论（S3 确认框展示用） */
  compatChecks: z.array(TargetCompatCheckSchema).optional(),
  /** 目标进程状态：由主进程服务用 precheck 同口径探针补充（launch 按钮文案），非 core 判据 */
  processState: z.enum(['idle', 'running', 'unknown']).optional(),
});

export const ContrastTargetSchema = z.enum(['text', 'largeText', 'ui', 'disabled']);

export const ContrastEntrySchema = z.object({
  element: z.string().min(1),
  state: z.string().min(1),
  foreground: hexColor,
  background: hexColor,
  ratio: z.number().min(0),
  /** 该元素所要求的对比度目标值 */
  required: z.number().min(0),
  target: ContrastTargetSchema,
  pass: z.boolean(),
  /** 底色是否由代表色估算而来；true 表示不是真实界面像素采样（R4） */
  estimated: z.boolean(),
  /** 参与取最差的图片采样点数 */
  samples: z.number().int().min(0),
});

export const ContrastReportSchema = z.object({
  entries: z.array(ContrastEntrySchema),
  passed: z.boolean(),
  /** 采样方法与验证范围，避免把局部测量宣称为完整无障碍合规（T25） */
  scope: z.string().min(1),
  sampling: z.string().min(1),
  /** 合成后是否经过实底保护层，未充分验证时不得宣称「安全通过」（T26） */
  verified: z.boolean(),
});

export const OperationStatusSchema = z.enum([
  'inspected',
  'staged',
  'backed_up',
  'committing',
  'applied',
  'failed',
  'rolled_back',
  'needs_recovery',
]);

export const OperationKindSchema = z.enum(['apply', 'restore-previous', 'restore-original']);

export const OperationManifestSchema = z.object({
  schema: z.literal(SCHEMA_VERSION),
  operationId: z.string().min(1),
  targetId: z.string().min(1),
  version: z.string().min(1),
  adapterId: z.string().min(1),
  beforeHash: z.string().min(1),
  afterHash: z.string().min(1),
  backupHash: z.string().min(1),
  backupPath: z.string().min(1),
  themeSummary: z.string(),
  status: OperationStatusSchema,
  createdAt: z.string().min(1),
  /** 前序操作，恢复是新的前向操作，不改写历史（7.2） */
  previousOperationId: z.string().optional(),
  /** 操作类型；恢复是新操作而不是撤销历史（T41） */
  kind: OperationKindSchema.optional(),
  /** 主题内容指纹，用于重复应用的 no-op 判定（T42） */
  themeHash: z.string().optional(),
  /** 本次使用的备份来源，恢复时用于校验 */
  backupKind: z.enum(['original', 'previous', 'pre-restore']).optional(),
  /** 本次应用前发生了自动放行式重新接管（基线已按官方更新迁移） */
  rebaselined: z.boolean().optional(),
  /** 重新接管前基线对应的版本号（旧基线文件已按序号归档留存） */
  baselineFromVersion: z.string().optional(),
});

/** IPC 事件：带 operationId、phase、message；只在可计量时给百分比（T15） */
export const OperationEventSchema = z.object({
  operationId: z.string().min(1),
  phase: z.string().min(1),
  message: z.string(),
  percent: z.number().min(0).max(100).optional(),
});

export type Color = z.infer<typeof ColorSchema>;
export type StatusColors = z.infer<typeof StatusColorsSchema>;
export type DiffColors = z.infer<typeof DiffColorsSchema>;
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
export type ThemeMode = z.infer<typeof ThemeModeSchema>;
export type ThemeSpec = z.infer<typeof ThemeSpecSchema>;
export type TargetSupport = z.infer<typeof TargetSupportSchema>;
export type TargetVerifiedBy = z.infer<typeof TargetVerifiedBySchema>;
export type TargetCompatCheck = z.infer<typeof TargetCompatCheckSchema>;
export type TargetInfo = z.infer<typeof TargetInfoSchema>;
export type ContrastTarget = z.infer<typeof ContrastTargetSchema>;
export type ContrastEntry = z.infer<typeof ContrastEntrySchema>;
export type ContrastReport = z.infer<typeof ContrastReportSchema>;
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
export type OperationKind = z.infer<typeof OperationKindSchema>;
export type OperationManifest = z.infer<typeof OperationManifestSchema>;
export type OperationEvent = z.infer<typeof OperationEventSchema>;
