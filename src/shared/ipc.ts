/**
 * 主进程 ↔ renderer 的受限桥接契约（T13、T14）。
 *
 * 约束：
 * - renderer 只能拿到主进程登记的 ID（imageId / targetId / operationId），
 *   任何时候都不得传入任意文件路径要求写文件。
 * - 所有 token、枚举、数值范围在主进程用 schema.ts 复验。
 * - 本文件只声明形状，不含实现。
 */
import type { Result } from './errors';
import type {
  ContrastReport,
  OperationManifest,
  TargetInfo,
  ThemeSpec,
  ThemeTokens,
} from './schema';

export const IPC_CHANNELS = [
  'pickImage',
  'importImage',
  'generateTheme',
  'analyzeContrast',
  'discoverTargets',
  'inspectTarget',
  'stageTheme',
  'applyTheme',
  'listBackups',
  'restoreTheme',
  'getOperation',
  'openExternal',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export interface PickedImage {
  imageId: string;
  fileName: string;
  byteSize: number;
}

export interface ImportedImage {
  imageId: string;
  /** 原图内容 SHA256，原图只读、不被修改（T21） */
  hash: string;
  width: number;
  height: number;
  /** 工具自己的分析用缩小副本，位于用户数据目录 */
  thumbnailId: string;
  /** 提取到的代表色，直接回显到界面（T52） */
  palette: string[];
}

export interface GenerateThemeInput {
  imageId: string;
  spec: ThemeSpec;
}

export interface GenerateThemeOutput {
  tokens: ThemeTokens;
  /** 与预览共用同一份数据（T53） */
  css: string;
  /** 图片 → 遮罩 → 面板合成后的实际底色 */
  effectiveBackground: string;
  report: ContrastReport;
  /** auto 解析后的实际基调，界面回显用 */
  mode: 'light' | 'dark';
  palette: string[];
}

export interface AnalyzeContrastInput {
  imageId: string;
  spec: ThemeSpec;
  tokens: ThemeTokens;
}

/** 未通过识别的候选目录；界面要显示原因，不能默默吞掉（T51） */
export interface RejectedTargetInfo {
  path: string;
  support: 'unsupported' | 'unknown';
  message: string;
  recoveryHint: string;
}

export interface DiscoveredTargets {
  targets: TargetInfo[];
  rejected: RejectedTargetInfo[];
  /** 实际扫描过的候选位置，便于用户核对「没扫到」而不是工具瞎猜 */
  scanned: string[];
}

export interface StageThemeInput {
  targetId: string;
  imageId: string;
  spec: ThemeSpec;
}

/**
 * 准备完成后的摘要，供确认对话框展示（T54）。
 * 这里刻意不返回完整的 OperationManifest：afterHash / backupHash 在真正提交前还不存在，
 * 拿占位值冒充等于给界面喂假数据。
 */
export interface StageSummary {
  operationId: string;
  targetId: string;
  installPath: string;
  version: string;
  adapterId: string;
  /** 将会被新增/修改的归档内条目 */
  changedFiles: string[];
  backupDir: string;
  requiredBytes: number;
  freeBytes: number;
  processState: 'idle' | 'running' | 'unknown';
  /** 目标归档当前指纹，提交前会再核一次 */
  beforeHash: string;
  themeSummary: string;
  createdAt: string;
}

export interface StagedTheme {
  operationId: string;
  summary: StageSummary;
}

export interface ApplyThemeInput {
  operationId: string;
}

export interface BackupInfo {
  /** 备份记录标识，用于选择恢复到哪一个上一主题 */
  backupId: string;
  createdAt: string;
  /** 「原版」或「上一主题」，UI 必须区分（T41） */
  kind: 'original' | 'previous';
  themeSummary: string;
  applicableVersion: string;
  /** false 表示无法确认为出厂原版，界面必须禁用并说明原因 */
  pristine: boolean;
  sizeBytes: number;
}

export interface RestoreThemeInput {
  targetId: string;
  /** 恢复原版还是上一主题；两个入口语义不同，不能合并（T41） */
  kind: 'original' | 'previous';
}

/** 桥接方法签名：全部返回 Result，不允许抛异常给 renderer */
export interface ThemeSwitcherApi {
  pickImage(): Promise<Result<PickedImage>>;
  importImage(imageId: string): Promise<Result<ImportedImage>>;
  generateTheme(input: GenerateThemeInput): Promise<Result<GenerateThemeOutput>>;
  analyzeContrast(input: AnalyzeContrastInput): Promise<Result<ContrastReport>>;
  discoverTargets(): Promise<Result<DiscoveredTargets>>;
  inspectTarget(targetId: string): Promise<Result<TargetInfo>>;
  stageTheme(input: StageThemeInput): Promise<Result<StagedTheme>>;
  applyTheme(input: ApplyThemeInput): Promise<Result<OperationManifest>>;
  listBackups(targetId: string): Promise<Result<BackupInfo[]>>;
  restoreTheme(input: RestoreThemeInput): Promise<Result<OperationManifest>>;
  getOperation(operationId: string): Promise<Result<OperationManifest>>;
  /** 只放行 https 外链，由主进程经受控方式打开（T56） */
  openExternal(url: string): Promise<Result<boolean>>;
  /** 订阅操作进度事件（T15） */
  onOperationEvent(listener: (event: {
    operationId: string;
    phase: string;
    message: string;
    percent?: number;
  }) => void): () => void;
}
