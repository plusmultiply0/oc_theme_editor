/**
 * 恢复面板（T55；R2）。
 *
 * 三个入口语义不同，必须分开陈列：
 * - 「上一主题」：应用前的状态
 * - 「原版」：**只在有出厂指纹证据时**出现；没有证据就不给这个按钮
 * - 「首次接管快照」：无法证明是原版时的诚实入口，明确写出它不是出厂界面
 *
 * 早先的缺陷：只检查「本工具的注入条目在不在」，不在就标成原版，
 * 于是真机上那份被原型改过的安装被当成原版，「恢复原版」实际恢复的是旧定制。
 */
import type { BackupInfo } from '../../shared/ipc';
import { formatBytes, formatDateTime } from '../logic';

const HEALTH_LABEL: Record<string, string> = {
  'known-healthy': '已通过完整性检查',
  unverified: '尚未检查',
  'known-bad': '已损坏，不可用于恢复',
};

function HealthLine({ backup }: { backup: BackupInfo }): React.ReactNode | null {
  if (!backup.health) return null;
  return (
    <p className={backup.health === 'known-bad' ? 'warn-line' : 'scope'}>
      健康状态：{HEALTH_LABEL[backup.health] ?? backup.health}
    </p>
  );
}

export interface RestorePanelProps {
  backups: BackupInfo[];
  busy: boolean;
  onRestore: (kind: 'original' | 'previous' | 'takeover') => void;
  onRefresh: () => void;
}

export default function RestorePanel({ backups, busy, onRestore, onRefresh }: RestorePanelProps) {
  const original = backups.find((b) => b.kind === 'original');
  const takeover = backups.find((b) => b.kind === 'takeover');
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
          {previous ? <span className="muted">{formatDateTime(previous.createdAt)}</span> : null}
        </div>
        {previous ? (
          previous.health === 'known-bad' ? (
            <>
              <p className="scope">适用版本 {previous.applicableVersion}　·　{formatBytes(previous.sizeBytes)}</p>
              <p className="warn-line">
                这份备份已损坏（{previous.themeSummary}），不能用它恢复 ——
                恢复它只会把坏状态再写一遍。
              </p>
            </>
          ) : (
            <>
              <p className="scope">适用版本 {previous.applicableVersion}　·　{formatBytes(previous.sizeBytes)}</p>
              <HealthLine backup={previous} />
              <button className="btn" type="button" disabled={busy} onClick={() => onRestore('previous')}>
                恢复上一主题
              </button>
            </>
          )
        ) : (
          <p className="muted">还没有可回退的上一主题；应用一次之后才会出现。</p>
        )}
      </div>

      <div className="backup">
        <div className="backup-head">
          <span className="tag">原版</span>
          {original ? <span className="muted">{formatDateTime(original.createdAt)}</span> : null}
        </div>
        {original ? (
          original.health === 'known-bad' ? (
            <>
              <p className="scope">适用版本 {original.applicableVersion}　·　{formatBytes(original.sizeBytes)}</p>
              <p className="warn-line">这份备份已损坏，不能用于恢复。</p>
            </>
          ) : (
            <>
              <p className="scope">适用版本 {original.applicableVersion}　·　{formatBytes(original.sizeBytes)}</p>
              <HealthLine backup={original} />
              <button className="btn" type="button" disabled={busy} onClick={() => onRestore('original')}>
                恢复原版
              </button>
              <p className="scope">{original.evidenceNote}</p>
            </>
          )
        ) : (
          <>
            <p className="warn-line">没有可证明的出厂原版 —— 用首次接管快照。</p>
            <details className="scan-details">
              <summary>说明</summary>
              <p className="warn-line">
                本工具没有登记过该版本的出厂指纹，因此不提供「恢复原版」入口。
                可用的诚实入口见下面的「首次接管快照」。
              </p>
            </details>
          </>
        )}
      </div>

      <div className="backup">
        <div className="backup-head">
          <span className="tag">首次接管快照</span>
          {takeover ? <span className="muted">{formatDateTime(takeover.createdAt)}</span> : null}
        </div>
        {takeover ? (
          takeover.health === 'known-bad' ? (
            <>
              <p className="scope">适用版本 {takeover.applicableVersion}　·　{formatBytes(takeover.sizeBytes)}</p>
              <p className="warn-line">这份快照已损坏，不能用于恢复。</p>
            </>
          ) : (
            <>
              <p className="scope">适用版本 {takeover.applicableVersion}　·　{formatBytes(takeover.sizeBytes)}</p>
              <HealthLine backup={takeover} />
              <button className="btn" type="button" disabled={busy} onClick={() => onRestore('takeover')}>
                恢复到首次接管时
              </button>
              <p className="warn-line">此快照是本工具首次接管时的磁盘状态，不是出厂界面。</p>
              <details className="scan-details">
                <summary>说明</summary>
                <p className="warn-line">{takeover.evidenceNote}</p>
              </details>
            </>
          )
        ) : (
          <p className="muted">尚未接管过该安装，没有快照。</p>
        )}
      </div>
    </section>
  );
}
