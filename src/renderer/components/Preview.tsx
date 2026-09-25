/**
 * 模拟预览（T53；R4、R5）。
 *
 * 这里显示的 token、层级与不透明度**就是会被写进归档的那一份**，
 * 面板/气泡的不透明度直接取自 core/theme/surfaces 的同一组函数，
 * 避免「预览好看、应用变样」。
 *
 * 背景结构与实际输出保持一致：图片层（可模糊）+ 遮罩层（叠在图片之上）。
 * 场景覆盖长文本、代码、链接、输入 placeholder、弹出菜单、选中/悬停/按下/焦点、
 * 错误与 diff；终端与语法高亮明确标注不在覆盖范围内（T27）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ThemeSpec, ThemeTokens } from '../../shared/schema';
import { bubbleLayerAlpha, panelAlpha, REGION_ALPHAS } from '../../core/theme/surfaces';
import { menuSurfaceColor } from '../../core/theme/css';
import { mockBlurPx } from '../logic';

export interface PreviewProps {
  tokens: ThemeTokens;
  imageUrl: string | null;
  spec: ThemeSpec;
  resolvedMode: 'light' | 'dark';
}

function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export default function Preview({ tokens, imageUrl, spec, resolvedMode }: PreviewProps) {
  // 与写入归档、对比度报告共用同一套层级函数
  const panel = alpha(tokens.panel, panelAlpha(spec));
  // .msg 画在已经有 p 的 .mock-main 之上，所以这一层只画局部 p；
  // 累计效果（1-(1-p)²）是报告的事，不能拿来当局部 alpha
  const bubble = alpha(tokens.panel, bubbleLayerAlpha(spec));
  // 菜单/弹层不透明深色面：与注入层同一函数（X1），预览与真机同构
  const menu = menuSurfaceColor(tokens, resolvedMode);

  // W5：mock 容器远小于真机窗口，同 px 模糊在 mock 里相对更糊，按容器宽折算。
  // 已知残余差距（缩比渲染的物理极限，不硬凑）：
  //  - 底图是 512/320 缩略图（image-store previewDataUrl），比真机全分辨率壁纸软；
  //  - cover 以中心裁切，mock 宽高比与真机窗口不同，看到的不是同一块画面（F4-DIFF §1.5）。
  const windowRef = useRef<HTMLDivElement>(null);
  const [mockWidth, setMockWidth] = useState(0);
  useEffect(() => {
    const el = windowRef.current;
    if (!el) return;
    setMockWidth(el.offsetWidth);
    const ro = new ResizeObserver(() => setMockWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const effBlur = mockBlurPx(spec.blurPx, mockWidth);

  const vars: Record<string, string> = {
    '--p-bg-image': imageUrl ? `url("${imageUrl}")` : 'none',
    '--p-overlay': alpha(tokens.background, spec.overlayOpacity),
    '--p-blur': effBlur > 0 ? `blur(${effBlur}px)` : 'none',
    '--p-blur-inset': effBlur > 0 ? `-${effBlur * 2}px` : '0',
    '--p-background': tokens.background,
    // 面板与侧栏同层：早先侧栏用 panelOpacity-0.06，报告按 panelOpacity 算，两边对不上
    '--p-panel': panel,
    // 菜单/弹层的不透明深色面与兜底文字（X1）
    '--p-menu-bg': menu.bg,
    '--p-menu-text': menu.text,
    // 封面（新建会话页）固定不透明两处（X3c）：实色值，不接 panelAlpha——
    // 与 css.ts 封面规则同一口径，拖面板不透明度滑杆这两块不变
    '--p-cover-input-bg': tokens.panel,
    '--p-cover-text': tokens.text,
    '--p-bubble': bubble,
    '--p-neutral-surface': alpha(tokens.text, REGION_ALPHAS.neutral),
    '--p-hover-overlay': alpha(tokens.hover, REGION_ALPHAS.hover),
    '--p-pressed-overlay': alpha(tokens.pressed, REGION_ALPHAS.pressed),
    '--p-user-bubble': alpha(tokens.selection, REGION_ALPHAS.userBubble),
    '--p-text': tokens.text,
    '--p-muted': tokens.muted,
    '--p-primary': tokens.primary,
    '--p-accent-text': tokens.accentText,
    '--p-on-primary': tokens.onPrimary,
    '--p-hover': tokens.hover,
    '--p-pressed': tokens.pressed,
    '--p-border': tokens.border,
    // 与注入层弹窗/菜单同一表达式（tokens.ts --border-base：border 色 0.9 叠加），F4a §2.5
    '--p-border-soft': alpha(tokens.border, 0.9),
    // 主按钮禁用边框与 css.ts button[variant=primary]:disabled 同一表达式（border 色 0.5），F4a §3.3
    '--p-border-disabled': alpha(tokens.border, 0.5),
    '--p-focus': tokens.focus,
    '--p-selection': tokens.selection,
    '--p-error': tokens.status.error,
    '--p-warning': tokens.status.warning,
    '--p-success': tokens.status.success,
    '--p-diff-add': tokens.diff.added,
    '--p-diff-del': tokens.diff.removed,
    // diff 行底与 tokens.ts --surface-diff-add/delete-base 同色同 alpha（0.16），F4a §4.4
    '--p-diff-add-surface': alpha(tokens.diff.added, 0.16),
    '--p-diff-del-surface': alpha(tokens.diff.removed, 0.16),
  };

  return (
    <div className="preview">
      <div className="preview-note">模拟预览：与写入归档使用同一份 token 与不透明度参数</div>
      <div ref={windowRef} className="mock-window" style={vars as React.CSSProperties}>
        {/* 图片层与遮罩层分开：模糊只作用于图片，遮罩叠在图片之上 */}
        <div className="mock-bg-image" aria-hidden="true" />
        <div className="mock-overlay" aria-hidden="true" />

        <div className="mock-body">
          {/* 预览主体模拟「会话内」视图；封面（新建会话页）单独在下方「封面示意」块
              按固定不透明值演示（X3c）。旧布局封面的标语 text-shadow 只在真机生效，
              预览无该封面态、不覆盖（差异口径见 X3-EVIDENCE.md）。 */}
          <aside className="mock-sidebar">
            <div className="mock-brand">会话</div>
            <div className="mock-item active">重构取色模块</div>
            <div className="mock-item">数据清洗脚本</div>
            <div className="mock-item">论文第三章</div>
            <div className="mock-item">设置</div>
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
              <div className="mock-menu-item disabled">删除（不可用）</div>
            </div>

            <div className="msg-row">
              <input className="input" placeholder="输入消息，或拖入图片…" readOnly aria-label="输入框示例" />
              <button className="btn primary" type="button">发送</button>
            </div>

            <div className="states">
              <button className="btn primary" type="button">默认</button>
              <button className="btn primary hover" type="button">悬停</button>
              <button className="btn primary pressed" type="button">按下</button>
              <button className="btn primary focus" type="button">焦点</button>
              <button className="btn neutral" type="button">次级</button>
              {/* 注入层只覆盖 primary 的禁用三值，预览演示的就是这条被覆盖的路径（F4a §3.3） */}
              <button className="btn primary" type="button" disabled>禁用</button>
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

            <div className="cover-mock">
              <div className="cover-head">封面（新建会话页）示意：大字与输入框为固定实色，不随面板不透明度滑杆变化</div>
              <div className="cover-wordmark" aria-hidden="true">
                opencode
              </div>
              <div className="cover-input">输入消息，或拖入图片…</div>
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
