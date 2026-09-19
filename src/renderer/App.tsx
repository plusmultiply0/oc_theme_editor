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
import RestorePanel from './components/RestorePanel';
import RecoveryPanel from './components/RecoveryPanel';
import {
  blockedReason,
  canStage,
  clampSpec,
  errorScope,
  formatDateTime,
  isBusy,
  makeSpec,
  readyText,
  resetSpec,
  scopeText,
  type GateInput,
  type UiState,
} from './logic';

const SPEC_KEY = 'ots.theme-spec';
const SCALE_KEY = 'ots.ui-scale';

const SCALES = [
  { label: '100%', value: 100 },
  { label: '125%', value: 125 },
  { label: '150%', value: 150 },
] as const;

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

function loadScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY));
    return SCALES.some((s) => s.value === v) ? v : 100;
  } catch {
    return 100;
  }
}

function detectReducedTransparency(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  } catch {
    return false;
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
  const [scale, setScale] = useState<number>(loadScale);
  const [notice, setNotice] = useState<string | null>(null);
  /** 实际内容格式的显示名（由主进程按 magic bytes 识别，不是后缀） */
  const [imageFormat, setImageFormat] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
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

  // 缩放：改根字号，布局用 rem，125% / 150% 下不裁切（T56）
  useEffect(() => {
    document.documentElement.style.fontSize = `${(16 * scale) / 100}px`;
    try {
      localStorage.setItem(SCALE_KEY, String(scale));
    } catch {
      setNotice('界面缩放未能保存，下次启动会回到 100%。');
    }
  }, [scale]);

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

  const stage = useCallback(async () => {
    if (!target) return;
    if (!canStage({ ...gate, busy: isBusy(ui) })) return;
    setUi({ kind: 'staging' });
    const r = await window.themeSwitcher.stageTheme({
      targetId: target.targetId,
      imageId: spec.imageId,
      spec,
    });
    if (!r.success) {
      await refreshRecovery();
      fail(r.error);
      return;
    }
    setSummary(r.data.summary);
    setUi({ kind: 'confirming' });
  }, [fail, gate, refreshRecovery, spec, target, ui]);

  const apply = useCallback(async () => {
    if (!summary) return;
    setUi({ kind: 'applying', phase: '正在写入应用资源…' });
    const r = await window.themeSwitcher.applyTheme({ operationId: summary.operationId });
    setSummary(null);
    if (!r.success) {
      await refreshRecovery();
      fail(r.error);
      return;
    }
    setUi({ kind: 'success', message: `已应用（${formatDateTime(r.data.createdAt)}）。请重新启动 OpenCode 查看效果。` });
    await refreshBackups(target?.targetId ?? '');
  }, [fail, refreshBackups, refreshRecovery, summary, target?.targetId]);

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
        <div>
          <h1>OpenCode 换肤助手</h1>
          <p className="sub">本地运行 · 不联网 · 不上传图片</p>
        </div>

        <div className="topbar-right">
          <div className="scale" role="group" aria-label="界面缩放">
            {SCALES.map((s) => (
              <button
                key={s.value}
                className={`btn small ${scale === s.value ? 'active' : ''}`}
                type="button"
                aria-pressed={scale === s.value}
                onClick={() => setScale(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="target">
            {target ? (
              <>
                <span className={`badge ${target.support}`}>{target.support}</span>
                <span className="mono">{target.version}</span>
                <span className="muted">{target.installPath}</span>
                {target.rejectReason ? <span className="reason">{target.rejectReason}</span> : null}
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

          <button className="btn primary" type="button" onClick={() => void pickImage()} disabled={isBusy(ui)}>
            选择图片
          </button>
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
              onClick={() => void stage()}
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
          <ContrastPanel report={result?.report ?? null} effectiveBackground={result?.effectiveBackground ?? null} />

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
            <span>请先在上方「待恢复」面板处理；不要手动替换应用文件。</span>
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
    </div>
  );
}
