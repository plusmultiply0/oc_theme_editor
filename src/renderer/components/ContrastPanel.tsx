/**
 * 可读性检查面板（T25、T26）。
 *
 * 显示逐条实测值与目标值，并明确写出采样方法与覆盖范围；
 * 未做真实界面采样时不打勾，也不写「安全通过」。
 */
import type { ContrastReport } from '../../shared/schema';

export interface ContrastPanelProps {
  report: ContrastReport | null;
  effectiveBackground: string | null;
}

export default function ContrastPanel({ report, effectiveBackground }: ContrastPanelProps) {
  if (!report) {
    return (
      <section className="panel">
        <h2>可读性检查</h2>
        <p className="muted">生成配色后显示逐条对比度结果。</p>
      </section>
    );
  }

  const failed = report.entries.filter((e) => !e.pass);

  return (
    <section className="panel">
      <h2>可读性检查</h2>
      <p className={report.passed ? 'pass' : 'fail'}>
        {report.passed ? '全部达到目标值' : `${failed.length} 项未达标`}
      </p>

      {effectiveBackground ? (
        <p className="scope">
          实际底色（三层合成）
          <span className="swatch" style={{ background: effectiveBackground }} aria-hidden="true" />
          <code>{effectiveBackground}</code>
        </p>
      ) : null}

      <ul className="entries">
        {report.entries.map((e) => (
          <li key={e.element} className={e.pass ? 'pass' : 'fail'}>
            <span className="entry-name">{e.element}</span>
            <span className="mono">
              {e.ratio.toFixed(2)} / {e.required}
            </span>
          </li>
        ))}
      </ul>

      <p className="scope">范围：{report.scope}</p>
      <p className="scope">采样：{report.sampling}</p>
      <p className="scope">
        {report.verified
          ? '已做真实界面采样校验。'
          : '未做真实界面像素采样，因此不宣称「无障碍合规通过」。'}
      </p>
    </section>
  );
}
