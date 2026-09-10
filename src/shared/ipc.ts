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
}

export interface GenerateThemeInput {
  imageId: string;
  spec: ThemeSpec;
}

export interface GenerateThemeOutput {
  tokens: ThemeTokens;
  /** 与预览共用同一份数据（T53） */
  css: string;
}

export interface AnalyzeContrastInput {
  imageId: string;
  spec: ThemeSpec;
  tokens: ThemeTokens;
}

export interface StageThemeInput {
  targetId: string;
  imageId: string;
  spec: ThemeSpec;
}

export interface StagedTheme {
  operationId: string;
  manifest: OperationManifest;
}

export interface ApplyThemeInput {
  operationId: string;
}

export interface BackupInfo {
  operationId: string;
  createdAt: string;
  /** 「原版」或「上一主题」，UI 必须区分（T41） */
  kind: 'original' | 'previous';
  themeSummary: string;
  applicableVersion: string;
}

export interface RestoreThemeInput {
  targetId: string;
  /** 省略 operationId 表示恢复原版；原版未知时必须返回失败 */
  operationId?: string;
}

/** 桥接方法签名：全部返回 Result，不允许抛异常给 renderer */
export interface ThemeSwitcherApi {
  pickImage(): Promise<Result<PickedImage>>;
  importImage(imageId: string): Promise<Result<ImportedImage>>;
  generateTheme(input: GenerateThemeInput): Promise<Result<GenerateThemeOutput>>;
  analyzeContrast(input: AnalyzeContrastInput): Promise<Result<ContrastReport>>;
  discoverTargets(): Promise<Result<TargetInfo[]>>;
  inspectTarget(targetId: string): Promise<Result<TargetInfo>>;
  stageTheme(input: StageThemeInput): Promise<Result<StagedTheme>>;
  applyTheme(input: ApplyThemeInput): Promise<Result<OperationManifest>>;
  listBackups(targetId: string): Promise<Result<BackupInfo[]>>;
  restoreTheme(input: RestoreThemeInput): Promise<Result<OperationManifest>>;
  getOperation(operationId: string): Promise<Result<OperationManifest>>;
  /** 订阅操作进度事件（T15） */
  onOperationEvent(listener: (event: {
    operationId: string;
    phase: string;
    message: string;
    percent?: number;
  }) => void): () => void;
}
