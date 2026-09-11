/**
 * 模拟预览（T53）。
 *
 * 用的是与写入归档完全相同的 token 与参数：这里显示的主色就是会被写进去的主色，
 * 避免了「预览好看、应用变样」。
 * 场景覆盖长文本、代码、链接、输入 placeholder、弹出菜单、选中/焦点/悬停/按下、
 * 错误与 diff；终端与语法高亮明确标注不在覆盖范围内（T27）。
 */
import type { ThemeSpec, ThemeTokens } from '../../shared/schema';

export interface PreviewProps {
  tokens: ThemeTokens;
  imageUrl: string | null;
  spec: ThemeSpec;
  /** 系统开启「减少透明度」时，面板退化为不透明纯色（T56） */
  reducedTransparency: boolean;
}

function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export default function Preview({ tokens, imageUrl, spec, reducedTransparency }: PreviewProps) {
  const panelOpacity = reducedTransparency ? 1 : spec.panelOpacity;
  const panel = alpha(tokens.panel, panelOpacity);
  const surface = alpha(tokens.panel, reducedTransparency ? 1 : panelOpacity - 0.06);

  const vars: Record<string, string> = {
    '--p-bg-image': imageUrl ? `url("${imageUrl}")` : 'none',
    '--p-overlay': alpha(tokens.background, spec.overlayOpacity),
    '--p-blur': spec.blurPx > 0 ? `blur(${spec.blurPx}px)` : 'none',
    '--p-background': tokens.background,
    '--p-panel': panel,
    '--p-surface': surface,
    '--p-text': tokens.text,
    '--p-muted': tokens.muted,
    '--p-primary': tokens.primary,
    '--p-on-primary': tokens.onPrimary,
    '--p-hover': tokens.hover,
    '--p-pressed': tokens.pressed,
    '--p-border': tokens.border,
    '--p-focus': tokens.focus,
    '--p-selection': tokens.selection,
    '--p-error': tokens.status.error,
    '--p-warning': tokens.status.warning,
    '--p-success': tokens.status.success,
    '--p-diff-add': tokens.diff.added,
    '--p-diff-del': tokens.diff.removed,
  };

  return (
    <div className="preview">
      <div className="preview-note">模拟预览，真实效果取决于已验证版本</div>
      <div className="mock-window" style={vars as React.CSSProperties}>
        <div className="mock-bg" aria-hidden="true" />
        <div className="mock-body">
          <aside className="mock-sidebar">
            <div className="mock-brand">会话</div>
            <div className="mock-item active">重构取色模块</div>
            <div className="mock-item">数据清洗脚本</div>
            <div className="mock-item">论文第三章</div>
            <div className="mock-item muted">设置</div>
          </aside>

          <div className="mock-main">
            <div className="msg user">帮我把这段取色逻辑改成确定性的，不要再用随机种子。</div>

            <div className="msg bot">
              <p>
                可以。当前的 k-means 用了随机初始中心，同一张图两次跑出来的代表色会不一样，
                导致主题无法复现。改成按量化后的频次排序取前 N 个，就能保证同输入同输出。
                下面是关键改动，注意合并阈值决定了色板会不会过碎：
              </p>
              <pre className="code">
                <code>{`function extractPalette(data, channels, opts) {
  const counts = new Map();
  for (let i = 0; i < data.length; i += channels) {
    const key = quantize(data[i], data[i + 1], data[i + 2], opts.bits);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.count)
    .map(([key]) => fromKey(key));
}`}</code>
              </pre>
              <p className="muted">
                完整讨论见
                <a
                  className="link"
                  href="https://www.w3.org/TR/WCAG21/#contrast-minimum"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.themeSwitcher.openExternal(e.currentTarget.href);
                  }}
                >
                  对比度标准
                </a>
                ，本工具只保证 token 级的可读性。
              </p>
            </div>

            <div className="mock-menu" role="menu" aria-label="示例弹出菜单">
              <div className="mock-menu-item">复制到剪贴板</div>
              <div className="mock-menu-item hover">重新生成</div>
              <div className="mock-menu-item muted">删除（不可用）</div>
            </div>

            <div className="msg-row">
              <input className="input" placeholder="输入消息，或拖入图片…" readOnly aria-label="输入框示例" />
              <button className="btn primary" type="button">发送</button>
            </div>

            <div className="states">
              <button className="btn" type="button">默认</button>
              <button className="btn hover" type="button">悬停</button>
              <button className="btn pressed" type="button">按下</button>
              <button className="btn focus" type="button">焦点</button>
              <button className="btn" type="button" disabled>禁用</button>
            </div>

            <div className="feedback">
              <span className="err">错误：无法连接模型服务</span>
              <span className="warn">警告：未找到配置文件</span>
              <span className="ok">成功：主题已保存</span>
            </div>

            <div className="diff">
              <div className="add">+ 按频次排序，去掉随机初始中心</div>
              <div className="del">- k-means(random_state=42)</div>
              <div className="ctx">  共 12 处改动</div>
            </div>

            <div className="terminal">
              <div className="terminal-head">终端（配色不在本工具覆盖范围内）</div>
              <pre className="terminal-body">{`$ npm run test:unit\n  ✓ 主题生成（29）\n  ✓ 路径安全（18）`}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
