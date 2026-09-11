/**
 * 主进程 ↔ renderer 的受限桥接契约（T13、T14）。
 *
 * 约束：
 * - renderer 只能拿到主进程登记的 ID（imageId / targetId / operationId），
 *   任何时候都不得传入任意文件路径要求写文件。
 * - 所有 token、枚举、数值范围在主进程用 schema.ts 复验。
 * - 本文件只声明形状，不含实现。
 */
import type { ErrorCode, Result } from './errors';
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
  'importImageData',
  'getImagePreview',
  'generateTheme',
  'analyzeContrast',
  'discoverTargets',
  'chooseTargetDirectory',
  'inspectTarget',
  'stageTheme',
  'applyTheme',
  'listBackups',
  'restoreTheme',
  'getOperation',
  'getRecoveryStatus',
  'resolveRecovery',
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

/** 未通过识别的候选目录；界面要显示原因，不能默默吞掉（T51、R6） */
export interface RejectedTargetInfo {
  path: string;
  support: 'unsupported' | 'unknown';
  /** 具体原因码，界面据此分类展示「未发现 / 读取失败 / 版本未验证 / 主题冲突」 */
  code: ErrorCode;
  message: string;
  recoveryHint: string;
}

export interface DiscoveredTargets {
  targets: TargetInfo[];
  rejected: RejectedTargetInfo[];
  /** 实际扫描过的候选位置，便于用户核对「没扫到」而不是工具瞎猜 */
  scanned: string[];
}

/** 用户手动选择安装目录的结果（R6）：要么登记成功，要么带着具体原因返回 */
export interface RegisterDirectoryResult {
  target?: TargetInfo;
  rejected?: RejectedTargetInfo;
}

/** 未完成事务在磁盘上的判定结果（R7） */
export type RecoveryState = 'applied' | 'unchanged' | 'needs_recovery';

export type RecoveryAction = 'mark-applied' | 'mark-failed' | 'acknowledge';

export interface PendingRecoveryItem {
  operationId: string;
  instanceId: string;
  state: RecoveryState;
  advice: string;
  themeSummary: string;
  status: string;
  createdAt: string;
  /** 目标归档路径（本机信息，仅用于让用户知道去哪看） */
  targetPath: string;
  /** true 表示在人工处理前不允许继续 apply */
  blocking: boolean;
  /** 该状态下允许的落账动作 */
  actions: RecoveryAction[];
}

export interface RecoveryStatus {
  items: PendingRecoveryItem[];
  /** 需要人工处理的数量；> 0 时 apply 被阻断 */
  blockingCount: number;
  /** 启动时清理掉的残留准备区数量 */
  stagesCleaned: number;
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
  /**
   * 本次会撤下的、已确认来源与指纹的旧主题层（R3）。
   * 必须在确认对话框里如实列出——用户是在「撤下这些旧主题」的前提下授权的。
   */
  legacyThemes: { id: string; label: string; entry: string }[];
  /** 留在归档里没动过的旧主题配套资源（不删，只说明） */
  keptAssets: string[];
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
  /**
   * 三个语义不能合并（T41、R2）：
   * - original：已证明是出厂原版
   * - takeover：首次接管快照（无法证明是原版）
   * - previous：上一主题
   */
  kind: 'original' | 'previous' | 'takeover';
  themeSummary: string;
  applicableVersion: string;
  /** false 表示无法确认为出厂原版，界面必须禁用并说明原因 */
  pristine: boolean;
  /** 原版判定依据；kind 为 takeover 时说明为什么不能当原版 */
  evidenceNote?: string;
  sizeBytes: number;
}

export interface RestoreThemeInput {
  targetId: string;
  /** 三个入口语义不同，不能合并（T41、R2） */
  kind: 'original' | 'previous' | 'takeover';
}

/** 桥接方法签名：全部返回 Result，不允许抛异常给 renderer */
export interface ThemeSwitcherApi {
  pickImage(): Promise<Result<PickedImage>>;
  importImage(imageId: string): Promise<Result<ImportedImage>>;
  /**
   * 取回用于界面回显的缩小副本（data URL）。
   * 给的是工具自己生成的缩略图，不是原图路径——renderer 永远拿不到路径。
   */
  getImagePreview(imageId: string): Promise<Result<string>>;
  /** 拖拽导入：只接收文件内容与文件名，不接收路径 */
  importImageData(input: { fileName: string; data: Uint8Array }): Promise<Result<ImportedImage>>;
  generateTheme(input: GenerateThemeInput): Promise<Result<GenerateThemeOutput>>;
  analyzeContrast(input: AnalyzeContrastInput): Promise<Result<ContrastReport>>;
  discoverTargets(): Promise<Result<DiscoveredTargets>>;
  /**
   * 让用户手动指定安装目录（R6）。目录由主进程的系统对话框选出，
   * renderer 既拿不到也不传路径，只拿到登记结果。
   */
  chooseTargetDirectory(): Promise<Result<RegisterDirectoryResult>>;
  inspectTarget(targetId: string): Promise<Result<TargetInfo>>;
  /** 启动恢复状态：有待人工处理的未完成事务时，apply 会被后端阻断（R7） */
  getRecoveryStatus(): Promise<Result<RecoveryStatus>>;
  /** 对未完成事务落账；方向由磁盘事实决定，不允许把 needs_recovery 写成 applied */
  resolveRecovery(input: { operationId: string; action: RecoveryAction }): Promise<Result<RecoveryStatus>>;
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
