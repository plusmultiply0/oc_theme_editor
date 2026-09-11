# OpenCode 背景图片不显示：原因与执行方案

诊断日期：2026-09-12。目标版本：OpenCode Desktop 1.18.29。

实际项目目录：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。

## 1. 结论与边界

不是昨天的启动/归档截断事故重现。最新成功事务中，图片和样式已经写入安装，而且图片可以完整解码。当前至少存在两项可复现的渲染缺陷，以及一项连续换图隐患：

1. **P1：自定义变量被启动后的官方动态主题覆盖。** 助手只考虑静态 CSS 的先后顺序，未考虑官方运行时追加 `style#oc-theme`。
2. **P1：部分正文仍使用完全不透明的背景；大面积外壳又额外盖一层。** 单独提高 CSS 优先级不足以让所有内容区域透出图片。
3. **P1：准备区错误要求每次应用都改变 HTML。** 换图时 HTML 链接本来应该保持不变，可能因此返回 STAGE_FAILED；这与“写入成功却看不见”是两个不同分支。

本轮只诊断及生成交接文件，**没有修改助手源码、重打包安装、修改用户设置或启动真实 OpenCode 做试写**。浏览器验证使用隔离夹具，加载真实安装的 CSS 与图片、简化布局，模拟官方动态插入顺序；没有运行其业务 JS，也没有读取聊天内容或 localStorage。因未检查真实运行窗口 DOM，不能断言所有页面均已验证，更不能说用户的安装已经修好。

若你看到的是新的“应用失败”弹窗，应记录错误码/时间并先查第 3 项；如果助手提示成功但重启后背景不见，优先第 1、2 项。最新成功事务不能排除其后发生了未落入 applied 记录的失败尝试。

## 2. 本机证据

- 安装归档：`C:\Users\ylzho\AppData\Local\Programs\@opencode-aidesktop\resources\app.asar`。
- SHA256：`4c697b25348617d11bd46fdb38df3f420bc63bc453377b7ca3f8253bc417e969`。
- 最新成功事务：`op-20260911T223541015Z-xpbuz9`，落盘完成时间 2026-09-12 06:36:11（北京时间）；afterHash 与当前归档相同。
- 主题摘要：`314827.jpg · 浅色 · 遮罩 0.59 · 面板 0.31`。
- HTML 中已存在 `./oc-theme-custom.css`，旧 snow-theme.css 链接已撤下。
- `out/renderer/oc-theme-background.jpg`：4,947,909 字节，4106×2310，SHA256 `80fbd6a98935542dd2ac45bc98b2f9f1a8e40c47a76200ef29856f82742dad7b`。
- sharp 完整像素解码及隔离浏览器 `Image.decode()` 都成功，排除本份归档中“图片缺失/损坏”的解释。
- 验证前后归档 SHA256 相同。

完整计算值、官方代码片段和截图见同目录 `verification/evidence.json` 与 `verification/*.png`。截图是复现夹具，不是实际 OpenCode 窗口。

## 3. 代码定位与因果

### F1：同优先级 :root 被运行时覆盖

- `src/core/theme/css.ts:111`：生成普通 `:root { ... }`。
- `src/core/theme/tokens.ts:14`：注释错误假设“head 最后加载即可覆盖”。
- 安装归档 `out/renderer/assets/main-5jvEfisE.js:39398`：`ensureThemeStyleElement()` 调用 `document.head.appendChild(element2)`。
- 同文件 `:39410`：`applyThemeCss()` 创建包含颜色与 v1/v2 变量的 `:root` CSS，并写入 `style#oc-theme`；切主题/色彩模式时再次执行。

官方和助手都是 `:root`，官方在后，即可覆盖助手的 RGBA 面板值。根布局及子面板重新成为实色，图片虽成功加载，像素却被挡住。

**最小修复：**只把生成的 token 声明选择器改为 `html:root`（不要把整文件的所有选择器盲目替换）。它在同一根元素上比官方 `:root` 更具体，现有版本无需到处添加 `!important` 或修改官方主题函数。注释同步说明动态插入行为。不要只改成 `#root` 变量：官方根级别的 `--color-*` 别名可能已在祖先解析，body 下的 Portal 也不一定继承 #root。

```ts
// css.ts 的输出模板，原来的 :root 改为：
html:root {
  color-scheme: ${resolvedMode};
${renderTokenCss(tokens, spec)}
}
```

此方案针对已确认的 1.18.29 普通 `:root` 规则。以后官方使用 inline / !important / 更强选择器时应重新适配，不能宣称全版本通用。

### F2：不透明主面板与多层遮罩

- `src/core/theme/tokens.ts:59`：`--background-stronger` 使用 `tokens.panel`，是 HEX 实色。
- `src/core/theme/tokens.ts:144`：`--v2-background-bg-deep` 固定 alpha=.6。
- 官方 `main-5jvEfisE.js:107208` 的 NewLayout 外壳是 `relative bg-v2-background-bg-deep flex-1 ...`，下方还有面板。
- 官方旧布局的部分正文、输入外围、审阅标签等使用 `.bg-background-stronger`。
- 助手 `Preview.tsx` 使用自己的 mock DOM 与 `--p-*`；它并没有加载官方运行时主题，预览正常不构成目标端正确的证据。

**最小修复的两部分：**

1. `--background-stronger` 改成 `rgba(tokens.panel, p)`，其中 p 复用现有 `panelAlpha(spec)`，保留“减少透明度”时 p=1 的语义。不要把 `--surface-raised-stronger-non-alpha` 之类明确需要实底的所有 token 一概透明化。
2. 让真实大面积 NewLayout 外壳不再叠额外的 .6 底色；保留标题栏、小控件、悬浮层各自的设计。不应全局把所有 `bg-deep` 或所有 div 清空。

```ts
// tokens.ts，仅替换对应声明：
{ name: '--background-stronger', value: rgba(tokens.panel, p), note: '正文强背景（随面板透明度）' },
```

```css
/* css.ts 输出中增加，选择器来自本版本实际布局；升级时需重新核对 */
#root .bg-v2-background-bg-deep.flex-1 {
  background-color: transparent;
}
```

后一个选择器已在隔离夹具验证，但发布前必须用真实 DOM 确认它命中目标外壳且不误伤其他全高容器。若不匹配则停止自动应用，补适配器布局证据，不能退化成 `#root * {background:transparent!important}`。

不要先删除 `#root` 的 isolation 或负 z-index。夹具保持原有 `::before z-index:-2`、`::after z-index:-1` 结构即可显示背景，说明本次没有证据支持“负 z-index 必然导致看不见”。

### F3：换图幂等与 HTML 变化门禁互相矛盾

- `src/core/patch/stage.ts:274`：`if (!touched.includes(adapter.injection.htmlEntry))` 直接报错。
- `injectLink()` 本身设计为幂等；本机原 HTML 有缩进差异，第一次规范化从 1269 字节变 1267，后两次完全相同。
- 换主题时 CSS/图片可以变化，而 HTML 无需变化；相同 HTML 不应被当成注入失败。
- `tests/integration/transaction.test.ts:116` 的现有测试只换两次并数 link，可能被首次缩进规范化的偶然变更掩盖。至少连续应用 A→B→C 才能覆盖本机这类情况；具体归档格式不同也可能第二次就失败。

**修复：**移除“HTML 必须出现在 touched”的条件，改为结构性验证：目标 HTML 中恰有一个本工具 CSS 链接，href 正确，位于 head 内，工具标记唯一，图片/CSS 引用存在且资源字节等于期望值。已有 `verifyPackedResult(expected)` 的字节核对继续保留，不能为绕过报错删掉归档完整性或白名单校验。

如果 CSS、图片、HTML 全相同，让 apply.ts 的内容指纹 no-op 路径处理；修复 HTML 格式不应变成每次强行塞时间戳来通过门禁。

### F4：预览/对比度的层数仍应审计（次要，但应同批补测试）

`surfaces.ts` 将气泡等效 alpha 算为 b=1-(1-p)^2；Preview 的 `.mock-main` 已画 p，`.msg` 又画 b，实际会是 1-(1-p)^3。p=.31 时 b=.5239，但真实合成会是 .671491，而不是报告假定的 .5239。外壳 .6 的层也没有计入同一模型。

这不是图片加载失败，却会造成图更淡与对比度判断失真。请区分“局部 CSS 层 alpha”和“从图片起累计 alpha”：若气泡在 p 面板上再叠一层 p，CSS 用 p，报告才用累计 b；Portal 是否有面板祖先需分场景建模，不能重复使用累计值去绘制子层。代码块同理。

## 4. 复现结果

`verification/evidence.json` 使用“开/关背景图后，区域中产生可测像素变化的比例”衡量是否被完全挡住。它不是图片不透明度，也不是 UI 得分。

| 夹具状态 | 侧栏 | 使用 stronger 的正文 |
| --- | --- | --- |
| 当前静态自定义 CSS | 可透出 | 完全被挡住 |
| 再插入官方 :root 变量 | 完全被挡住 | 完全被挡住 |
| 只提高到 html:root | 恢复 | 仍被挡住 |
| 同时修正 stronger 与外壳 | 恢复 | 恢复 |
| 官方主题再次移除/追加 | 保持 | 保持 |

夹具按官方样式算出原生根变量后模拟运行时插入，并非执行实际 ThemeProvider；因此证明的是覆盖机制及方案有效性，而不是完成所有真实页面验收。当前实际 CSS 图片 URL 与负层级保持不变。

## 5. 交给其他 agent 的执行顺序

### A. 先固定现场（不重新应用）

1. 检查当前 git diff/未提交改动，保留用户和上个 agent 的修改。
2. 记录安装 SHA256、版本、最新事务。若 hash 与本报告不同，重新运行只读脚本，不能直接套用旧证据。
3. 用户若提供“应用失败”提示，记录错误码/详情，区分 precheck、stage、replace 与仅视觉不显示。
4. 如需真机证据，在用户允许的 OpenCode 渲染器 DevTools 控制台执行 `probe-live-background.js`，保存返回的 JSON。它只读样式/布局，不读聊天文字或设置存储；无需打开远程调试端口、清缓存或改安全设置。

### B. 先写失败测试，再做源码修复

1. 新建 `tests/e2e/background-cascade.spec.ts`：加载生产生成 CSS，使用隔离布局，追加官方式 `:root`；断言计算后的透明度和背景图像素确实可见。
2. 修改 css.ts 的 token 选择器、tokens.ts 的 stronger、限定外壳规则，更新错误注释。
3. 扩展 `tests/integration/transaction.test.ts`：A→B→C 连续换三张图，每次都断言 success、图片 hash 已更新、link 数=1、未授权条目 hash 不变。再测 C→C no-op，不新增事务/写盘。
4. 修正 stage.ts 的 HTML 门禁，补缺 link、重复 link、错误 href、锚点缺失的拒绝测试。
5. 区分局部/累计 alpha，修复预览与对比度模型，补嵌套面板、代码块和 body Portal 的像素测试。
6. 提示文本可改成“资源已写入，请完全退出并重启 OpenCode 验证背景”，将写入成功和视觉验收分开；不要让 mock 预览承担真机验证。

### C. 构建与验证（由修复 agent 执行，本轮未执行）

在实际项目根目录，依次运行：

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
npm run test:e2e
npm run test:e2e:electron
```

每一步退出码非 0 即停，不要因为后面的命令成功而忽略前面的失败。打包前查看 package.json 实际输出目录；目前是 release4，不要启动旧 release/release2 的 exe 误以为在测新代码。不要把本轮未运行的全量测试声称为通过。

### D. 真机应用与验收（需要用户授权实际修改安装）

1. 确认 OpenCode 完全退出；不要直接强杀进程或在运行中替换归档。
2. 使用已有经过验证的备份、原子替换、unpacked 保留、逐条 hash/语法校验流程。保持当前归档可恢复；**不要重新执行 09-11 的旧事故恢复脚本**，它绑定的是旧故障现场。
3. 从新构建的助手应用背景 A，重启 OpenCode；同时检查首页、会话、侧栏、输入、菜单、旧/新布局。
4. 再用 B、C 连续换图，检查资源 hash 与实际图片一致；同图重复应用应 no-op。
5. 官方主题切换、浅/深模式切换及重启后背景仍在；若工具固定浅/深模式，应按产品约定保持它，不要因官方模式变化使样式冲突。
6. 检查 dialog/menu/tooltip 等 Portal、焦点环、错误色、终端与代码内容不受破坏；“减少透明度”允许实底，不能误判为缺陷。
7. 测试恢复上一主题、恢复可验证备份；备份不健康则停止，不选择未知备份覆盖。
8. 记录真实截图、DOM 探针、测试输出和最后 hash；只有完成此步才能标记“真实安装已修复”。

## 6. 可直接执行的只读复现脚本

前提：Node 与项目已有依赖可用，已安装 Edge。脚本不自动安装依赖。它读取项目的已构建 injectLink 用于幂等演示，所以源码修改后需先构建再核对；渲染部分始终读取当前安装内的 CSS，不会自动测试尚未应用的源码。

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
node .\handoff\background-incident-2026-09-12\verify-background.cjs
```

结果默认写到脚本旁全新的 `verification-时间戳` 子目录，不覆盖原有输出。退出 0 表示脚本中定义的故障/修复机制断言通过，**不是用户安装已修复**；安装修好后旧故障断言不再成立而返回 2 是可能的，应更新为回归测试期望。失败/超时不应视为成功。

受限执行环境曾导致浏览器新页阶段超时；经批准在限制外运行后验证成功，浏览器保持 sandbox 开启、使用临时配置、所有请求由内存夹具提供或拒绝。不要用 `--no-sandbox` 或读日常浏览器配置规避问题。

## 7. 本轮交付与禁止事项

- 本文：原因、定位、修复顺序、真机验收要求。
- `verify-background.cjs`：只读归档审计、独立浏览器复现、截图与 JSON。
- `probe-live-background.js`：可选真机只读 DOM 取证。
- `verification/`：本轮成功复现的证据与五张截图。
- `task_plan.md` / `findings.md` / `progress.md`：工作记录。

不要为了让图片出现去修改官方 main.js、删除 theme preload、清用户缓存/设置、关闭安全开关，或者删掉此前补齐的 ASAR 校验。问题集中在主题 CSS 适配与幂等门禁，修复应保持这个范围。
