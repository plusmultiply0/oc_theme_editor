/**
 * 可读性检查面板（T25、T26；R4；U-重整 T3 概要化；X2 面板级折叠）。
 *
 * 面板整体收成一行结论条（X2）：标题 + 结论 + 余量最差一项；
 * 点击结论条展开整卡——代表性底色、28 行明细与范围/采样/verified 三段
 * 长说明的既有结构原样保留在内，折叠只影响初始显示，不吞掉任何信息。
 * 默认态按结论定：未达标默认展开（问题必须被看到），全达标默认收起。
 * 单点合成只能算**估算**，所以：
 * - 不把结果叫「实际底色」，改叫「代表性底色（估算）」；
 * - 每个条目标出参与取最差的采样点数；
 * - 未做真实界面采样时不打勾，也不写「安全通过」。
 */
import { useEffect, useState } from 'react';
import type { ContrastReport } from '../../shared/schema';

export interface ContrastPanelProps {
  report: ContrastReport | null;
  effectiveBackground: string | null;
}

function entryLabel(e: ContrastReport['entries'][number]): string {
  return `${e.element}${e.state === 'default' ? '' : `（${e.state}）`}`;
}

/** X2 默认态口径：未达标展开、全达标收起（e2e 与说明共用同一判定） */
export function contrastPanelDefaultOpen(report: ContrastReport): boolean {
  return !report.passed;
}

export default function ContrastPanel({ report, effectiveBackground }: ContrastPanelProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (report) setOpen(contrastPanelDefaultOpen(report));
  }, [report]);

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
  // 余量最差的一项：实测值相对目标值的比最低
  const worst = report.entries.reduce((a, b) => (b.ratio / b.required < a.ratio / a.required ? b : a));

  return (
    <details className="panel panel-collapse" open={open}>
      <summary>
        <h2>可读性检查</h2>
        <span className={`conclusion ${report.passed ? 'pass' : 'fail'}`}>
          {report.passed ? '✓ 全部条目达标（估算）' : `✗ ${failed.length} 项未达标`}
        </span>
        <span className="worst mono">
          最差 {entryLabel(worst)} {worst.ratio.toFixed(2)}/{worst.required}
        </span>
      </summary>

      {effectiveBackground ? (
        <p className="scope">
          代表性底色（估算）
          <span className="swatch" style={{ background: effectiveBackground }} aria-hidden="true" />
          <code>{effectiveBackground}</code>
        </p>
      ) : null}

      <p className="scope">
        余量最差：<span className="entry-name">{entryLabel(worst)}</span>{' '}
        <span className="mono">
          {worst.ratio.toFixed(2)} / {worst.required}
        </span>
      </p>

      <details className="scan-details">
        <summary>明细与判定依据（{report.entries.length} 项）</summary>
        <ul className="entries">
          {report.entries.map((e) => (
            <li key={`${e.element}-${e.state}`} className={e.pass ? 'pass' : 'fail'}>
              <span className="entry-name">{entryLabel(e)}</span>
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
      </details>
    </details>
  );
}
