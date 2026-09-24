import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppError,
  BackupInfo,
  DiscoveredTargets,
  GenerateThemeOutput,
  RecoveryStatus,
  StageSummary,
  TargetInfo,
} from '../shared/types';
import type { ThemeSpec } from '../shared/schema';
import { SUPPORTED_FORMATS_HINT } from '../shared/image-formats';
import Preview from './components/Preview';
import ContrastPanel from './components/ContrastPanel';
import ApplyDialog from './components/ApplyDialog';
import StructuralConfirmDialog from './components/StructuralConfirmDialog';
import ContrastOverrideDialog from './components/ContrastOverrideDialog';
import RestorePanel from './components/RestorePanel';
import RecoveryPanel from './components/RecoveryPanel';
import {
  AUTO_TUNE,
  autoTuneParams,
  blockedReason,
  canStage,
  clampSpec,
  edgeFractionFromRgba,
  errorScope,
  formatDateTime,
  isBusy,
  makeSpec,
  overlayStepUp,
  readyText,
  resetSpec,
  scopeText,
  worstMargin,
  type GateInput,
  type UiState,
} from './logic';

const SPEC_KEY = 'ots.theme-spec';
const SCALE_KEY = 'ots.ui-scale';

function loadSpec(): ThemeSpec {
  try {
    const raw = localStorage.getItem(SPEC_KEY);
    if (!raw) return makeSpec('');
    const parsed = JSON.parse(raw) as ThemeSpec;
    return clampSpec({ ...makeSpec(''), ...parsed, imageId: '' });
  } catch {
    return makeSpec('');
  }
}

function saveSpec(spec: ThemeSpec): boolean {
  try {
    localStorage.setItem(SPEC_KEY, JSON.stringify(spec));
    return true;
  } catch {
    return false;
  }
}

// 缩放档已移除（jc 拍板）：旧版本可能存过 125/150，启动时静默覆写为 100
function convergeLegacyScale(): void {
  try {
    if (localStorage.getItem(SCALE_KEY) !== '100') localStorage.setItem(SCALE_KEY, '100');
  } catch {
    // 读写不了就不管，反正不再有消费方
  }
}

function detectReducedTransparency(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 从界面已有的缩略图（data URL）算边缘占比，供「自动调整」决定模糊值。
 * 缩略图 ≤ 数百像素，这里再画到 ≤128px 做 Sobel；任何一步失败都按「平坦图」处理，
 * 推不出边缘只影响模糊给不给，不该让整个调整失败。
 */
async function measureEdgeFractionFromUrl(url: string | null): Promise<number> {
  if (!url) return 0;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx || w < 3 || h < 3) return 0;
    ctx.drawImage(img, 0, 0, w, h);
    return edgeFractionFromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return 0;
  }
}

export default function App() {
  const [spec, setSpec] = useState<ThemeSpec>(() => {
    const stored = loadSpec();
    // 首次启动时跟随系统的「减少透明度」偏好；之后以用户勾选为准（这个值会写进主题参数）
    return stored.reducedTransparency ? stored : { ...stored, reducedTransparency: detectReducedTransparency() };
  });
  const [imageName, setImageName] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateThemeOutput | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredTargets | null>(null);
  const [targetId, setTargetId] = useState<string>('');
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [ui, setUi] = useState<UiState>({ kind: 'empty' });
  const [summary, setSummary] = useState<StageSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** structural 目标的应用前置确认（S3），不影响 UiState 九类状态 */
  const [pendingStructural, setPendingStructural] = useState(false);
  /** 可读性未达标的显式放行确认（W3）：不记住选择，每次拦截都重新确认 */
  const [pendingContrast, setPendingContrast] = useState<{ items: string[]; confirmStructural: boolean } | null>(null);
  /** 实际内容格式的显示名（由主进程按 magic bytes 识别，不是后缀） */
  const [imageFormat, setImageFormat] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** F3「自动调整」进行中：只禁用该按钮本身，不占用九类界面状态 */
  const [autoTuning, setAutoTuning] = useState(false);
  /** 右栏选项卡：仅内存态，不持久化（T2） */
  const [sideTab, setSideTab] = useState<'checks' | 'restore'>('checks');
  const genRef = useRef(0);

  const targets = useMemo(() => discovered?.targets ?? [], [discovered]);
  const target: TargetInfo | undefined = useMemo(
    () => targets.find((t) => t.targetId === targetId) ?? targets[0],
    [targets, targetId],
  );
  const targetSupported = target?.support === 'supported';
  const reportPassed = result?.report.passed ?? false;
  const recoveryBlocking = (recovery?.blockingCount ?? 0) > 0;

  const gate: GateInput = {
    hasImage: Boolean(spec.imageId),
    hasPreview: Boolean(result),
    targetCount: targets.length,
    targetSupported,
    ...(target?.rejectReason ? { targetRejectReason: target.rejectReason } : {}),
    reportPassed,
    recoveryBlocking,
  };

  // 缩放档已移除：界面尺寸全部 rem/弹性，跟随系统缩放（T56 能力不变）
  useEffect(() => {
    convergeLegacyScale();
  }, []);

  const fail = useCallback((error: AppError) => {
    const scope = errorScope(error.code);
    setUi(
      error.code === 'NEEDS_RECOVERY'
        ? { kind: 'needsRecovery', message: error.message, hint: error.recoveryHint }
        : { kind: 'error', message: error.message, hint: error.recoveryHint, scope },
    );
  }, []);

  const refreshRecovery = useCallback(async () => {
    const r = await window.themeSwitcher.getRecoveryStatus();
    if (r.success) setRecovery(r.data);
  }, []);

  const refreshTargets = useCallback(async () => {
    setScanning(true);
    try {
      // R7：每次刷新目标都顺带看一次未完成事务，避免「有事务在身还继续写」
      const [r] = await Promise.all([window.themeSwitcher.discoverTargets(), refreshRecovery()]);
      if (!r.success) {
        fail(r.error);
        return;
      }
      setDiscovered(r.data);
      setTargetId((prev) => {
        if (prev && r.data.targets.some((t) => t.targetId === prev)) return prev;
        const first = r.data.targets.find((t) => t.support === 'supported') ?? r.data.targets[0];
        return first?.targetId ?? '';
      });
    } finally {
      setScanning(false);
    }
  }, [fail, refreshRecovery]);

  /** R6：手动选择安装目录。目录由主进程的对话框选出，renderer 不传路径。 */
  const chooseTargetDirectory = useCallback(async () => {
    setScanning(true);
    try {
      const r = await window.themeSwitcher.chooseTargetDirectory();
      if (!r.success) {
        fail(r.error);
        return;
      }
      if (r.data.rejected) {
        setUi({
          kind: 'error',
          message: `该目录无法作为目标：${r.data.rejected.message}`,
          hint: r.data.rejected.recoveryHint,
          scope: 'unmodified',
        });
        return;
      }
      if (r.data.target) {
        setTargetId(r.data.target.targetId);
        await refreshTargets();
      }
    } finally {
      setScanning(false);
    }
  }, [fail, refreshTargets]);

  const refreshBackups = useCallback(async (id: string) => {
    if (!id) return;
    const r = await window.themeSwitcher.listBackups(id);
    if (r.success) setBackups(r.data);
  }, []);

  // refreshTargets 依赖 fail / refreshRecovery，两者都是稳定引用，
  // 因此这个 effect 只会在挂载时跑一次；之后由「重新检测」按钮驱动。
  useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);

  useEffect(() => {
    void refreshBackups(target?.targetId ?? '');
  }, [target?.targetId, refreshBackups]);

  // 进度事件（T15）
  useEffect(() => {
    return window.themeSwitcher.onOperationEvent((e) => {
      setUi((prev) =>
        prev.kind === 'applying'
          ? { kind: 'applying', phase: e.message, ...(e.percent === undefined ? {} : { percent: e.percent }) }
          : prev,
      );
    });
  }, []);

  const generate = useCallback(
    async (next: ThemeSpec, imageId: string) => {
      if (!imageId) {
        setResult(null);
        setUi({ kind: 'empty' });
        return;
      }
      const my = genRef.current + 1;
      genRef.current = my;
      setUi({ kind: 'analyzing' });
      const r = await window.themeSwitcher.generateTheme({ imageId, spec: next });
      if (my !== genRef.current) return; // 旧结果不得覆盖新图（T52）
      if (!r.success) {
        fail(r.error);
        return;
      }
      setResult(r.data);
      setUi({ kind: 'ready' });
    },
    [fail],
  );

  // 参数变化后自动重算；250ms 防抖，滑杆拖动不会每像素打一次 IPC
  useEffect(() => {
    const t = setTimeout(() => {
      void generate(clampSpec(spec), spec.imageId);
    }, 250);
    return () => clearTimeout(t);
  }, [spec, generate]);

  const adoptImage = useCallback(
    async (imported: { imageId: string; fileName?: string; formatLabel?: string; note?: string }) => {
      const next = { ...spec, imageId: imported.imageId };
      setSpec(next);
      if (imported.fileName) setImageName(imported.fileName);
      setImageFormat(imported.formatLabel ?? null);
      if (imported.note) setNotice(imported.note);
      if (!saveSpec(next)) setNotice('参数未能保存到本机，下次启动会回到默认值。');
      const url = await window.themeSwitcher.getImagePreview(imported.imageId);
      if (url.success) setPreviewUrl(url.data);
      else setPreviewUrl(null);
    },
    [spec],
  );

  const pickImage = useCallback(async () => {
    setUi({ kind: 'analyzing' });
    const picked = await window.themeSwitcher.pickImage();
    if (!picked.success) {
      if (picked.error.code === 'IMAGE_NOT_FOUND') {
        setUi({ kind: result ? 'ready' : 'empty' });
        return;
      }
      fail(picked.error);
      return;
    }
    const imported = await window.themeSwitcher.importImage(picked.data.imageId);
    if (!imported.success) {
      fail(imported.error);
      return;
    }
    await adoptImage({
      imageId: imported.data.imageId,
      fileName: picked.data.fileName,
      ...(imported.data.formatLabel ? { formatLabel: imported.data.formatLabel } : {}),
      ...(imported.data.note ? { note: imported.data.note } : {}),
    });
  }, [adoptImage, fail, result]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      setUi({ kind: 'analyzing' });
      const data = new Uint8Array(await file.arrayBuffer());
      const imported = await window.themeSwitcher.importImageData({ fileName: file.name, data });
      if (!imported.success) {
        fail(imported.error);
        return;
      }
      // 用新图的代表色替换旧色板，避免旧图参数残留
      const next: ThemeSpec = { ...spec, imageId: imported.data.imageId, palette: imported.data.palette };
      setSpec(next);
      setImageName(file.name);
      setImageFormat(imported.data.formatLabel ?? null);
      if (imported.data.note) setNotice(imported.data.note);
      if (!saveSpec(next)) setNotice('参数未能保存到本机，下次启动会回到默认值。');
      const url = await window.themeSwitcher.getImagePreview(imported.data.imageId);
      setPreviewUrl(url.success ? url.data : null);
    },
    [fail, spec],
  );

  const updateSpec = useCallback((patch: Partial<ThemeSpec>) => {
    setSpec((prev) => {
      const next = clampSpec({ ...prev, ...patch });
      if (!saveSpec(next)) setNotice('参数未能保存到本机，下次启动会回到默认值。');
      return next;
    });
  }, []);

  /**
   * F3「自动调整」：按图片代表色与边缘占比推导三个滑杆值（确定性，不随机），
   * 再复用生成层的对比度自检逐步上调遮罩——每次 +0.05、封顶后如实停在最优值。
   * 只改参数，不触发应用；探参走的是和滑杆完全相同的 generateTheme 通道。
   */
  const autoAdjust = useCallback(async () => {
    if (!result || !spec.imageId) return;
    setAutoTuning(true);
    try {
      const edgeFrac = await measureEdgeFractionFromUrl(previewUrl);
      const tuned = autoTuneParams(result.palette, edgeFrac);
      let overlay = tuned.overlayOpacity;
      let best: { overlay: number; margin: number } | null = null;
      for (let attempt = 0; attempt < AUTO_TUNE.maxAttempts; attempt++) {
        const trial = clampSpec({ ...spec, ...tuned, overlayOpacity: overlay });
        const r = await window.themeSwitcher.generateTheme({ imageId: trial.imageId, spec: trial });
        if (r.success) {
          const margin = worstMargin(r.data.report);
          if (!best || margin > best.margin) best = { overlay, margin };
          if (r.data.report.passed) {
            updateSpec({ ...tuned, overlayOpacity: overlay });
            setNotice(
              `自动调整完成：遮罩 ${overlay.toFixed(2)}、面板 ${tuned.panelOpacity.toFixed(2)}、模糊 ${tuned.blurPx}px。`,
            );
            return;
          }
        } else if (r.error.code !== 'CONTRAST_BELOW_TARGET') {
          fail(r.error);
          return;
        }
        const nextOverlay = overlayStepUp(overlay);
        if (nextOverlay === overlay) break;
        overlay = nextOverlay;
      }
      // 全程没有一项 trial 通过：落到余量最好的遮罩值，并如实说明仍需手动微调
      const fallback = best ? best.overlay : overlay;
      updateSpec({ ...tuned, overlayOpacity: fallback });
      setNotice(`已按图片推导并把遮罩提到 ${fallback.toFixed(2)}，仍存在未达标项：请手动微调遮罩或面板不透明度。`);
    } finally {
      setAutoTuning(false);
    }
  }, [fail, previewUrl, result, spec, updateSpec]);

  const stage = useCallback(
    async (confirmStructural: boolean, allowContrastOverride = false) => {
      if (!target) return;
      if (!canStage({ ...gate, busy: isBusy(ui) })) return;
      setUi({ kind: 'staging' });
      const r = await window.themeSwitcher.stageTheme({
        targetId: target.targetId,
        imageId: spec.imageId,
        spec,
        confirmStructural,
        ...(allowContrastOverride ? { allowContrastOverride: true } : {}),
      });
      if (!r.success) {
        await refreshRecovery();
        // 对比度不达标：不直接报错，改为弹出显式放行确认区（W3）
        if (r.error.code === 'CONTRAST_BELOW_TARGET' && !allowContrastOverride) {
          const items = (r.error.detail ?? '').split('；').filter(Boolean);
          setUi({ kind: 'ready' });
          setPendingContrast({ items, confirmStructural });
          return;
        }
        fail(r.error);
        return;
      }
      setSummary(r.data.summary);
      setUi({ kind: 'confirming' });
    },
    [fail, gate, refreshRecovery, spec, target, ui],
  );

  const apply = useCallback(async () => {
    if (!summary) return;
    setUi({ kind: 'applying', phase: '正在写入应用资源…' });
    const r = await window.themeSwitcher.applyTheme({
      operationId: summary.operationId,
      // 前置确认框已给过；后端 apply 入口还会按同一标志再核一次（S2）
      ...(target?.verifiedBy === 'structural' ? { confirmStructural: true } : {}),
    });
    setSummary(null);
    if (!r.success) {
      await refreshRecovery();
      fail(r.error);
      return;
    }
    setUi({ kind: 'success', message: `已应用（${formatDateTime(r.data.createdAt)}）。请重新启动 OpenCode 查看效果。` });
    await refreshBackups(target?.targetId ?? '');
  }, [fail, refreshBackups, refreshRecovery, summary, target?.targetId, target?.verifiedBy]);

  const restore = useCallback(
    async (kind: 'original' | 'previous' | 'takeover') => {
      if (!target) return;
      setUi({ kind: 'applying', phase: '正在恢复…' });
      const r = await window.themeSwitcher.restoreTheme({ targetId: target.targetId, kind });
      if (!r.success) {
        await refreshRecovery();
        fail(r.error);
        return;
      }
      const label =
        kind === 'original' ? '已恢复原版。' : kind === 'takeover' ? '已恢复到首次接管时的状态。' : '已恢复上一主题。';
      setUi({ kind: 'success', message: label });
      await Promise.all([refreshBackups(target.targetId), refreshRecovery()]);
    },
    [fail, refreshBackups, refreshRecovery, target],
  );

  const resolveRecovery = useCallback(
    async (operationId: string, action: 'mark-applied' | 'mark-failed' | 'acknowledge') => {
      const r = await window.themeSwitcher.resolveRecovery({ operationId, action });
      if (!r.success) {
        fail(r.error);
        return;
      }
      setRecovery(r.data);
      setNotice('待处理事务状态已更新。');
    },
    [fail],
  );

  const blocked = blockedReason(gate);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <h1>OpenCode 换肤助手</h1>
          <p className="sub">本地运行 · 不联网 · 不上传图片</p>
        </div>

        <div className="topbar-right">
          <div className="target">
            {target ? (
              <>
                {target.verifiedBy === 'structural' ? (
                  <span className="badge supported structural" title="此版本未列入白名单，已通过代码结构验证">
                    结构验证通过
                  </span>
                ) : (
                  <span className={`badge ${target.support}`}>{target.support}</span>
                )}
                <span className="mono">{target.version}</span>
                <span className="muted truncate" title={target.installPath}>{target.installPath}</span>
                {target.rejectReason ? (
                  <span className="reason truncate" title={target.rejectReason}>{target.rejectReason}</span>
                ) : null}
              </>
            ) : (
              <span className="muted">未发现目标</span>
            )}
          </div>
        </div>
      </header>

      <main className="layout">
        <section className="panel controls">
          <h2>图片与参数</h2>

          <div
            className={`dropzone ${dragging ? 'dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => void onDrop(e)}
          >
            {previewUrl ? (
              <img className="thumb" src={previewUrl} alt="已选择的背景图片缩略图" />
            ) : (
              <div className="dropzone-hint">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <circle cx="9" cy="10" r="1.8" />
                  <path d="M4.5 17.5l4.2-4.2a1.5 1.5 0 0 1 2.1 0l6 6" />
                  <path d="M14.5 16l2.2-2.2a1.5 1.5 0 0 1 2.1 0l.7.7" />
                </svg>
                <p className="muted">把图片拖到这里，或点击下面的按钮选择</p>
              </div>
            )}
          </div>

          <div className="btn-row">
            <button className="btn primary" type="button" onClick={() => void pickImage()} disabled={isBusy(ui)}>
              选择图片
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void autoAdjust()}
              disabled={!result || isBusy(ui) || autoTuning}
              title="按图片明暗与边缘自动推导遮罩、面板不透明度与模糊，并自检可读性"
            >
              {autoTuning ? '调整中…' : '自动调整'}
            </button>
          </div>
          <p className="scope">
            {imageName || '尚未选择图片'}
            {imageFormat ? ` · 实际格式 ${imageFormat}` : ''}
          </p>
          <p className="scope">支持 {SUPPORTED_FORMATS_HINT}；扩展名仅用于筛选，格式按实际内容识别。</p>

          <label className="field">
            <span>背景遮罩 {spec.overlayOpacity.toFixed(2)}</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={spec.overlayOpacity}
              onChange={(e) => updateSpec({ overlayOpacity: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>面板不透明度 {spec.panelOpacity.toFixed(2)}</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={spec.panelOpacity}
              disabled={spec.reducedTransparency}
              onChange={(e) => updateSpec({ panelOpacity: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>背景模糊 {spec.blurPx} px</span>
            <input
              type="range" min={0} max={20} step={1}
              value={spec.blurPx}
              onChange={(e) => updateSpec({ blurPx: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>明暗模式</span>
            <select
              value={spec.mode}
              onChange={(e) => updateSpec({ mode: e.target.value as ThemeSpec['mode'] })}
            >
              <option value="auto">跟随图片明暗</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="field">
            <span>主色（留空则按图片自动取）</span>
            <div className="primary-row">
              <input
                type="color"
                value={spec.primary ?? result?.tokens.primary ?? '#3b6fd4'}
                onChange={(e) => updateSpec({ primary: e.target.value })}
              />
              <button
                className="btn small"
                type="button"
                onClick={() => updateSpec({ primary: undefined })}
                disabled={!spec.primary}
              >
                跟随图片
              </button>
            </div>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={spec.reducedTransparency}
              onChange={(e) => updateSpec({ reducedTransparency: e.target.checked })}
            />
            <span>减少透明度（面板用纯色）</span>
          </label>

          <div className="actions">
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                // structural 通道先过逐项确认框，确认后才进入准备/应用流程（S3）
                if (target?.verifiedBy === 'structural') {
                  setPendingStructural(true);
                  return;
                }
                void stage(false);
              }}
              disabled={Boolean(blocked) || isBusy(ui)}
              title={blocked ?? undefined}
            >
              应用到 OpenCode
            </button>
            <button className="btn" type="button" onClick={() => updateSpec(resetSpec(spec))}>
              重置参数
            </button>
          </div>
          {blocked ? <p className="scope">{blocked}</p> : null}
        </section>

        <section className="panel preview-panel">
          <h2>模拟预览</h2>
          {result ? (
            <Preview tokens={result.tokens} imageUrl={previewUrl} spec={spec} />
          ) : (
            <div className="empty-preview">
              <p className="muted">
                {ui.kind === 'analyzing' ? '正在提取配色…' : '选择一张图片后，这里会显示模拟预览。'}
              </p>
            </div>
          )}
        </section>

        <div className="side-column">
          <div className="tabs" role="tablist" aria-label="诊断与恢复">
            <button
              type="button"
              role="tab"
              id="tab-checks"
              aria-selected={sideTab === 'checks'}
              aria-controls="tabpanel-checks"
              className={`tab ${sideTab === 'checks' ? 'active' : ''}`}
              onClick={() => setSideTab('checks')}
            >
              检查
            </button>
            <button
              type="button"
              role="tab"
              id="tab-restore"
              aria-selected={sideTab === 'restore'}
              aria-controls="tabpanel-restore"
              className={`tab ${sideTab === 'restore' ? 'active' : ''}`}
              onClick={() => setSideTab('restore')}
            >
              恢复
            </button>
          </div>

          {sideTab === 'checks' ? (
            <div role="tabpanel" id="tabpanel-checks" aria-labelledby="tab-checks">
              <ContrastPanel report={result?.report ?? null} effectiveBackground={result?.effectiveBackground ?? null} />
            </div>
          ) : (
            <div role="tabpanel" id="tabpanel-restore" aria-labelledby="tab-restore">
              <section className="panel">
                <div className="panel-head">
                  <h2>目标</h2>
                  <div className="panel-actions">
                    <button
                      className="btn small"
                      type="button"
                      onClick={() => void refreshTargets()}
                      disabled={scanning || isBusy(ui)}
                    >
                      {scanning ? '检测中…' : '重新检测'}
                    </button>
                    <button
                      className="btn small"
                      type="button"
                      onClick={() => void chooseTargetDirectory()}
                      disabled={scanning || isBusy(ui)}
                    >
                      选择安装目录
                    </button>
                  </div>
                </div>

                {targets.length > 1 ? (
                  <label className="field">
                    <span>检测到多个安装，选择要操作的目标</span>
                    <select value={target?.targetId ?? ''} onChange={(e) => setTargetId(e.target.value)}>
                      {targets.map((t) => (
                        <option key={t.targetId} value={t.targetId}>
                          {t.installPath}（{t.version} · {t.support}）
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {targets.length === 0 ? (
                  <p className="scope">
                    未发现 OpenCode 安装。请点「重新检测」；若仍找不到，用「选择安装目录」手动指定安装目录
                    （目录里应有 resources 文件夹）。
                  </p>
                ) : null}

                {discovered && discovered.rejected.length > 0 ? (
                  <ul className="entries">
                    {discovered.rejected.map((r) => (
                      <li key={r.path} className="fail">
                        <span className="entry-name">
                          [{r.code}] {r.message}
                        </span>
                        <span className="mono">{r.path}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {discovered && discovered.scanned.length > 0 ? (
                  <details className="scan-details">
                    <summary>已检查 {discovered.scanned.length} 个登记位置（不做全盘搜索）</summary>
                    <ul className="entries">
                      {discovered.scanned.map((p) => (
                        <li key={p} className="mono">{p}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </section>

              <RecoveryPanel status={recovery} busy={isBusy(ui)} onResolve={resolveRecovery} />

              <RestorePanel
                backups={backups}
                busy={isBusy(ui)}
                onRestore={(kind) => void restore(kind)}
                onRefresh={() => void refreshBackups(target?.targetId ?? '')}
              />
            </div>
          )}
        </div>
      </main>

      <footer className={`status ${ui.kind}`}>
        {ui.kind === 'empty' || ui.kind === 'ready' ? readyText(gate) : null}
        {ui.kind === 'analyzing' ? '正在提取配色…' : null}
        {ui.kind === 'staging' ? '正在检查目标与生成准备内容…' : null}
        {ui.kind === 'confirming' ? '请确认应用信息。' : null}
        {ui.kind === 'applying' ? (
          <>
            {ui.phase}
            {ui.percent === undefined ? null : `（${ui.percent}%）`}
          </>
        ) : null}
        {ui.kind === 'success' ? ui.message : null}
        {ui.kind === 'error' ? (
          <>
            <strong>{ui.message}</strong>
            <span>{ui.hint}</span>
            <span>{scopeText(ui.scope)}</span>
          </>
        ) : null}
        {ui.kind === 'needsRecovery' ? (
          <>
            <strong>{ui.message}</strong>
            <span>{ui.hint}</span>
            <span>请先切到右侧「恢复」选项卡处理；不要手动替换应用文件。</span>
          </>
        ) : null}
        {notice ? <span className="notice">{notice}</span> : null}
      </footer>

      {ui.kind === 'confirming' && summary ? (
        <ApplyDialog
          summary={summary}
          busy={false}
          onCancel={() => {
            setSummary(null);
            setUi({ kind: 'ready' });
          }}
          onConfirm={() => void apply()}
        />
      ) : null}

      {pendingStructural && target?.verifiedBy === 'structural' ? (
        <StructuralConfirmDialog
          target={target}
          onCancel={() => setPendingStructural(false)}
          onConfirm={() => {
            setPendingStructural(false);
            void stage(true);
          }}
        />
      ) : null}

      {pendingContrast ? (
        <ContrastOverrideDialog
          items={pendingContrast.items}
          onCancel={() => setPendingContrast(null)}
          onConfirm={() => {
            const { confirmStructural } = pendingContrast;
            // 不记住选择：先清空再带 override 重提，本次点击只授权这一单（W3）
            setPendingContrast(null);
            void stage(confirmStructural, true);
          }}
        />
      ) : null}
    </div>
  );
}
