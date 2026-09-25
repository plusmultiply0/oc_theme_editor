# X3 封面（空会话首页）取证与定案（2026-09-25）

## 现象（jc 要求 3 口径）

封面（新会话首页，`newLayoutDesigns` 开）上「Build anything」大字标语和下方输入框
在壁纸上偏透、文字发虚。要求：两者降透明（更不透明），文字明显可读，且**不误伤会话内观感**。

## 取证方法

W1 同款：只读导出真机 1.18.32 asar 内官方渲染层 bundle
（`out/renderer/assets/main-Br7gF0DK.js` solid template + classList 原文、
`out/renderer/assets/main-C-FJvlHS.css`），静态检索封面相关 `data-component` 与类名，不猜。
（临时导出件在 `tools/tmp-x3-out/`，脚本一次性，用毕删除、不入库。）

## 结论一：封面标语 = `session.new.title`，无底色、无组件标识

- 文案：`"session.new.title": "Build anything"`（i18n 表原文）。
- 渲染位置：`NewSessionView`（封面专属组件，@main.js 4208810）。其根模板 `_tmpl$$1h`：
  `<div class="size-full flex flex-col">` → 居中块
  `<div class="flex-1 px-6 pb-30 flex items-center justify-center text-center">` →
  `<div class="w-full max-w-200 flex flex-col items-center text-center gap-4">` →
  `<div class="flex flex-col items-center gap-6"><div class="text-20-medium text-text-strong"></div></div>`。
- 标语本体就是 `class="text-20-medium text-text-strong"` 的空 div，`insert(..., language.t("session.new.title"))` 填字。
- **官方对该标语容器没有任何 background 规则**（main.css 检索 `text-20-medium` / 该层级无底色）；
  它直接坐在壁纸上（W1 已把 `session-prompt-dock` 置透，封面区本就没有面板底）。
- **标语链上没有任何 `data-component` / `data-*` 标识**，唯一稳定、且**只在封面出现**的锚点是
  类组合 `.text-20-medium.text-text-strong`（`.text-20-medium` 全仓仅此标语使用）。

## 结论二：封面输入框与会话内输入框是**同一组件树**，DOM 层无 cover/session 区分

- 封面与会话内的输入区都由 `SessionComposerRegion`（@4759591）渲染：
  根 `data-component="session-prompt-dock"`（模板 `_tmpl$5$q`）。
- 其内 `promptInput` 走 `Show when: newSessionDesign()`：真 → `PromptInputV2Composer`（@4661210，
  `borderUnderlay: true`）→ `PromptInputV2` → `data-component="prompt-input-v2"`；假 → `PromptInput`。
  即**封面用哪个组件，取决于 `newLayoutDesigns` 开关，与「是否有会话」无关**——
  开了新布局时封面与会话内的输入框是**完全相同的 `session-prompt-dock > prompt-input-v2`**。
- 全链路核对无任何 `data-new-session` / `data-context` / `data-empty` 之类的区分属性；
  最近的祖先 `SessionPanelFrame`（`bg-v2-background-bg-base rounded-[10px]`）与
  `SessionRouteFrame` 也只在封面/会话共享，类名不区分二者（`raised = !!params.id` 只加阴影）。
- 注入层核对：`prompt-input-v2` 与 `dock-prompt` 现在都在 `css.ts:170-186` 的共享半透明面板组里
  （`rgba(tokens.panel, panel)`）。**对该组直接加深会同时改掉会话内输入框观感**——违反 X3 边界。

## 定案（X3b 落地口径）

分两处、各自取最小可靠锚点，**不使用会被误伤的宽选择器**：

1. **标语可读性**：直接给 `.text-20-medium.text-text-strong`（及紧随的
   `.text-12-medium.text-text-weak` 目录/分支副行）加**文字描边/阴影**（暗底 + 亮底各一层
   `text-shadow`，随 mode 选主用），**不加底框**。
   - 理由：该类只出现在封面（取证坐实），天然「封面上下文限定」，零误伤；
     标语本就无底框，官方设计是浮在内容上——加 text-shadow 与官方观感同构，比凭空塞一块底色更稳。
2. **封面输入框降透明**：用 `:has()` 结构选择器把「含封面标语的那个 `session-prompt-dock`」
   从共享组里单独提出来加深（`alpha≈0.95`），**不改共享组本身**，会话内输入框不受影响：
   - 锚点：`#root [data-component="session-prompt-dock"]:has(.text-20-medium.text-text-strong) [data-component="prompt-input-v2"]`
     ——`:has()` 命中「同一 dock 子树内含封面标语」这一条件；Electron Chromium 全面支持 `:has()`。
   - 兜底评估：若真机上 `session-prompt-dock` 与 `NewSessionView` 非同一子树（标语是 dock 的**兄弟**
     而非后代），则 `:has()` 后代式失效，退化为在 `css.ts` 里对封面上下文**不加深**、
     仅保留 text-shadow 方案——此项**留待真机验证时由 jc 目测坐实**后再定，不预先猜写。
3. mock 预览：预览首页输入区 `.msg-row` 无标语块、输入框本就浮在壁纸上，text-shadow 方案在预览里
   以同构方式补一条标语 text-shadow；输入框加深因预览无独立封面态，仅在预览注释说明「封面输入框
   加深依赖真机 `:has()` 命中，预览不覆盖」。

## 验证层级

- 本机：typecheck/lint/unit（css 文本断言覆盖 text-shadow 规则输出）；
- 真机：`npm run build` 后 live-cli 应用本仓库构建，封面截图前后对比（标语可读、输入框不发虚、
  会话内输入框观感不变），截图留本目录；测后 restore previous 归位（本轮收尾执行）。
- 取证脚本与导出件为一次性产物，用毕即删，不入库。

---

# 追加取证节（X3c，2026-09-25 下午，静态只读）

触发：jc 把 X3 精确化为「新建会话页大字 opencode 标语与输入框：透明度**固定**、
不随面板不透明度滑杆变化、尽可能不透明」。本轮把官方 bundle **全部 836 个渲染层 js chunk**
逐一关键字扫描（此前 X3a 只查了主 bundle——这是漏判根因），定位真正的封面页代码。

## 更正：结论二只适用于旧布局，新布局封面是**另一条路由、另一个组件树**

- 主 bundle 的 `sessionPanelContent` 结构（`main-Br7gF0DK.js` @5588644 起）：
  Switch（有会话→MessageTimeline；无会话兜底→`NewSessionView`「Build anything」）
  之后是 `Show when: !!(params.id || !newSessionDesign()) && !mobileChanges()` 才渲染
  `SessionComposerRegion`（dock）。即**新布局下该 Show 恒 false**，dock 与「Build anything」
  根本不出现在新布局封面——X3a 结论二「封面与会话内是同一套 dock、无区分属性」
  只对**旧布局**封面成立，对新布局封面不成立。
- 新布局封面 = 懒加载 chunk `out/renderer/assets/new-session-zKhGmbH8.js`（57,632 B），
  导出 `NewSessionPage`（默认导出，独立路由页）。其内部**另有一个同名 `NewSessionView`**
  （@46954，与主 bundle 那个是不同函数），模板 `_tmpl$2`（@45.9k 附近）：
  `<div class="@container …"><div data-component="session-new-design" class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-deep">`
  → 绝对定位内容列 `top-[25.375%] … .mt-8 flex flex-col gap-8` 内依次：
  1. `WordmarkV2`（class `h-auto w-full text-v2-background-bg-inverse`）——**jc 说的「大字 opencode 标语」就是它**；
  2. `PromptInputV2Composer`（渲染 `form[data-component="prompt-input-v2"]`，主 bundle @4594576 模板，
     官方底 `bg-v2-background-bg-base`）——**封面输入框**，不经过 dock/SessionComposerRegion。
- **锚点唯一性（本轮坐实）**：`session-new-design` 在主 bundle 出现 **0 次**，仅存在于该 chunk；
  `wordmark` 组件在该 chunk 仅一个调用点。故
  `#root [data-component="session-new-design"] …` 是天然封面限定、零误伤会话内的选择器，
  **不需要 `:has()`，定案 2 的「留真机坐实结构」缺口就此闭合**。

## 大字标语发虚的真因：wordmark 是三层 opacity 连乘 + 底部渐隐 mask 的 SVG

`WordmarkV2` 模板（chunk `_tmpl$$3`）：`svg[viewBox=0 0 720 129] > g[opacity=0.6] > g[mask=url(#动态)] > g[opacity=0.16] > path×8[opacity=0.7, fill=currentColor]`；
mask 内容为 rect 填充线性渐变（`stop-opacity 0.7 → 0`，y=68→129 即下半截渐隐）。
合成后字母有效不透明度 ≈ 0.6×0.16×0.7 ≈ **6.7%**，且一半面积被 mask 拉到 0——官方本就把它画成
接近水印的淡字。`text-v2-background-bg-inverse` = `tokens.text`（tokens.ts:160），色本身是实色。
另注：`session-new-design` 容器类同时含 `bg-v2-background-bg-deep` 与 `flex-1`，
**恰好命中 F2 外壳透明规则**（`css.ts` `#root .bg-v2-background-bg-deep.flex-1`→transparent），
整张封面卡底下透出的就是壁纸本体。

## X3c 定案（固定值，不接 `panelAlpha(spec)`）

1. **封面输入框**：`#root [data-component="session-new-design"] [data-component="prompt-input-v2"]`
   （连同内层 `[data-component="prompt-input"]`，避免内外两层半透明叠色残留）→
   `background-color: tokens.panel`（**alpha=1 实色**，底色仍随 mode 推导）+ border 0.9 不变；
   特异性（#root+双属性）压过共享半透明组的 `!important` 同族规则，只命中封面树。
2. **大字标语**：`#root [data-component="session-new-design"] svg.h-auto.w-full` 下
   `g/path → opacity: 1`、`stop → stop-opacity: 1`（呈现属性低于任何作者层 CSS 规则，无需 `!important`）——
   即「固定 opacity=1 的实色文字」，**不塞衬底不加阴影**（改动最小档，色为 tokens.text 实色）。
3. **报告模型同步**：`surfaces.ts` 新增固定区域 `cover-input`（panelAlpha 写死 1，不读 spec）、
   `cover-wordmark`（图片+遮罩起算、无面板层）；`report.ts` 增「封面输入文字」「封面大字标语」
   两条目（前景 tokens.text）。单测钉死：调 `panelOpacity` 时这两条 ratio 不变、会话内「输入文字」照变。
4. **旧布局封面**（「Build anything」+dock）：**不做**固定加深——它与会话内同树、无区分属性，
   维持 X3b 现状（text-shadow）。jc 截图为新布局 wordmark 页，本轮要求已由 1–3 满足。
5. mock 预览：预览无封面路由，补一个「封面示意」小块——大字与输入行按同一固定值渲染
   （`tokens.panel` 实色 + `tokens.text` 实色），拖面板不透明度滑杆该块纹丝不动，与注入层同构。

验证层级照 PLAN：本机 typecheck/lint/unit；真机并入 #76 同一窗口
（封面两块清晰 + 滑杆脱钩 + 会话内输入框回归不变）。取证件用毕即删。
