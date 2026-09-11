import { useCallback, useEffect, useState } from 'react';
import type { ContrastReport, TargetInfo, ThemeSpec, ThemeTokens } from '../shared/types';

const initialSpec: ThemeSpec = {
  schemaVersion: 1,
  imageId: '',
  mode: 'auto',
  palette: ['#404558', '#787e9f', '#a0a7c9'],
  overlayOpacity: 0.35,
  panelOpacity: 0.86,
  blurPx: 0,
  backgroundPosition: 'cover',
};

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string };

export default function App() {
  const [spec, setSpec] = useState<ThemeSpec>(initialSpec);
  const [tokens, setTokens] = useState<ThemeTokens | null>(null);
  const [report, setReport] = useState<ContrastReport | null>(null);
  const [targets, setTargets] = useState<TargetInfo[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '请选择一张本地图片开始。' });

  // 首次加载拉取目标列表；真实识别在 P3 实现（T50）
  useEffect(() => {
    void window.themeSwitcher.discoverTargets().then((r) => {
      if (r.success) setTargets(r.data.targets);
      else setStatus({ kind: 'error', text: `${r.error.message}｜${r.error.recoveryHint}` });
    });
  }, []);

  const pickImage = useCallback(async () => {
    setStatus({ kind: 'busy', text: '正在选择图片…' });
    const picked = await window.themeSwitcher.pickImage();
    if (!picked.success) {
      setStatus({ kind: 'error', text: `${picked.error.message}｜${picked.error.recoveryHint}` });
      return;
    }
    const imported = await window.themeSwitcher.importImage(picked.data.imageId);
    if (!imported.success) {
      setStatus({ kind: 'error', text: `${imported.error.message}｜${imported.error.recoveryHint}` });
      return;
    }
    const next: ThemeSpec = { ...spec, imageId: imported.data.imageId };
    setSpec(next);
    setStatus({ kind: 'ok', text: `已导入 ${picked.data.fileName}（${imported.data.width}×${imported.data.height}），原图只读。` });
  }, [spec]);

  const generate = useCallback(async () => {
    if (!spec.imageId) {
      setStatus({ kind: 'error', text: '尚未选择图片。｜请先点击「选择图片」。' });
      return;
    }
    setStatus({ kind: 'busy', text: '正在提取配色…' });
    const theme = await window.themeSwitcher.generateTheme({ imageId: spec.imageId, spec });
    if (!theme.success) {
      setStatus({ kind: 'error', text: `${theme.error.message}｜${theme.error.recoveryHint}` });
      return;
    }
    setTokens(theme.data.tokens);
    const contrast = await window.themeSwitcher.analyzeContrast({
      imageId: spec.imageId,
      spec,
      tokens: theme.data.tokens,
    });
    if (contrast.success) setReport(contrast.data);
    setStatus({ kind: 'ok', text: '配色已生成。' });
  }, [spec]);

  const apply = useCallback(async () => {
    const target = targets[0];
    if (!target) {
      setStatus({ kind: 'error', text: '未发现可用目标。｜请确认 OpenCode 已安装。' });
      return;
    }
    setStatus({ kind: 'busy', text: '正在准备应用…' });
    const staged = await window.themeSwitcher.stageTheme({
      targetId: target.targetId,
      imageId: spec.imageId,
      spec,
    });
    if (!staged.success) {
      setStatus({ kind: 'error', text: `${staged.error.message}｜${staged.error.recoveryHint}` });
      return;
    }
    const applied = await window.themeSwitcher.applyTheme({ operationId: staged.data.operationId });
    if (!applied.success) {
      setStatus({ kind: 'error', text: `${applied.error.message}｜${applied.error.recoveryHint}` });
      return;
    }
    setStatus({ kind: 'ok', text: '主题已应用。' });
  }, [spec, targets]);

  const restore = useCallback(async () => {
    const target = targets[0];
    if (!target) return;
    setStatus({ kind: 'busy', text: '正在恢复…' });
    const r = await window.themeSwitcher.restoreTheme({ targetId: target.targetId, kind: 'previous' });
    setStatus(
      r.success
        ? { kind: 'ok', text: '已恢复。' }
        : { kind: 'error', text: `${r.error.message}｜${r.error.recoveryHint}` },
    );
  }, [targets]);

  const target = targets[0];

  return (
    <div className="app" style={tokens ? ({
      '--ts-background': tokens.background,
      '--ts-panel': tokens.panel,
      '--ts-text': tokens.text,
      '--ts-muted': tokens.muted,
      '--ts-primary': tokens.primary,
      '--ts-on-primary': tokens.onPrimary,
      '--ts-border': tokens.border,
    } as React.CSSProperties) : undefined}>
      <header className="topbar">
        <div>
          <h1>OpenCode 换肤助手</h1>
          <p className="sub">本地运行 · 不联网 · 不上传图片</p>
        </div>
        <div className="target">
          {target ? (
            <>
              <span className={`badge ${target.support}`}>{target.support}</span>
              <span className="mono">{target.version}</span>
              {target.rejectReason ? <span className="reason">{target.rejectReason}</span> : null}
            </>
          ) : (
            <span className="muted">未发现目标</span>
          )}
        </div>
      </header>

      <main className="layout">
        <section className="panel controls">
          <button className="btn primary" onClick={() => void pickImage()}>
            选择图片
          </button>
          <button className="btn" onClick={() => void generate()} disabled={!spec.imageId}>
            生成配色
          </button>

          <label className="field">
            <span>背景遮罩 {spec.overlayOpacity.toFixed(2)}</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={spec.overlayOpacity}
              onChange={(e) => setSpec({ ...spec, overlayOpacity: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>面板不透明度 {spec.panelOpacity.toFixed(2)}</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={spec.panelOpacity}
              onChange={(e) => setSpec({ ...spec, panelOpacity: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>背景模糊 {spec.blurPx} px</span>
            <input
              type="range" min={0} max={20} step={1}
              value={spec.blurPx}
              onChange={(e) => setSpec({ ...spec, blurPx: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>明暗模式</span>
            <select value={spec.mode} onChange={(e) => setSpec({ ...spec, mode: e.target.value as ThemeSpec['mode'] })}>
              <option value="auto">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>

          <div className="actions">
            <button className="btn primary" onClick={() => void apply()}>应用到 OpenCode</button>
            <button className="btn" onClick={() => void restore()}>恢复上一主题</button>
          </div>
        </section>

        <section className="panel preview">
          <div className="preview-note">模拟预览，真实效果取决于已验证版本</div>
          <div className="mock-window">
            <div className="mock-sidebar">
              <div className="mock-item active">会话一</div>
              <div className="mock-item">会话二</div>
              <div className="mock-item">设置</div>
            </div>
            <div className="mock-main">
              <div className="msg user">帮我把这段代码改成异步</div>
              <div className="msg bot">
                好的，下面是修改后的版本。
                <pre className="code">
                  <code>{`async function run() {\n  const r = await fetch(url);\n  return r.json();\n}`}</code>
                </pre>
              </div>
              <div className="msg-row">
                <input className="input" placeholder="输入消息…" readOnly />
                <button className="btn small primary">发送</button>
              </div>
              <div className="states">
                <button className="btn small">默认</button>
                <button className="btn small hover">悬停</button>
                <button className="btn small pressed">按下</button>
                <button className="btn small focus">焦点</button>
              </div>
              <div className="feedback">
                <span className="err">错误：无法连接</span>
                <span className="warn">警告：配置缺失</span>
                <span className="ok">成功：已保存</span>
              </div>
              <div className="diff">
                <div className="add">+ const r = await fetch(url)</div>
                <div className="del">- const r = fetch(url)</div>
              </div>
            </div>
          </div>
        </section>

        <section className="panel report">
          <h2>可读性检查</h2>
          {report ? (
            <>
              <p className={report.passed ? 'pass' : 'fail'}>
                {report.passed ? '全部通过' : '存在未达标项'}
              </p>
              <ul className="entries">
                {report.entries.map((e) => (
                  <li key={`${e.element}-${e.state}`} className={e.pass ? 'pass' : 'fail'}>
                    <span>{e.element}·{e.state}</span>
                    <span className="mono">{e.ratio.toFixed(2)} / {e.required}</span>
                  </li>
                ))}
              </ul>
              <p className="scope">范围：{report.scope}</p>
              <p className="scope">采样：{report.sampling}</p>
              {!report.verified ? <p className="scope">未做实底保护层验证，不宣称安全通过。</p> : null}
            </>
          ) : (
            <p className="muted">生成配色后显示对比度结果。</p>
          )}
        </section>
      </main>

      <footer className={`status ${status.kind}`}>{status.text}</footer>
    </div>
  );
}
