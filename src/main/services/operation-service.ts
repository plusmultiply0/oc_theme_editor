/**
 * 准备、应用与恢复的服务层（T34–T42、T54、T55）。
 *
 * 两段式提交：
 * - stageTheme 只做「准备」：生成产物、预检环境、落准备记录，返回一个 operationId。
 *   这时候目标安装一个字节都没动，也还没有 afterHash —— 所以刻意不返回完整 manifest。
 * - applyTheme(operationId) 才真正写入。renderer 只能传 operationId，
 *   既不能传路径，也不能自己拼文件名。
 *
 * 其他约束：
 * - 同一个 operationId 在处理中再次提交会被拒绝，避免双击开两个事务（T54）。
 * - 提交前复核归档指纹，准备之后目标被改动过就拒绝（T39）。
 * - 恢复区分「原版」与「上一主题」，且原版不可确认时直接拒绝（T41）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { errorResult, fail, ok, type Result } from '../../shared/errors';
import type {
  ApplyThemeInput,
  BackupInfo,
  RestoreThemeInput,
  StageSummary,
  StageThemeInput,
  StagedTheme,
} from '../../shared/ipc';
import { ThemeSpecSchema } from '../../shared/schema';
import type { OperationManifest, ThemeSpec } from '../../shared/schema';
import { adapterById } from '../../adapters/registry';
import { applyTheme as coreApply, computeThemeHash } from '../../core/patch/apply';
import { restoreTarget, newOpId } from '../../core/patch/restore';
import { runtimeDirs, ensureDirs, originalDir, previousDir } from '../../core/patch/layout';
import { listBackupRecords } from '../../core/patch/backup';
import { precheckTarget, type ProcessProbe } from '../../core/patch/precheck';
import { readAsar, readAsarText } from '../../core/patch/asar';
import { analyzeThemeLayers } from '../../core/patch/legacy-theme';
import { instanceIdFromPath } from '../../core/patch/paths';
import { readTx } from '../../core/patch/txlog';
import { generateTheme } from '../../core/theme/generate';
import { defaultImageRef } from './theme-service';
import type { ImageStore } from './image-store';
import type { OperationEventBus } from './events';
import type { TargetService } from './target-service';

interface StagedRecord {
  operationId: string;
  targetId: string;
  imageId: string;
  spec: ThemeSpec;
  css: string;
  /**
   * 准备时那次确认内容的 SHA256（A2：内容固定）。
   * 应用前按它核对私有副本，不一致就拒绝 —— 不拿没预览过的图片写入安装。
   */
  contentHash?: string;
  themeSummary: string;
  createdAt: string;
  /** 准备时刻的归档指纹，提交前复核 */
  beforeHash: string;
  /** W3：经用户显式确认放行对比度门时，如实记录未达标项清单 */
  contrastOverride?: { failedItems: string[] };
}

export interface OperationServiceOptions {
  runtimeRoot: string;
  targets: TargetService;
  images: ImageStore;
  bus: OperationEventBus;
  /** 进程探针可注入，测试不需要真的启停应用 */
  probe?: ProcessProbe;
  /**
   * R7 闸门：进入 apply 之前检查是否存在待人工处理的未完成事务。
   * 由主进程注入 RecoveryService.assertClear；测试可省略。
   */
  recoveryGuard?: () => Promise<Result<void>>;
  now?: () => string;
}

function summaryOf(spec: ThemeSpec, mode: 'light' | 'dark', fileName: string): string {
  const parts = [
    fileName || '自定义图片',
    mode === 'dark' ? '深色' : '浅色',
    `遮罩 ${spec.overlayOpacity.toFixed(2)}`,
    `面板 ${spec.panelOpacity.toFixed(2)}`,
  ];
  if (spec.blurPx > 0) parts.push(`模糊 ${spec.blurPx}px`);
  return parts.join(' · ');
}

export class OperationService {
  private readonly inFlight = new Set<string>();

  constructor(private readonly opts: OperationServiceOptions) {}

  private layoutFor(installPath: string) {
    return runtimeDirs(this.opts.runtimeRoot, instanceIdFromPath(installPath));
  }

  private stagedDir(installPath: string): string {
    return path.join(this.layoutFor(installPath).instance, 'staged');
  }

  private stagedFile(installPath: string, operationId: string): string {
    return path.join(this.stagedDir(installPath), `${operationId}.json`);
  }

  async stage(input: StageThemeInput): Promise<Result<StagedTheme>> {
    const parsed = ThemeSpecSchema.safeParse(input?.spec);
    if (!parsed.success) {
      return fail('INVALID_PARAMS', '主题参数不合法', '请重置为默认参数后重试。', parsed.error.message);
    }
    const spec = parsed.data;
    // W3：放行标志只接受布尔 true；任何其他值（包括字符串）按缺省 false 处理并在类型层拒绝
    if (input?.allowContrastOverride !== undefined && typeof input.allowContrastOverride !== 'boolean') {
      return fail('INVALID_PARAMS', '放行标志不合法', 'allowContrastOverride 必须是布尔值。');
    }
    const allowContrastOverride = input?.allowContrastOverride === true;

    const target = await this.opts.targets.refresh(input.targetId);
    if (!target.success) return target;
    if (target.data.support !== 'supported') {
      return fail(
        'TARGET_UNSUPPORTED',
        target.data.rejectReason ?? '该目标未经验证',
        '未验证的目标只允许预览，不允许应用。',
      );
    }
    // structural 通道（非名单版本经结构验证放行）必须带显式确认标志，缺省拒绝（S2）
    if (target.data.verifiedBy === 'structural' && !input?.confirmStructural) {
      return this.structuralConfirmRequired();
    }

    const adapter = adapterById(target.data.adapterId);
    if (!adapter) {
      return fail('TARGET_UNSUPPORTED', '适配规则不存在', '请重新检测目标。');
    }

    const record0 = this.opts.images.peek(input.imageId);
    if (!record0) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }

    // 生成产物：这次调用同时决定预览与写入归档的内容（T53）
    const bytes = await this.opts.images.readBytes(input.imageId);
    if (!bytes.success) return bytes;

    const generated = await generateTheme({
      buffer: bytes.data,
      spec,
      imageRef: defaultImageRef(),
      ...(spec.primary ? { primaryOverride: spec.primary } : {}),
    });
    if (!generated.success) return generated;

    // 对比度不合格默认不进入应用流程（T25、T54）；仅当带显式放行标志才继续，并如实记录未达标项（W3）
    let contrastOverride: { failedItems: string[] } | undefined;
    if (!generated.data.report.passed) {
      const failedItems = generated.data.report.entries
        .filter((e) => !e.pass)
        .map((e) => `${e.element} ${e.ratio.toFixed(2)}（需 ${e.required}）`);
      if (!allowContrastOverride) {
        return fail(
          'CONTRAST_BELOW_TARGET',
          `以下元素未达到可读性目标：${failedItems.join('、')}`,
          '请调高背景遮罩或面板不透明度，或换一个明度差异更大的主色。',
          failedItems.join('；'),
        );
      }
      contrastOverride = { failedItems };
    }

    const archivePath = path.join(target.data.installPath, ...adapter.layout.archive.split('/'));
    const snapshot = await readAsar(archivePath);
    if (!snapshot.success) return snapshot;

    // R3：准备阶段就把旧主题冲突查清楚，别等到确认对话框之后才失败。
    const htmlText = await readAsarText(snapshot.data, adapter.injection.htmlEntry);
    if (!htmlText.success) return htmlText;
    const layers = await analyzeThemeLayers({
      html: htmlText.data,
      adapter,
      readEntry: async (entry) => {
        const r = await readAsarText(snapshot.data, entry);
        return r.success ? r.data : null;
      },
    });
    if (layers.unknown.length > 0) {
      return fail(
        'THEME_CONFLICT',
        `目标里已有来源不明的样式层：${layers.unknown.map((l) => l.entry).join('、')}`,
        '请先在原工具中移除该主题，或确认其来源后再重试；本工具不会覆盖未知样式。',
        layers.unknown.map((l) => `${l.entry}：${l.reason ?? '来源不明'}`).join('；'),
      );
    }
    const legacyThemes = layers.knownLegacy.map((l) => ({
      id: l.source?.id ?? 'unknown',
      label: l.observedVariant
        ? `${l.source?.label ?? '旧主题'}：${l.observedVariant.label}${l.fingerprint === 'drifted' ? '（链接标记与文件内容不一致，说明被后续主题覆盖过）' : ''}`
        : `${l.source?.label ?? '旧主题'}：内容特征未知，按标记确认的来源处理`,
      entry: l.entry,
    }));

    const pre = await precheckTarget(target.data, {
      ...(this.opts.probe ? { probe: this.opts.probe } : {}),
      archiveSize: snapshot.data.size,
    });
    if (!pre.success) return pre;

    const layout = this.layoutFor(target.data.installPath);
    await ensureDirs(layout);
    await fs.mkdir(this.stagedDir(target.data.installPath), { recursive: true });

    const operationId = newOpId(this.opts.now);
    const themeSummary = summaryOf(spec, generated.data.mode, record0.fileName);
    const staged: StagedRecord = {
      operationId,
      targetId: target.data.targetId,
      imageId: input.imageId,
      spec,
      css: generated.data.css,
      // 与 generateTheme 用的是同一份 bytes，因此这里记的就是「用户确认过的那份内容」
      contentHash: crypto.createHash('sha256').update(bytes.data).digest('hex'),
      themeSummary,
      createdAt: new Date().toISOString(),
      beforeHash: snapshot.data.sha256,
      ...(contrastOverride ? { contrastOverride } : {}),
    };
    try {
      await fs.writeFile(
        this.stagedFile(target.data.installPath, operationId),
        JSON.stringify(staged, null, 2),
        'utf8',
      );
    } catch (e) {
      return fail('STAGE_FAILED', '准备记录写入失败', '安装未被修改；请重试。', String(e));
    }

    const summary: StageSummary = {
      operationId,
      targetId: target.data.targetId,
      installPath: target.data.installPath,
      version: target.data.version,
      adapterId: adapter.id,
      changedFiles: [...adapter.allowedChanges],
      backupDir: layout.backupsDir,
      requiredBytes: pre.data.requiredBytes,
      freeBytes: pre.data.freeBytes,
      processState: pre.data.processState,
      beforeHash: snapshot.data.sha256,
      themeSummary,
      createdAt: staged.createdAt,
      legacyThemes,
      keptAssets: layers.knownLegacy.flatMap((l) => l.source?.assets ?? []),
    };
    return ok({ operationId, summary, ...(contrastOverride ? { contrastOverride } : {}) });
  }

  async apply(input: ApplyThemeInput): Promise<Result<OperationManifest>> {
    const operationId = input?.operationId;
    if (!operationId) {
      return fail('INVALID_PARAMS', '缺少操作标识', '请重新执行应用。');
    }
    if (this.inFlight.has(operationId)) {
      return fail('TRANSACTION_IN_PROGRESS', '该操作正在执行中', '请勿重复点击；执行完成后再试。');
    }
    // R7：待人工处理的未完成事务存在时，不允许继续写
    if (this.opts.recoveryGuard) {
      const clear = await this.opts.recoveryGuard();
      if (!clear.success) return clear;
    }

    // R7：待人工处理的未完成事务存在时，不允许继续写
    if (this.opts.recoveryGuard) {
      const clear = await this.opts.recoveryGuard();
      if (!clear.success) return clear;
    }

    // 同步占位：必须在任何 await 之前，否则两次点击会同时穿过检查（T54）
    this.inFlight.add(operationId);

    try {
      // R7：存在待人工处理的未完成事务时，不允许继续写
      if (this.opts.recoveryGuard) {
        const clear = await this.opts.recoveryGuard();
        if (!clear.success) return clear;
      }
      return await this.runApply(operationId, input.confirmStructural === true);
    } catch (e) {
      return errorResult(e, 'INTERNAL');
    } finally {
      this.inFlight.delete(operationId);
    }
  }

  private structuralConfirmRequired(): Result<never> {
    return fail(
      'STRUCTURAL_CONFIRM_REQUIRED',
      '该目标为非白名单版本经结构验证放行，应用前需要显式确认',
      '请在确认对话框中核对结构验证结论并确认后再应用；安装未被修改。',
    );
  }

  private async runApply(operationId: string, confirmStructural = false): Promise<Result<OperationManifest>> {
    // 准备记录按实例分散存放，这里逐个实例查找
    const found = await this.findStaged(operationId);
    if (!found) {
      return fail('MANIFEST_CORRUPT', '该操作已失效或已被执行', '请重新准备后再应用。');
    }
    const { record, file } = found;

    const target = await this.opts.targets.refresh(record.targetId);
    if (!target.success) return target;
    if (target.data.support !== 'supported') {
      return fail(
        'TARGET_UNSUPPORTED',
        target.data.rejectReason ?? '该目标未经验证',
        '未验证的目标只允许预览，不允许应用。',
      );
    }
    // 应用比准备更靠近写入：确认标志必须在 apply 入口重新给（S2，防 stage 后版本漂移）
    if (target.data.verifiedBy === 'structural' && !confirmStructural) {
      return this.structuralConfirmRequired();
    }

    const adapter = adapterById(target.data.adapterId);
    if (!adapter) {
      return fail('TARGET_UNSUPPORTED', '适配规则不存在', '请重新检测目标。');
    }

    const archivePath = path.join(target.data.installPath, ...adapter.layout.archive.split('/'));
    const snapshot = await readAsar(archivePath);
    if (!snapshot.success) return snapshot;
    if (snapshot.data.sha256 !== record.beforeHash) {
      return fail(
        'TARGET_HASH_MISMATCH',
        '目标在准备之后发生了变化',
        '可能已更新或被其他程序改动；请重新准备并再次应用。',
        `staged=${record.beforeHash} current=${snapshot.data.sha256}`,
      );
    }

    /*
     * A2：不再从用户源路径重读文件。
     * 私有副本 + 内容指纹才是「用户确认过的那份内容」；副本丢失或变化一律拒绝，
     * 绝不把新读到的图默默套上旧配色参数。
     */
    if (!record.contentHash) {
      return fail(
        'IMAGE_CONTENT_MISMATCH',
        '这份准备记录来自旧版本，缺少图片内容指纹',
        '为避免写出没预览过的图片，已拒绝本次应用；请重新准备一次。',
        `operationId=${record.operationId}`,
      );
    }
    const pinned = await this.opts.images.readBytes(record.imageId);
    if (!pinned.success) return pinned;
    const imageHash = crypto.createHash('sha256').update(pinned.data).digest('hex');
    if (imageHash !== record.contentHash) {
      return fail(
        'IMAGE_CONTENT_MISMATCH',
        '图片内容与准备时不一致',
        '请重新准备并确认预览后再应用；安装未被修改。',
        `staged=${record.contentHash} current=${imageHash}`,
      );
    }
    const imageBytes = pinned.data;

    {
      const r = await coreApply({
        target: target.data,
        runtimeRoot: this.opts.runtimeRoot,
        css: record.css,
        imageBytes,
        themeSummary: record.themeSummary,
        themeHash: computeThemeHash(record.css, imageBytes),
        ...(record.contrastOverride ? { contrastOverride: record.contrastOverride } : {}),
        ...(this.opts.probe ? { hooks: { probe: this.opts.probe } } : {}),
        onEvent: (e) => this.opts.bus.emit({ ...e, operationId }),
      });
      if (!r.success) return r;
      await fs.rm(file, { force: true }).catch(() => undefined);
      return ok(r.data.manifest);
    }
  }

  async listBackups(targetId: string): Promise<Result<BackupInfo[]>> {
    const target = this.opts.targets.get(targetId);
    if (!target.success) return target;
    const layout = this.layoutFor(target.data.installPath);

    const out: BackupInfo[] = [];
    const originals = await listBackupRecords(originalDir(layout));
    const latestOriginal = originals[originals.length - 1];
    if (latestOriginal) {
      // 有原版证据才叫 original；否则如实呈现为「首次接管快照」（R2）
      const isFactory = latestOriginal.evidence === 'factory';
      out.push({
        backupId: path.basename(latestOriginal.file, '.asar'),
        createdAt: latestOriginal.createdAt,
        kind: isFactory ? 'original' : 'takeover',
        themeSummary: isFactory
          ? (latestOriginal.note ?? '首次接管时的状态（已证明为出厂原版）')
          : '首次接管快照（无法证明是出厂原版）',
        applicableVersion: latestOriginal.version,
        pristine: isFactory,
        ...(latestOriginal.note ? { evidenceNote: latestOriginal.note } : {}),
        health: latestOriginal.health,
        sizeBytes: latestOriginal.size,
      });
    }

    for (const rec of await listBackupRecords(previousDir(layout))) {
      out.push({
        backupId: path.basename(rec.file, '.asar'),
        createdAt: rec.createdAt,
        kind: 'previous',
        themeSummary: rec.note ?? '应用前的上一状态',
        applicableVersion: rec.version,
        pristine: rec.pristine,
        health: rec.health,
        sizeBytes: rec.size,
      });
    }

    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return ok(out);
  }

  async restore(input: RestoreThemeInput): Promise<Result<OperationManifest>> {
    const target = await this.opts.targets.refresh(input?.targetId);
    if (!target.success) return target;

    const layout = this.layoutFor(target.data.installPath);
    await ensureDirs(layout);

    const r = await restoreTarget({
      target: target.data,
      layout,
      kind:
        input.kind === 'original' ? 'original' : input.kind === 'takeover' ? 'takeover' : 'previous',
      ...(this.opts.probe ? { probe: this.opts.probe } : {}),
    });
    if (!r.success) return r;
    return ok(r.data.manifest);
  }

  async getOperation(operationId: string): Promise<Result<OperationManifest>> {
    if (!operationId) {
      return fail('INVALID_PARAMS', '缺少操作标识', '请刷新后重试。');
    }
    const found = await this.findTx(operationId);
    if (!found) {
      return fail('MANIFEST_CORRUPT', '未找到该操作记录', '请刷新后重试。');
    }
    const rec = await readTx(found.dir, operationId);
    if (!rec.success) return rec;
    const { phases: _phases, targetPath: _targetPath, ...manifest } = rec.data;
    return ok(manifest);
  }

  /**
   * 仍存在准备记录的 imageId 集合（供启动时清理孤儿副本时保留引用）。
   * 只读 staged 目录，不触碰事务与备份。
   */
  async stagedImageIds(): Promise<Set<string>> {
    const out = new Set<string>();
    const instancesDir = path.join(this.opts.runtimeRoot, 'instances');
    let names: string[];
    try {
      names = await fs.readdir(instancesDir);
    } catch {
      return out;
    }
    for (const name of names) {
      const dir = path.join(instancesDir, name, 'staged');
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as StagedRecord;
          if (raw?.imageId) out.add(raw.imageId);
        } catch {
          // 损坏的记录跳过
        }
      }
    }
    return out;
  }

  private async findStaged(operationId: string): Promise<{ record: StagedRecord; file: string } | null> {
    const instancesDir = path.join(this.opts.runtimeRoot, 'instances');
    let names: string[];
    try {
      names = await fs.readdir(instancesDir);
    } catch {
      return null;
    }
    for (const name of names) {
      const file = path.join(instancesDir, name, 'staged', `${operationId}.json`);
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8')) as StagedRecord;
        if (raw && raw.operationId === operationId) return { record: raw, file };
      } catch {
        // 该文件不存在或损坏，继续找下一个实例
      }
    }
    return null;
  }

  private async findTx(operationId: string): Promise<{ dir: string } | null> {
    const instancesDir = path.join(this.opts.runtimeRoot, 'instances');
    let names: string[];
    try {
      names = await fs.readdir(instancesDir);
    } catch {
      return null;
    }
    for (const name of names) {
      const dir = path.join(instancesDir, name, 'transactions');
      try {
        await fs.access(path.join(dir, `${operationId}.json`));
        return { dir };
      } catch {
        // 继续找
      }
    }
    return null;
  }
}
