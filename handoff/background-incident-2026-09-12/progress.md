# 2026-09-12

- 使用 planning-with-files 技能保存证据与交接步骤。
- 已只读检查源码、事务、归档资源、官方主题写入逻辑；未改源码与安装。
- 读取 worker-client.ts 失败：文件不存在，实际是 pack.ts / pack-worker.ts。
- asar extractFile 使用正斜杠路径失败；改为从 listPackage 获得的原始路径成功读取（Windows 分隔符差异）。
- 初始受限浏览器运行未完成；加超时防止将未完成当成功。经批准在受限环境外运行，sandbox 保持启用。
- 最新成功夹具：verification-1789167107815。六项断言通过，CSS/图片读取正常、模拟动态覆盖完全挡图、两项修复恢复、动态重新插入后保持、安装 hash 未变。
- 复现使用官方静态 CSS 的已解析值模拟官方动态 :root 写入，没有执行官方业务 JS，不是真实窗口截图。
- verify-background.cjs / probe-live-background.js 通过 node --check。
- 未修改应用源码、安装或设置；未运行全量项目测试。方案要求修复 agent 补回归和真机验收。
- 交付：BACKGROUND_FIX_PLAN.md、两份脚本、工作记录、最新成功验证证据；不复制初次失败或旧版广域 token 实验的输出。

## 修复执行（2026-09-12，jc 指示：修复一项提交一项）

前置：现场固定。安装归档 SHA256 `4c697b25…` 与报告一致；工作区除本事故目录外无未提交改动。
顺序按计划 B：先写失败测试，再改源码。每修一项一个提交。

| 提交 | 内容 | 修前测试 | 修后 |
|---|---|---|---|
| `3eebff1` | 纳入诊断交接（本目录） | — | — |
| `525d072` | F1：token 声明 `:root` → `html:root` | 3 项失败 | 3 项通过 |
| `3a3621d` | F2：`--background-stronger` 跟随面板透明度；限定外壳规则 | 2 项失败 | 6 项通过 |
| `c4a04af` | F3：HTML 门禁改结构性校验（`verifyStagedHtml`） | A→B→C 第 3 次 `STAGE_FAILED` | 9 项通过 |
| `216e01e` | F4：局部 alpha 与累计 alpha 分开 | 像素测试失败 | 8 项通过 |

### 各修复要点

- **F1** 只改 token 声明块的选择器（不是全文件替换），并纠正 css.ts / tokens.ts 两处
  「head 最后加载即可覆盖」的错误注释。没有为了提权去加 `!important`，也没退化成 `#root`。
- **F2** stronger 用 `rgba(panel, panelAlpha)`，保留「减少透明度 → 实底」语义；
  外壳只清 `#root .bg-v2-background-bg-deep.flex-1` 这一处，不做全局清空。
  另加反向断言：减少透明度时退化为实底是设计如此，防止被当成缺陷修掉。
- **F3** 去掉「HTML 必须出现在 touched」的条件，改为校验已写入 HTML 的结构
  （链接恰好一个、href 正确、在 head 内、标记唯一）。归档完整性、白名单与字节一致性
  仍由 `verifyPackedResult` 负责；完全相同的 CSS/图片/HTML 继续走 apply.ts 的 no-op。
- **F4** `bubbleLayerAlpha`（局部，CSS/预览用）与 `bubbleAlpha`（累计，报告用）分开，
  新增通用 `stackedAlpha`。像素实测用「裸底/面板/气泡」三层 + 纯色底图反解不透明度。

### 新增测试

- `tests/e2e/background-cascade.spec.ts`（8 项）：隔离夹具 + 模拟官方运行时追加
  `style#oc-theme`，含可见像素判据（开关背景图做像素差）与累计 alpha 像素实测。
  浏览器用本机已装 Edge（`channel: 'msedge'`），不下载二进制、保持 sandbox 开启。
- `tests/integration/stage-idempotence.test.ts`（9 项）：A→B→C 连续换图、C→C no-op、
  五种 HTML 结构异常被拒、官方链接并存不受影响。
- `tests/unit/surfaces.test.ts`（6 项）：层级 alpha 模型。

### 验证链（计划 C，逐步执行，每步退出码 0 才继续）

typecheck 0 · lint 0 · 单元+集成 **205 项** · build 0 · 真实窗口 e2e **16 项** ·
真实 Electron 主进程 **35 项**。

### 未完成（需要 jc）

1. **真机应用与验收（计划 D）**：需要你授权实际改写安装。当前安装的背景仍是旧样式，
   修复只落在源码里。执行前要确认 OpenCode 完全退出，并使用新构建的应用。
2. **重建便携包**：源码已变，`release4/` 的构建不含本次修复；发布前需 `npm run dist`
   并用 `npm run verify:package` 重新核对。
3. 外壳选择器来自 1.18.29 实际布局，升级后须重新核对（已写入源码注释）。
4. 未做真机 DOM 探针（`probe-live-background.js`），未运行真实 OpenCode。
