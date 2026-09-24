# W1 输入框白条取证与定案（2026-09-24）

## 现象（jc 图 1 口径）

聊天输入区有一条横贯窗口的浅色底带，输入框本体窄于它，两侧露出「白条」。

## 取证（真机 1.18.32，只读 + 本机截图）

真机当前为 alpha.7 应用态（asar 内 `out/renderer/oc-theme-custom.css` 11937 字节，
与 afdd5dc 构建一致），拉起 OpenCode 后底部输入区现象复现。

1. **官方主 CSS 静态核对**（`out/renderer/assets/main-C-FJvlHS.css` 导出检索）：
   - 官方对 `[data-component="prompt-input-v2"]` 本体**没有任何** background 规则，
     `prompt-input` 一词只出现在 attachments 动画（4 处）；输入框底色全部由 Tailwind 工具类承担。
2. **官方 DOM 结构**（`out/renderer/assets/main-Br7gF0DK.js`，solid template + classList 原文）：
   - 输入区根：`<div data-component=session-prompt-dock>`（SessionComposerRegion `_tmpl$5$q`），
     classList 动态挂：
     - `w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none`（恒定）
     - `bg-v2-background-bg-base`（newLayoutDesigns 开）或 `bg-background-stronger`（旧布局）——**全宽实底色带就是它**；
   - 其内列容器：`w-full px-3` + 居中时 `md:max-w-200 md:mx-auto 2xl:max-w-[1000px]`——**输入列比 dock 窄**；
   - 再内：`<form data-component=prompt-input-v2 class="group/prompt-input relative min-h-[96px] w-full overflow-clip rounded-xl bg-v2-background-bg-base">`。
3. **注入层核对**（临时导出 `oc-theme-custom.css`）：
   - `--v2-background-bg-base` / `--background-stronger` 均已是半透明面板色，
     `[data-component="prompt-input-v2"]` 另有 `!important` 面板底——**颜色本身没有错配**；
   - dock 容器未被任何规则处理，其半透明面板色在壁纸上形成横贯浅色带，
     圆角输入框窄于它时两侧露出，观感即「白条」。

## 定案

计划二选一取 **(b) 外层容器背景改透明**：

- `#root [data-component="session-prompt-dock"] { background-color: transparent; }`
- 理由：mock 预览的输入区（`.msg-row`）本就没有底色横带、输入框浮在壁纸上，
  (b) 使真机回到「预览=注入」同构；(a) 全宽化会改掉官方的居中限宽排版，改动面更大。
- 特异性：非分层规则压过官方 @layer 工具类（同 F2 外壳先例），不需要 `!important`；
  一条属性选择器同时覆盖新旧两种布局变体。
- 边界遵守：只动输入区这一条规则；token 与 alpha 同源不动；dock 内的
  question/permission/todo 子面板各有自己的底色，不受影响。

## 验证层级

- 本机：typecheck/lint/unit（css 快照类断言若有则更新）；
- 真机：`npm run build` 后 live-cli 应用本仓库构建，截图确认白条消失（本目录留档），
  预览侧 capture-ui 同图并排目检；
- 取证脚本为一次性产物不入库；真机测后按惯例 restore 归位由本轮收尾执行。
