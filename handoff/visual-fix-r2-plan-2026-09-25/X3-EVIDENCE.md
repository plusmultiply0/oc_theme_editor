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
