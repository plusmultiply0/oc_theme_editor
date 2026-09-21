/**
 * 结构验证通道的应用前确认框（S3）。
 *
 * structural 目标未列入白名单，只是代码结构检查通过；
 * 应用前必须让用户看到逐项结论和边界，不能与白名单的「已验证」混同。
 */
import { useEffect, useRef } from 'react';
import type { TargetInfo } from '../../shared/types';

export interface StructuralConfirmDialogProps {
  target: TargetInfo;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function StructuralConfirmDialog({ target, onCancel, onConfirm }: StructuralConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="structural-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="structural-confirm-title">该版本未经白名单验证，请确认后继续</h2>

        <p className="scope">
          当前目标版本 <span className="mono">{target.version || '未知'}</span> 未列入已验证版本白名单，
          本工具按代码结构检查放行。逐项结论如下：
        </p>

        <ul className="tight">
          {(target.compatChecks ?? []).map((c) => (
            <li key={c.key}>
              {c.name}：<strong className={`compat-status ${c.status}`}>{c.status}</strong>
              <span className="muted">（{c.detail}）</span>
            </li>
          ))}
        </ul>

        <p className="risk">
          注意边界：结构验证只确认注入锚点唯一、待写条目归属干净，
          <strong>不等于对白名单版本做过的完整真机验证</strong>，界面细节可能出现未预期的样式偏差。
          应用后若 OpenCode 自动更新，主题可能被覆盖，需要重新应用；随时可以在本工具中恢复。
        </p>

        <div className="modal-actions">
          <button className="btn" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" type="button" ref={confirmRef} onClick={onConfirm}>
            我了解，继续
          </button>
        </div>
      </div>
    </div>
  );
}
