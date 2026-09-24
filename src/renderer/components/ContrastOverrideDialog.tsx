/**
 * 可读性未达标时的显式放行确认区（W3）。
 *
 * 默认拒绝：只有在这里点「仍要应用」才会带 override 重提；
 * 不默认勾选、不记住选择，确认按钮不抢焦点（焦点落在「取消」上）。
 */
import { useEffect, useRef } from 'react';

export interface ContrastOverrideDialogProps {
  /** 未达标项清单（来自服务端拒绝，原样展示） */
  items: string[];
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ContrastOverrideDialog({ items, onCancel, onConfirm }: ContrastOverrideDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
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
        aria-labelledby="contrast-override-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="contrast-override-title">可读性未达标，安装未被修改</h2>

        <p className="scope">以下元素未达到可读性目标：</p>
        <ul className="tight">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <p className="risk">
          仍要应用的话，<strong>真机上这些位置的文字可能难以辨认</strong>。
          建议先调高「背景遮罩」或「面板不透明度」再应用；
          本次放行会连同未达标清单如实记入操作记录，随时可用「恢复」撤销。
        </p>

        <div className="modal-actions">
          <button className="btn primary" type="button" ref={cancelRef} onClick={onCancel}>
            取消，回去调参
          </button>
          <button className="btn danger" type="button" onClick={onConfirm}>
            仍要应用
          </button>
        </div>
      </div>
    </div>
  );
}
