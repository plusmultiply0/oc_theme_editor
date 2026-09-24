# F4a 取证：真实注入 CSS vs mock 预览逐项差异清单

取证日期：2026-09-24。
两侧来源：

- **真实侧**：`src/core/theme/css.ts`（renderThemeCss 注入模板）+ `src/core/theme/tokens.ts`
  （html:root token 声明）——即写进归档的那一份。
- **预览侧**：`src/renderer/components/Preview.tsx`（`--p-*` 变量）+ `src/renderer/styles.css`
  `.mock-*` / `.msg` / `.code` / `.input` / `.states` / `.diff` / `.terminal` 段。

结论分四类：**同构**（已对上，不动）、**修**（F4b 按本清单修 mock）、**核**（注入层不决定，
取决于官方组件样式，需真机截图核对后才能定）、**限**（预览容器尺寸带来的固有近似，不修）。

---

## 1. 背景三层模型（PLAN 点名的重点）

| # | 项 | 真实侧 | 预览侧 | 结论 |
|---|----|--------|--------|------|
| 1.1 | 实底色底层 | `html, body { background-color: tokens.background }` | `.mock-window` 无任何实底背景，无图时透出工具界面白底 | **修**：`.mock-window` 补 `background: var(--p-background)`（`--p-background` 已传而未用） |
| 1.2 | 层叠顺序 | `#root` isolation:isolate；图片 `::before` z-index -2 → 遮罩 `::after` z -1 → 内容在上 | `.mock-window` isolation:isolate；`.mock-bg-image` -2 → `.mock-overlay` -1 → `.mock-body` z 1 | **同构** |
| 1.3 | 遮罩叠加位置 | 遮罩独立整层，压在图片**之上**，颜色 rgba(tokens.background, overlayAlpha=spec.overlayOpacity) | `.mock-overlay` inset:0，`--p-overlay` = 同色同 alpha | **同构** |
| 1.4 | 模糊 inset | blur>0 时图片层 `inset: -2·blur px` | `--p-blur-inset` = `-blurPx*2 px` | **同构** |
| 1.5 | 背景图 cover | `background-size: cover; position: center; no-repeat` | 同三条 | **同构**；但 cover 以预览小窗为基准裁切，与真机视口 crop 范围不同——**限** |

## 2. 面板与容器

| # | 项 | 真实侧 | 预览侧 | 结论 |
|---|----|--------|--------|------|
| 2.1 | 主面板/侧栏底色 | `--background-base`/`--v2-background-bg-base` = rgba(panel, panelAlpha) | `.mock-sidebar`/`.mock-main` = `--p-panel` 同值 | **同构** |
| 2.2 | 助手气泡底色 | `[data-slot="session-turn-assistant-content"]` rgba(panel, bubbleLayer=p) | `.msg` `--p-bubble` 同值 | **同构** |
| 2.3 | 气泡边框 | 注入层**不加** border；有无/粗细由官方组件决定 | `.msg` 一律 `1px solid var(--p-border)`（不透明 hex） | **核**：真机截图确认官方气泡是否有边框；F4b 先把预览边框改为与注入弹窗同口径的 rgba(border,0.9)，实无框则删 |
| 2.4 | 用户气泡 | `[data-slot="user-message-text"]` rgba(selection, 0.9) + text 色 | `.msg.user` `--p-user-bubble` 同值，但继承 2.3 边框 | **同构**（色）；边框随 2.3 |
| 2.5 | 弹窗/菜单边框色 | `border-color: rgba(tokens.border, 0.9) !important` | `.mock-menu`/`.input`/`.code`/`.diff` 均 `1px solid var(--p-border)`（alpha=1） | **修**：预览边框统一 `rgba(border, 0.9)`（新增 `--p-border-soft` 变量，值与注入层同一表达式） |
| 2.6 | 代码块底色 | `[data-component="markdown-code"], [data-component="code"]` rgba(panel, p)，注入层不加 border | `.code` = `--p-panel` + 自加边框 | 底色**同构**；边框随 2.5/2.3 口径 |
| 2.7 | 面板圆角 | 注入层不覆盖圆角（官方组件各值） | `.mock-*` 固定 4/6px | **核**：以真机截图量出的官方圆角为准对齐，清单先登记为待测 |
| 2.8 | 面板阴影 | 注入层完全不写 box-shadow；官方弹层自带阴影 | `.mock-*` 无阴影 | **核**：真机菜单/对话框如带阴影，预览补同值；注入层不动 |
| 2.9 | 外壳层 | `.bg-v2-background-bg-deep.flex-1` 强制 transparent（事故 F2）；`--v2-background-bg-deep`=rgba(background,0.6) 仍被其他元素用 | 无对应场景，直接铺 panel | **限**：mock 是布局示意，外壳清空机制无法也不需要复刻；不影响三层模型 |

## 3. 控件状态

| # | 项 | 真实侧 | 预览侧 | 结论 |
|---|----|--------|--------|------|
| 3.1 | 主按钮 default/hover/pressed | tokens.primary / hover / pressed 实底，onPrimary 文字 | `.states .btn.primary` 三态同值 | **同构** |
| 3.2 | 焦点环 | `outline: 2px solid focus; outline-offset: 1px` | `.states .btn.primary.focus` offset **2px** | **修**：预览改 1px |
| 3.3 | 主按钮 disabled | 底色 rgba(text,0.06)、边框 rgba(border,0.5)、文字 muted——**元素不整体淡化** | `.states .btn:disabled { opacity: 0.55 }`（整块淡化，文字仍是 onPrimary 透出来） | **修**：预览 primary disabled 改与注入同表达式（bg/border/color 三值）；非 primary 的 disabled 官方未覆盖，保留淡化示意并注明 |
| 3.4 | 次级按钮底色 | `--v2-background-bg-button-neutral` rgba(text, 0.06) | `.btn.neutral` `--p-neutral-surface` 同值 | **同构** |
| 3.5 | 菜单项悬停 | surface/overlay-hover rgba(hover, 0.12) | `.mock-menu-item.hover` 同值 | **同构** |
| 3.6 | 侧栏选中项 | 注入层不直接命中；官方可能用 `--v2-overlay-simple-tab-active-scrim` = rgba(**primary**, 0.16) | `--p-selected-overlay` = rgba(**selection**, 0.16)（报告 regionsFor 'sidebar-selected' 亦按 selection 计） | **核**：三处（官方变量/报告区域模型/预览）两处用 selection、变量表有 primary 版 scrim；真机截图确认实际用哪个后统一，动报告需另评估 |
| 3.7 | ::selection 文本选区 | rgba(selection, 0.9) + text 色 | 无展示场景 | **限**：静态 mock 不演示选区交互，可接受 |

## 4. 文字与占位

| # | 项 | 真实侧 | 预览侧 | 结论 |
|---|----|--------|--------|------|
| 4.1 | placeholder | `color-mix(in oklab, currentcolor 50%, muted)` | `.input::placeholder` 同表达式同色 | **同构**（P2 轮已对齐） |
| 4.2 | 链接 | `--text-interactive-base`/`--v2-text-text-accent` = accentText | `.link` `--p-accent-text` | **同构** |
| 4.3 | 状态色文字 | `--v2-state-fg-*` 直取 tokens.status | `.feedback .err/.warn/.ok` 同值 | **同构** |
| 4.4 | diff 行 | 文字 `--text-diff-*`；行底 `--surface-diff-add/delete-base` = rgba(diff, **0.16**) | `.diff .add/.del` 只有文字色，行无底色；`.diff` 容器底 = `--p-panel` | **修**：预览 `.add`/`.del` 补 rgba(diff, 0.16) 行底（与 tokens.ts 同一 alpha 常量语义，预览侧用变量传值） |
| 4.5 | 终端 | 明确不覆盖（T27） | `.terminal` 虚线框 + 注明不覆盖 | **同构**（口径一致） |

## 5. F4b 施工范围（按上表归拢）

必修（不依赖真机截图）：
1. `.mock-window` 补实底 `var(--p-background)`（1.1）；
2. 预览侧新增 `--p-border-soft`（rgba(border, 0.9)，Preview.tsx 用与注入层相同表达式出值），`.mock-menu`/`.input`/`.code`/`.diff` 边框改用它（2.5，`.msg` 随 2.3）；
3. 焦点环 offset 2px → 1px（3.2）；
4. primary disabled 三值改同表达式（3.3）；
5. `.diff .add/.del` 补 0.16 行底（4.4）。

真机截图核对后再定（**核** 组，见 §8 走查表）：气泡有无边框（2.3）、官方圆角值（2.7）、弹层阴影（2.8）、侧栏选中 scrim 用色（3.6）。

不变量（红线）：以上只动 `.mock-*`/Preview 的**外观表达**；token 值与三层 alpha 一律继续取
core/surfaces 同一函数（panelAlpha/bubbleLayerAlpha/overlayAlpha/REGION_ALPHAS），
不得为贴近截图硬写色值偏离生成层。

## 6. 验收方式（PLAN 指定）

同一张图：真实应用后 OpenCode 截图 vs 工具内预览截图并排对比；
截图存临时目录，不入库。本清单 + F4b 修复各自成提交。
