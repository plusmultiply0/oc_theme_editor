import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppError,
  BackupInfo,
  DiscoveredTargets,
  GenerateThemeOutput,
  StageSummary,
  TargetInfo,
} from '../shared/types';
import type { ThemeSpec } from '../shared/schema';
import Preview from './components/Preview';
import ContrastPanel from './components/ContrastPanel';
import ApplyDialog from './components/ApplyDialog';
import RestorePanel from './components/RestorePanel';
import {
  blockedReason,
  canStage,
  clampSpec,
  errorScope,
  formatDateTime,
  isBusy,
  makeSpec,
  resetSpec,
  scopeText,
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
  const [spec, setSpec] = useState<ThemeSpec>(loadSpec);
  const [imageName, setImageName] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateThemeOutput | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredTargets | null>(null);
  const [targetId, setTargetId] = useState<string>('');
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [ui, setUi] = useState<UiState>({ kind: 'empty' });
  const [summary, setSummary] = useState<StageSummary | null>(null);
  const [scale, setScale] = useState<number>(loadScale);
  const [reducedTransparency, setReducedTransparency] = useState<boolean>(detectReducedTransparency);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const genRef = useRef(0);

  const targets = useMemo(() => discovered?.targets ?? [], [discovered]);
  const target: TargetInfo | undefined = useMemo(
    () => targets.find((t) => t.targetId === targetId) ?? targets[0],
    [targets, targetId],
  );
  const targetSupported = target?.support === 'supported';
  const reportPassed = result?.report.passed ?? false;

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

  const refreshTargets = useCallback(async () => {
    const r = await window.themeSwitcher.discoverTargets();
    if (!r.success) {
      fail(r.error);
      return;
    }
    setDiscovered(r.data);
    const first = r.data.targets.find((t) => t.support === 'supported') ?? r.data.targets[0];
    if (first) setTargetId((prev) => prev || first.targetId);
  }, [fail]);

  const refreshBackups = useCallback(async (id: string) => {
    if (!id) return;
    const r = await window.themeSwitcher.listBackups(id);
    if (r.success) setBackups(r.data);
  }, []);

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
    async (imported: { imageId: string; fileName?: string }) => {
      const next = { ...spec, imageId: imported.imageId };
      setSpec(next);
      if (imported.fileName) setImageName(imported.fileName);
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
    await adoptImage({ imageId: imported.data.imageId, fileName: picked.data.fileName });
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
    const can = canStage({
      hasImage: Boolean(spec.imageId),
      hasPreview: Boolean(result),
      targetSupported,
      reportPassed,
      busy: isBusy(ui),
    });
    if (!can) return;
    setUi({ kind: 'staging' });
    const r = await window.themeSwitcher.stageTheme({
      targetId: target.targetId,
      imageId: spec.imageId,
      spec,
    });
    if (!r.success) {
      fail(r.error);
      return;
    }
    setSummary(r.data.summary);
    setUi({ kind: 'confirming' });
  }, [fail, reportPassed, result, spec, target, targetSupported, ui]);

  const apply = useCallback(async () => {
    if (!summary) return;
    setUi({ kind: 'applying', phase: '正在写入应用资源…' });
    const r = await window.themeSwitcher.applyTheme({ operationId: summary.operationId });
    setSummary(null);
    if (!r.success) {
      fail(r.error);
      return;
    }
    setUi({ kind: 'success', message: `已应用（${formatDateTime(r.data.createdAt)}）。请重新启动 OpenCode 查看效果。` });
    await refreshBackups(target?.targetId ?? '');
  }, [fail, refreshBackups, summary, target?.targetId]);

  const restore = useCallback(
    async (kind: 'original' | 'previous') => {
      if (!target) return;
      setUi({ kind: 'applying', phase: '正在恢复…' });
      const r = await window.themeSwitcher.restoreTheme({ targetId: target.targetId, kind });
      if (!r.success) {
        fail(r.error);
        return;
      }
      setUi({
        kind: 'success',
        message: kind === 'original' ? '已恢复原版。' : '已恢复上一主题。',
      });
      await refreshBackups(target.targetId);
    },
    [fail, refreshBackups, target],
  );

  const blocked = blockedReason({
    hasImage: Boolean(spec.imageId),
    hasPreview: Boolean(result),
    targetSupported,
    reportPassed,
  });

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
              <p className="muted">把图片拖到这里，或点击下面的按钮选择</p>
            )}
          </div>

          <button className="btn primary" type="button" onClick={() => void pickImage()} disabled={isBusy(ui)}>
            选择图片
          </button>
          <p className="scope">{imageName || '尚未选择图片'}</p>

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
              checked={reducedTransparency}
              onChange={(e) => setReducedTransparency(e.target.checked)}
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
          {result ? (
            <Preview
              tokens={result.tokens}
              imageUrl={previewUrl}
              spec={spec}
              reducedTransparency={reducedTransparency}
            />
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
          <RestorePanel
            backups={backups}
            busy={isBusy(ui)}
            onRestore={(kind) => void restore(kind)}
            onRefresh={() => void refreshBackups(target?.targetId ?? '')}
          />
          {discovered && (discovered.rejected.length > 0 || targets.length === 0) ? (
            <section className="panel">
              <h2>未通过的候选</h2>
              <ul className="entries">
                {discovered.rejected.map((r) => (
                  <li key={r.path} className="fail">
                    <span className="entry-name">{r.message}</span>
                    <span className="mono">{r.path}</span>
                  </li>
                ))}
              </ul>
              <p className="scope">
                扫过 {discovered.scanned.length} 个明确登记的位置；不做全盘搜索。
              </p>
              {discovered.scanned.length > 0 ? (
                <ul className="entries">
                  {discovered.scanned.map((p) => (
                    <li key={p} className="mono">{p}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </main>

      <footer className={`status ${ui.kind}`}>
        {ui.kind === 'empty' ? '请选择一张本地图片开始。' : null}
        {ui.kind === 'analyzing' ? '正在提取配色…' : null}
        {ui.kind === 'ready' ? '配色已生成，可继续调节或直接应用。' : null}
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
            <span>请使用「恢复」入口处理；不要手动替换应用文件。</span>
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
