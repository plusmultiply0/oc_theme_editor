/**
 * 恢复面板（T55）。
 *
 * 「原版」与「上一主题」是两个不同的语义，必须分开陈列：
 * 原版不可确认时直接禁用并说明原因，不能把一份改过的状态冒充出厂原版。
 */
import type { BackupInfo } from '../../shared/ipc';
import { formatBytes, formatDateTime } from '../logic';

export interface RestorePanelProps {
  backups: BackupInfo[];
  busy: boolean;
  onRestore: (kind: 'original' | 'previous') => void;
  onRefresh: () => void;
}

export default function RestorePanel({ backups, busy, onRestore, onRefresh }: RestorePanelProps) {
  const original = backups.find((b) => b.kind === 'original');
  const previous = backups.find((b) => b.kind === 'previous');

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>恢复</h2>
        <button className="btn small" type="button" onClick={onRefresh} disabled={busy}>
          刷新
        </button>
      </div>

      <div className="backup">
        <div className="backup-head">
          <span className="tag">上一主题</span>
          {previous ? (
            <span className="muted">{formatDateTime(previous.createdAt)}</span>
          ) : null}
        </div>
        {previous ? (
          <>
            <p className="scope">适用版本 {previous.applicableVersion}　·　{formatBytes(previous.sizeBytes)}</p>
            <button className="btn" type="button" disabled={busy} onClick={() => onRestore('previous')}>
              恢复上一主题
            </button>
          </>
        ) : (
          <p className="muted">还没有可回退的上一主题；应用一次之后才会出现。</p>
        )}
      </div>

      <div className="backup">
        <div className="backup-head">
          <span className="tag">原版</span>
          {original ? (
            <span className="muted">{formatDateTime(original.createdAt)}</span>
          ) : null}
        </div>
        {original ? (
          <>
            <p className="scope">适用版本 {original.applicableVersion}　·　{formatBytes(original.sizeBytes)}</p>
            {original.pristine ? (
              <button className="btn" type="button" disabled={busy} onClick={() => onRestore('original')}>
                恢复原版
              </button>
            ) : (
              <>
                <button className="btn" type="button" disabled>
                  恢复原版
                </button>
                <p className="warn-line">{original.themeSummary}</p>
              </>
            )}
          </>
        ) : (
          <p className="muted">尚未接管过该安装，没有原版备份。</p>
        )}
      </div>
    </section>
  );
}
