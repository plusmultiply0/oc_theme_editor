/**
 * 可读性检查面板（T25、T26；R4）。
 *
 * 显示逐条实测值与目标值，并明确写出采样方法与覆盖范围。
 * 单点合成只能算**估算**，所以：
 * - 不把结果叫「实际底色」，改叫「代表性底色（估算）」；
 * - 每个条目标出参与取最差的采样点数；
 * - 未做真实界面采样时不打勾，也不写「安全通过」。
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
  const sampled = report.entries.some((e) => e.estimated);

  return (
    <section className="panel">
      <h2>可读性检查</h2>
      <p className={report.passed ? 'pass' : 'fail'}>
        {report.passed ? '全部条目达到目标值（估算）' : `${failed.length} 项未达标`}
      </p>

      {effectiveBackground ? (
        <p className="scope">
          代表性底色（估算）
          <span className="swatch" style={{ background: effectiveBackground }} aria-hidden="true" />
          <code>{effectiveBackground}</code>
        </p>
      ) : null}

      <ul className="entries">
        {report.entries.map((e) => (
          <li key={`${e.element}-${e.state}`} className={e.pass ? 'pass' : 'fail'}>
            <span className="entry-name">
              {e.element}
              {e.state === 'default' ? '' : `（${e.state}）`}
            </span>
            <span className="mono">
              {e.ratio.toFixed(2)} / {e.required}
              {e.estimated ? ` · ${e.samples}点` : ''}
            </span>
          </li>
        ))}
      </ul>

      <p className="scope">范围：{report.scope}</p>
      <p className="scope">采样：{report.sampling}</p>
      <p className="scope">
        {sampled
          ? '底色由图片代表色逐点合成取最差得到，属保守估算；未做真实界面像素采样。'
          : '未做真实界面像素采样，因此不宣称「无障碍合规通过」。'}
        {report.verified ? '' : ' 本报告的 verified 恒为 false。'}
      </p>
    </section>
  );
}
