/**
 * 待恢复面板（R7）。
 *
 * 启动恢复扫描不是「有函数就算做完」：界面必须把上次没有正常结束的操作摆出来，
 * 并让用户在**看得懂事实**的前提下决定怎么落账。
 * 落账方向由主进程按磁盘事实校验，界面只是发起请求。
 */
import type { RecoveryStatus } from '../../shared/ipc';
import { formatDateTime } from '../logic';

export interface RecoveryPanelProps {
  status: RecoveryStatus | null;
  busy: boolean;
  onResolve: (operationId: string, action: 'mark-applied' | 'mark-failed' | 'acknowledge') => void;
}

const ACTION_LABEL: Record<'mark-applied' | 'mark-failed' | 'acknowledge', string> = {
  'mark-applied': '标记为已应用',
  'mark-failed': '标记为未生效',
  acknowledge: '保持待处理',
};

const STATE_LABEL: Record<string, string> = {
  applied: '目标已是本次操作的结果',
  unchanged: '目标仍是操作前的状态',
  needs_recovery: '目标处于中间状态，需要人工处理',
};

export default function RecoveryPanel({ status, busy, onResolve }: RecoveryPanelProps) {
  const items = status?.items ?? [];
  const blocking = status?.blockingCount ?? 0;

  if (items.length === 0) {
    return (
      <p className="muted recovery-empty">
        没有未完成的操作。
        {status && status.stagesCleaned > 0
          ? `启动时清理了 ${status.stagesCleaned} 个残留准备区。`
          : ''}
      </p>
    );
  }

  return (
    <section className={`panel ${blocking > 0 ? 'panel-alert' : ''}`}>
      <h2>待恢复</h2>
      <p className={blocking > 0 ? 'fail' : 'scope'}>
        {blocking > 0
          ? `有 ${blocking} 个未完成事务处于中间状态，已暂停写入，请先处理。`
          : '上次操作没有正常结束，请确认后落账。'}
      </p>

      <ul className="entries">
        {items.map((it) => (
          <li key={it.operationId} className={it.blocking ? 'fail' : ''}>
            <div className="recovery-item">
              <span className="entry-name">
                {STATE_LABEL[it.state] ?? it.state}　·　{it.themeSummary || '（无主题摘要）'}
              </span>
              <span className="mono">{it.operationId}</span>
              <span className="mono">{formatDateTime(it.createdAt)}</span>
              <span className="scope">{it.advice}</span>
              <span className="mono">{it.targetPath}</span>
              <span className="recovery-actions">
                {it.actions.map((a) => (
                  <button
                    key={a}
                    className="btn small"
                    type="button"
                    disabled={busy}
                    onClick={() => onResolve(it.operationId, a)}
                  >
                    {ACTION_LABEL[a]}
                  </button>
                ))}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
