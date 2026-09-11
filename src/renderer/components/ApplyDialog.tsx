/**
 * 应用确认对话框（T54）。
 *
 * 必须说清：装到哪、什么版本、会改哪些条目、备份放哪、这是非官方修改。
 * 按钮只提交已准备的 operationId，不接受任何路径；提交中禁用，防止双击开两个事务。
 */
import { useEffect, useRef } from 'react';
import type { StageSummary } from '../../shared/ipc';
import { formatBytes } from '../logic';

export interface ApplyDialogProps {
  summary: StageSummary;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ApplyDialog({ summary, busy, onCancel, onConfirm }: ApplyDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => { if (!busy) onCancel(); }}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="apply-title">确认应用到 OpenCode</h2>

        <dl className="confirm-list">
          <dt>安装位置</dt>
          <dd className="mono">{summary.installPath}</dd>
          <dt>版本</dt>
          <dd className="mono">{summary.version}</dd>
          <dt>变更范围</dt>
          <dd>
            <ul className="tight">
              {summary.changedFiles.map((f) => (
                <li key={f} className="mono">{f}</li>
              ))}
            </ul>
          </dd>
          <dt>备份位置</dt>
          <dd className="mono">{summary.backupDir}</dd>
          <dt>需要空间</dt>
          <dd>约 {formatBytes(summary.requiredBytes)}（当前可用 {formatBytes(summary.freeBytes)}）</dd>
          <dt>主题</dt>
          <dd>{summary.themeSummary}</dd>
          <dt>旧主题层</dt>
          <dd>
            {summary.legacyThemes.length > 0 ? (
              <>
                <ul className="tight">
                  {summary.legacyThemes.map((l) => (
                    <li key={l.entry}>
                      {l.label}
                      <span className="mono">（{l.entry}）</span>
                    </li>
                  ))}
                </ul>
                <p className="scope">
                  这些旧主题层的样式链接会从 HTML 中撤下，只保留本工具这一层；
                  它们的文件本体保留在归档里，随时可以恢复。
                  {summary.keptAssets.length > 0
                    ? `配套资源不动：${summary.keptAssets.join('、')}。`
                    : ''}
                </p>
              </>
            ) : (
              <span>未发现需要撤下的旧主题层。</span>
            )}
          </dd>
        </dl>

        <p className="risk">
          这是<strong>非官方的本地资源定制</strong>，会改写应用归档内的上述条目。
          应用更新或修复安装后定制会失效，需要重新应用；卸载前请先恢复。
        </p>

        <div className="modal-actions">
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '正在应用…' : '确认应用'}
          </button>
        </div>
      </div>
    </div>
  );
}
