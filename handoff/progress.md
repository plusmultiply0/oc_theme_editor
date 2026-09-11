# 交接进度

## 2026-09-10：执行计划编制

- 用户要求：围绕先前第一版五项范围，列出其他 agent 能照着执行的详细计划。
- 已完成：阅读 planning-with-files 技能及模板、现有原型关键文件、历史计划和进度；尝试会话恢复。
- 已发现：旧工具绑定本机状态、辅助脚本未包含在复制包、恢复语义不同、原生视觉验收不完整。
- 文件位置：源项目的 `handoff/` 子目录；不覆盖历史文档。
- 产品代码状态：未开发；没有运行任何 apply/stage/restore，没有修改安装资源。
- 目标目录异常：本轮读取 `OpenCode/_Theme/_Switcher` 返回不存在；记录但不自动重建。
- 已完成 EXECUTION_PLAN.md：五项范围、P0–P6、数据契约、故障测试、并行分工、交付验收和五类开工提示词。
- 用户再次指定 D 盘目标，准备将本目录四份文档复制到目标的 handoff 子目录；传输结果以实际复制和哈希校验输出为准。
- 下一步（开发）：由用户授权执行 agent 按 P0 开始；目前没有产品代码实现或验收通过记录。

## 验证记录

| 项目 | 结果 |
|---|---|
| 原型只读检查 | 已完成；结论见 findings.md |
| 会话恢复脚本 | 无输出；未以此断言恢复成功 |
| D 盘复制目录检查 | 失败：路径不存在；原因未确认 |
| 新产品单元/E2E/真实应用测试 | 未执行：本轮仅计划 |

## 2026-09-10：P2 图片、配色与可读性引擎（T20–T27）

- 任务 ID：T20（导入与校验）、T21（分析）、T22（取色）、T23（CSS 模板）、T24（参数范围）、T25（对比度目标）、T26（透明合成建模）、T27（覆盖范围边界）。
- 完成状态：已完成，单元测试通过；**未对真实安装做任何写入或修改**。
- 改动文件：
  - 新增 `src/core/theme/validate.ts`（magic bytes 格式识别、SVG 拒绝、20MiB / 40MP 限制）
  - 新增 `src/core/theme/palette.ts`（确定性量化取色，无随机种子；`isMostlyGray`）
  - 新增 `src/core/theme/contrast.ts`（WCAG 相对亮度、`composite`、`effectiveBackground`、`CONTRAST_TARGETS`）
  - 新增 `src/core/theme/color.ts`（`shift/lighten/darken/mix`、`ensureContrast`、`deriveStates`）
  - 新增 `src/core/theme/css.ts`（token 模板渲染、`validateImageRef` 白名单）
  - 新增 `src/core/theme/generate.ts`（`analyzeImage` / `deriveTokens` / `generateTheme`）
  - 新增 `tests/unit/theme.test.ts`（27 项）
  - 修改 `package.json`：新增依赖 `sharp ^0.35.4`；`package-lock.json` 同步
- 测试命令与退出码：
  - `npx tsc --noEmit` → 退出码 0
  - `npx eslint .` → 退出码 0
  - `npx vitest run tests/unit` → 退出码 0，2 文件 / 39 项全部通过（新增 27 项）
- 证据位置：`tests/unit/theme.test.ts`；对比度实测值由 `generateTheme` 返回的 `contrast` 字段给出（`textOnPanel` / `primaryOnPanel` / `effectiveBackground`）。
- 本轮修复的两个缺陷：
  1. `palette.ts` 中 `saturation(m.color.color)` 解构 `undefined` 抛错，被吞成 `IMAGE_DECODE_FAILED`；改为 `saturation(m.color)`。
  2. `color-scheme` 用 `spec.mode` 字面值渲染，auto 解析为 dark 时仍输出 `light`；新增 `RenderCssInput.resolvedMode` 并补测试锁死。
- 已知问题 / 边界：
  - `contrast.effectiveBackground` 以图片代表色作为采样点，是单点近似，不是全图逐像素最差值；P5 真实验收时若发现局部区域刺眼，需要改成按图像网格取最差对比度。
  - 终端（`.xterm`）与代码语法高亮不在覆盖范围内，符合 T27 决策。
  - sharp 为原生模块，便携包打包需按目标平台取二进制（P5 处理）。
- 未执行：真实安装读写、GUI 启动、集成测试、E2E —— 均未在 P2 阶段运行。
- 下一任务：P3（T30–T42）目标识别、变更白名单、备份、事务应用与恢复；仅对合成 fixture 开发，不触碰真实安装。

## 2026-09-10：P3a 目标识别与 adapter（T30–T33）

- 任务 ID：T30（候选位置与路径安全）、T31（adapter 声明与识别）、T32（进程与权限检查）、T33（磁盘预检）。
- 完成状态：已完成，单元 + 集成测试通过；**未对真实安装做任何写入**，也**未运行真实进程探针**。
- 改动文件：
  - 新增 `src/adapters/types.ts`、`src/adapters/opencode-desktop.ts`、`src/adapters/registry.ts`
  - 新增 `src/core/patch/paths.ts`（canonicalize、包含性检查、归档条目名安全）
  - 新增 `src/core/patch/asar.ts`（只读访问：指纹、条目列表、读取 package.json）
  - 新增 `src/core/patch/discover.ts`（候选枚举、识别、scan 结果）
  - 新增 `src/core/patch/precheck.ts`（进程探针、写探针、磁盘预检、运行数据根目录）
  - 新增 `tests/fixtures/synthetic-install.ts`（合成安装 fixture，真实 ASAR 打包）
  - 新增 `tests/unit/paths.test.ts`、`tests/integration/discover.test.ts`
  - 修改 `docs/compatibility.md`：补 G0 决策结论与 T31 adapter 声明
  - 修改 `package.json`：新增依赖 `@electron/asar ^4.3.0`（MIT，已在 node_modules 核实许可字段）
- 测试命令与退出码：
  - `npx tsc --noEmit` → 0
  - `npx eslint .` → 0
  - `npx vitest run tests/unit tests/integration` → 0，4 文件 / 72 项全部通过（新增 33 项）
- 证据位置：`tests/integration/discover.test.ts`（合成 ASAR 上的识别与预检）；`docs/compatibility.md` 的 adapter 声明表。
- 本轮修复：`getRawHeader` 实际返回 `{ headerString, header, ... }`，直接当根结点会导致条目列表为空；已在 `readAsar` 中兼容两种层级。
- 已知问题 / 边界：
  - 进程探针 `systemProcessProbe` 依赖 PowerShell `Get-CimInstance`，**尚未在真实环境运行过**；查询失败一律返回 `unknown` 并按「未退出」处理（保守拒绝）。
  - 卸载登记表读取（`registryRoots`）同样未经真实环境验证，失败时静默返回空数组。
  - 未验证版本判 `unknown` 而非 `unsupported`：认得出但没验证 ≠ 完全不认识，UI 需分别展示。
- 未执行：真实安装的识别（未扫描用户机器）、任何写入操作、进程强制结束。
- 下一任务：P3b（T34–T42）事务应用与恢复——锁、staged 校验、备份、同卷替换、事务日志、恢复入口与 13 类故障注入测试。

## 2026-09-10：P3b 事务应用与恢复（T34–T42）

- 任务 ID：T34 锁、T35 准备区与白名单、T36 备份语义、T37 提交前复核、T38 同卷替换、T39 提交后复核、T40 启动恢复扫描、T41 两个恢复入口、T42 幂等与 no-op。
- 完成状态：已完成，20 项集成测试（含 13 类故障注入）全部通过；**未对真实安装做任何写入**。
- 改动文件：
  - 新增 `src/core/patch/layout.ts`（运行数据布局）、`lock.ts`（实例独占锁）、`backup.ts`、`stage.ts`、`commit.ts`、`txlog.ts`、`recovery.ts`、`restore.ts`、`apply.ts`
  - 修改 `src/shared/schema.ts`：`OperationManifest` 增加可选 `kind` / `themeHash` / `backupKind`
  - 修改 `tests/fixtures/synthetic-install.ts`：支持 `unpack` 选项以构造 unpacked 条目
  - 新增 `tests/integration/transaction.test.ts`（20 项）
  - 修改 `vitest.config.ts`：集成测试含解压/重打包，`testTimeout` 提到 30s
  - 修改 `eslint.config.mjs`：`no-unused-vars` 开启 `ignoreRestSiblings`
  - 修改 `docs/architecture.md`：补事务与恢复模型
- 测试命令与退出码：
  - `npx tsc --noEmit` → 0
  - `npx eslint .` → 0
  - `npx vitest run` → 0，5 文件 / 92 项全部通过（新增 20 项）
- **本轮最关键的取证**：只读探测真实归档发现 **47 个 unpacked 条目**（原生模块，实体在 `resources/app.asar.unpacked/`）。直接用 `createPackage` 重打包会把它们塞回归档导致应用启动即崩；改为从原始 header 收集 unpacked 集合、用 `createPackageFromStreams` 逐条目重建，并在打包后复核集合一致，不一致即 stage 失败。
- 本轮修复的缺陷：
  1. `createPackageFromStreams` 的 `stream.stat` 必须是原始 `fs.Stats`，多包一层 `{type, stat}` 会导致 `storeFileEntry` 收到 undefined 抛 `Cannot convert undefined to a BigInt`。
  2. Windows 上 `extractFile` 用 `path.dirname/basename` 逐级查找，归档内路径必须转成平台分隔符，否则带 `/` 的路径查不到。
  3. 锁在同进程内被误判为残留锁而放行（pid 是自己就清理）→ 新增进程内持有集合，同进程二次操作同样报 `TRANSACTION_IN_PROGRESS`。
- 已知问题 / 边界：
  - `systemProcessProbe` 仍未在真实环境运行过；测试统一注入 `idle` 探针，绕过了 PowerShell 调用。
  - 「文件占用」场景未单独注入：Windows 文件锁难以在合成环境稳定复现，当前只验证了提交中断路径；P5 真实验收时需补。
  - 备份只做整档复制（150MB 级），恢复粒度是整档而非单文件；`previous` 只保留最近 3 份。
  - 全流程耗时主要在解压 + 重打包，真实安装（152MB / 6994 条目）的耗时未实测。
- 未执行：真实安装的应用/恢复、GUI 联调、便携包。
- 下一任务：P4（T50–T56）桌面界面与真实联调。

## P4a：主进程服务层与 IPC 接线（T50 数据侧、T53、T54、T55）

- 任务 ID：T50（数据来源）、T53（预览与输出同源）、T54（准备/应用两段式）、T55（恢复语义）、T56（外链白名单，仅主进程侧）。
- 完成状态：已完成；**未对真实安装做任何写入**，全部在临时目录的合成安装上验证。
- 改动文件：
  - 新增 `src/main/services/image-store.ts`（图片登记/导入/只读读取，路径不外传）、`target-service.ts`（识别与缓存）、`theme-service.ts`（生成与报告）、`operation-service.ts`（准备→应用→恢复）、`events.ts`（进度广播）
  - 新增 `src/main/ipc.ts`（11 + 1 个通道注册，全部 try/catch 收敛为 AppError）
  - 重写 `src/main/index.ts`：装配服务、注入系统选择框、事件推给所有窗口；删除 `handlers.mock.ts`
  - 新增 `src/core/theme/report.ts`：逐条对比度报告，scope/sampling 写明范围与采样方法，`verified` 恒为 false
  - 修改 `src/core/theme/generate.ts`：先合成实际底色再推导 token；语义色（状态/diff/边框/焦点/主色）按实测底色保障对比度
  - 修改 `src/shared/schema.ts`：`ThemeSpec` 增加可选 `primary`；导出 `ContrastTarget`
  - 修改 `src/shared/ipc.ts`：`discoverTargets` 返回 `{targets, rejected, scanned}`；`StagedTheme` 改为 `StageSummary`（提交前不存在 afterHash，不伪造）；`RestoreThemeInput` 增加 `kind`；新增 `openExternal`
  - 修改 `src/shared/errors.ts`：新增 `errorResult()`
  - 修改 `src/core/patch/backup.ts`：新增 `listBackupRecords()`
  - 新增 `tests/integration/main-services.test.ts`（8 项）
  - 修改 `package.json`：`build:main` 先清空 `out/`，避免旧的 `handlers.mock.js` 被打进产物
- 测试命令与退出码：
  - `npx tsc --noEmit` → 0
  - `npx eslint .` → 0
  - `npx vitest run` → 0，6 文件 / 102 项全部通过（新增 10 项）
  - `npm run build` → 0（`out/main/index.js`、`out/renderer/index.html` 均产出）
- 本轮设计决策（有取舍，记录在案）：
  1. **准备阶段不返回完整 manifest**：`afterHash`/`backupHash` 在真正提交前并不存在，拿占位值冒充等于喂假数据给界面。改为返回 `StageSummary`（变更范围、备份位置、需要空间、目标指纹）。
  2. **自动取的主色会按 3:1 校正，用户指定的主色原样保留**。读不清时由报告如实判定并阻断进入应用，不偷偷改掉用户的选择——否则「对比度不合格无法应用」这条状态永远不可达。
  3. **语义色（状态/diff/边框/焦点）按三层合成后的实际底色保障**，不是按面板色。原 P2 测试断言深色下 `status.error === '#c0392b'`，该断言把「保持固定常量」误当成「独立于主色」，已改为断言色相语义与实测对比度。
- 本轮修复的缺陷：
  1. 并发占位在 `await` 之后才加，两次点击会同时穿过检查 → 改为同步占位（T54「双击不能启动第二事务」）。
  2. Windows 上 `extractFile` 需要平台分隔符，测试改用 `toArchivePath()`。
- 已知问题 / 边界：
  - `systemProcessProbe` 仍未在真实环境运行过；服务层预留 `probe` 注入，测试注入 `idle`。
  - 图片选择框（Electron `dialog`）未在自动化测试中覆盖，只覆盖了注入 picker 的路径。
  - 准备记录里的 `imagePath` 是原图绝对路径，仅存于本机运行数据目录，不外传；若原图被移动，应用阶段会报 `IMAGE_NOT_FOUND` 并提示重新选图。
- 未执行：GUI 九类状态与 E2E（P4b）、真实安装应用（需授权）。
- 下一任务：P4b（T51、T52、T54 界面、T55 恢复界面、T56 键盘/焦点/缩放）。

## P4b：桌面界面与联调（T50–T56）

- 任务 ID：T50 主布局、T51 九类状态、T52 交互、T53 预览同源、T54 应用确认、T55 恢复语义、T56 键盘/焦点/缩放/减少透明度/外链。
- 完成状态：代码与构建完成；**GUI 未在真实窗口里跑过（本环境无法启动 Electron 窗口），E2E 未执行**。
- 改动文件：
  - 新增 `src/renderer/logic.ts`：默认/重置/夹紧参数、错误状态归类、应用按钮可用条件、九类界面状态（纯函数，可单测）
  - 新增 `src/renderer/components/Preview.tsx`、`ContrastPanel.tsx`、`ApplyDialog.tsx`、`RestorePanel.tsx`
  - 重写 `src/renderer/App.tsx`：三栏布局、九类状态机、拖拽导入、参数防抖重算、应用确认、恢复面板、缩放、减少透明度
  - 重写 `src/renderer/styles.css`：浅色蓝白、rem 布局，72rem 以下改纵向堆叠
  - 新增 `getImagePreview` 与 `importImageData` 两个 IPC 通道：预览只给工具自己生成的缩略图 data URL；拖拽只接收文件**内容与文件名**，renderer 始终拿不到路径
  - 新增 `tests/unit/ui-logic.test.ts`（18 项）、`tests/integration/main-services.test.ts` 补 1 项拖拽导入
  - 新增 `tools/smoke-main.cjs` + `npm run smoke`：在真实 Electron 主进程里装配服务做只读识别（需手动运行）
- 测试命令与退出码：
  - `npx tsc --noEmit` → 0
  - `npx eslint .` → 0
  - `npx vitest run` → 0，7 文件 / 120 项全部通过（新增 19 项）
  - `npm run build` → 0
- 本轮设计决策：
  1. **拖拽不走文件路径**。Electron 的拖入 `File` 带 `.path`，但契约规定 renderer 不得传路径；改为 renderer 读成 `Uint8Array` 传给主进程，主进程落一份副本到运行数据目录后再走同一条导入管线。
  2. **失败必须说清安装有没有被改**。`errorScope()` 把错误码映射到「未修改 / 可能已修改 / 无法判定」，并为 ERROR_CODES 全量写了归类测试，避免新增错误码时漏掉。
  3. **可读性不合格在准备阶段就拦住**（`stage` 内检查 `report.passed`），界面只是提前把按钮置灰并给出可行动原因。
- 已知问题 / 边界：
  - **GUI 未运行验证**：本会话环境里 `ELECTRON_RUN_AS_NODE=1`，带此变量时 `require('electron')` 返回路径字符串、主进程不启动；去掉后 Electron 作为 GUI 子系统进程启动，stdout 不回传终端，脚本无输出。因此窗口、系统选择框、真实渲染均**未验证**，只验证了纯逻辑与服务层。
  - **E2E（T56 验收要求）未执行**：Playwright 对 Electron 的支持在本项目未搭建；界面交互目前只有纯逻辑单测覆盖。
  - 参数与缩放存 `localStorage`，写入失败会在状态栏提示（保存失败路径本身未自动化验证）。
  - 「减少透明度」默认跟随系统 `prefers-reduced-transparency`，未匹配到时为 false。
- 未执行：真实安装的应用/恢复（需授权）、GUI 实机走查、E2E。
- 下一任务：P5（T60–T65）集成、真实验收与便携包。

## P5a：集成检查、合规审计与便携包（T60、T61、T65 部分）

- 任务 ID：T60 命令与退出码、T61 合规审计、T65 便携包构建与产物核对。
- 完成状态：T60 / T61 / T65 的构建与产物核对已完成；T62–T64 真实安装验收**未执行**（需授权）；T65 的干净环境启动验证**未执行**。
- 改动文件：
  - 新增 `tools/audit.cjs` + `npm run audit`：路径/用户名、凭证、产物泄漏、依赖许可、IPC 三处一致五项检查，退出码非 0 即阻断
  - 新增 `docs/acceptance.md`：记录命令、退出码、审计结论、便携包核对与未执行项
  - 新增 `playwright.config.ts` + `tests/e2e/README.md`：`test:e2e` 限定目录并加 `--pass-with-no-tests`，避免它跑去执行 vitest 用例；README 写明 E2E 未实现及补法
  - 修改 `package.json`：新增 `audit` / `smoke` 脚本、`build`（electron-builder）配置；`test:e2e` 加 `--pass-with-no-tests`
  - 修改 `.gitignore`：忽略 `test-results/`、`playwright-report/`
- 命令与退出码（逐条实跑）：`typecheck` 0、`lint` 0、`test:unit` 0（4 文件 76 项）、`test:integration` 0（3 文件 44 项）、`test:e2e` 0（**0 用例**）、`build` 0、`audit` 0、`dist` 0。
- 关键发现：
  1. `npm run dist` 直连 GitHub 会 `ETIMEDOUT`（20.205.243.166:443）。改用 npmmirror 的 electron 与 electron-builder-binaries 镜像后构建成功。**默认命令在净网环境会失败**，CI 或换机器时要带上镜像变量。
  2. 便携包 `resources/app.asar` 952 个条目，顶层只有 `out/`、`node_modules/`、`package.json`，源码/测试/旧原型都没进包，检索 `zjcfile`、`作者用户名` 命中 0。
  3. `playwright test` 默认会把 vitest 的 `*.test.ts` 也当用例执行并报「Vitest cannot be imported in a CommonJS module」，必须限定 `testDir`。
- 已知问题 / 边界：
  - 便携包 **未签名**，不得对外声称已签名；体积 326 MB（dir 目标，未压缩）。
  - 干净环境启动验证未做；本环境无法启动 Electron 窗口（同 P4b 的原因）。
  - E2E 仍为 0 用例，`test:e2e` 退出码 0 只代表「没有用例」。
- 未执行：T62 合成/真实安装验收流程、T63 真实应用与观察、T64 真实界面走查、T65 干净环境启动。
- 下一任务：T62–T64（需 jc 授权）→ P6（T70–T74 交付材料）。

## P6：交付材料（T70、T71、T74；T72 只出脚本）

- 任务 ID：T70 README、T71 文档集、T72 演示、T73 文章提纲、T74 交付清单。
- 完成状态：T70 / T71 / T73 / T74 已完成；**T72 未拍摄**（缺真实应用画面）。
- 改动文件：
  - 新增 `README.md`：定位、支持范围（只认 1.18.29）、五步使用、恢复语义、非官方风险、常见报错表（10 条，含中文原因与动作）、已知限制、开发命令与镜像说明
  - 新增 `docs/security.md`：信任边界、写入白名单、事务安全、备份三语义、输入安全、隐私、**不保证什么**
  - 新增 `CHANGELOG.md`、`docs/demo-script.md`、`docs/article-outline.md`、`docs/release-checklist.md`
  - `docs/acceptance.md` 已在 P5a 提供（T71 要求的验收记录）
- 命令与退出码：`npm run audit` → 0、`npx tsc --noEmit` → 0、`npx eslint .` → 0。
- 刻意保留的诚实表述（不要在后续润色中被删掉）：
  - README 的「已知限制」里写明**真实安装验收未完成**、**E2E 为 0 用例**、**便携包未签名**。
  - `docs/demo-script.md` 首行即「未拍摄」，并列出拍摄前必须完成的 T63/T64。
  - `docs/article-outline.md` 要求发布前重新核实活动规则与日期，效果与限制部分要比效果写得重。
  - `docs/release-checklist.md` 给出两个产物的 SHA256，并注明重新构建后会变化。
- 未执行：T72 演示视频、T73 实际发文（需授权）、T62–T64 与 T65 干净环境验证。
- 下一步：等 jc 决定是否授权真实安装验收（T62–T64）；授权前不触碰真实安装。

## P5b：真实安装验收（T62 完成、T63 第 1 步完成、T64 待 jc 观察）

- 任务 ID：T62 合成→真实、T63 应用与观察、T64 真实界面走查、T65 干净环境清单。
- 授权：jc 于 2026-09-11 授权真实安装写入；**应用/关闭与画面观察由 jc 手动完成**。
- 改动文件：
  - 新增 `tools/live-cli.cjs`（`status` / `precheck` / `apply` / `restore`），与 GUI 共用服务层
  - 修复 `src/core/theme/color.ts` 的 `ensureContrast`：只沿一个方向调整明度，中间调底色上判不出解
  - 修复 `src/core/theme/generate.ts` 的 `onPrimary`：起点改为黑白中对比度更高者，不再用亮度阈值猜
  - `tests/unit/theme.test.ts` 补 6 项中间调回归
  - `docs/acceptance.md` 记录真实预检、第一次应用、写入复核与观察清单
  - 新增 `docs/portable-verify.md`：干净环境逐条勾选清单（供 jc 执行）
- 命令与退出码：`npx tsc --noEmit` 0、`npx eslint .` 0、`npx vitest run` 0（7 文件 / 126 项）。
- **本轮最重要的一条**：真机第一次应用就被拦下 —— `主按钮文字 4.11 < 4.5`。
  合成测试从没触发过，因为合成图片都是纯色极端值。根因是 `ensureContrast` 单向调整 + `onPrimary` 用 150 亮度阈值选黑白。
  修法：起点取黑白中对比度更高者，两个方向都试。这件事说明**真实验收不可替代**。
- 真实写入证据：指纹 `1c53ca2472698a9e…` → `aeab66d4a2681f8c…`；归档 6994 → 6996 条目，**47 个 unpacked 全部保留**；
  注入位置在原 `snow-theme.css` 之后；备份 original + previous 各一份。
- 进程探针首次在真实环境跑通（此前只注入 `idle` 绕过）。
- 未完成：第 2 次应用（换浅色主题）、恢复上一主题、恢复原版、T64 走查、T65 干净环境（等 jc）。

## 维护：目标发现扫出满屏无关软件（2026-09-11，jc 反馈）

- 任务 ID：无（T30/T31 的实现缺陷，jc 从真机截图发现）。
- 现象：界面「未通过的候选」列出 Fiddler、ima.copilot、Postman、zotero、Trae、Telegram Desktop、
  VS Code、origin、Quark、nvm、Bandizip、Everything、Git、Common Files… 一屏无关目录。
- 根因：`registryRoots()` 用 `reg query <Uninstall 键> /s /v InstallLocation` 取**所有**卸载登记项的位置当候选。
  装了 14 个软件就有 14 个「候选」，每个都扫不到归档 → 每个都报一条失败。
  这与「只扫明确登记的位置」的设计意图相悖。
- 改动文件：
  - `src/core/patch/discover.ts`：新增 `parseRegDump()` / `UninstallEntry` / `RegRunner`；
    改为先查 `DisplayName`、**只在命中 `/opencode/i` 时**才读该项的 `InstallLocation`；
    登记值去引号与尾部分隔符；按小写路径去重；补 WOW6432Node 两个键；
    `discoverTargets()` 不再把 `TARGET_NOT_FOUND` 当成「未通过」——
    无关目录只计入 `scanned`（已检查位置），不再占列表。
  - `src/renderer/App.tsx` + `styles.css`：面板改名「目标检查」，位置清单收进 `<details>` 默认折叠。
  - `tests/integration/discover.test.ts`：补 4 项回归（含贴近 `reg query` 实际输出的样本断言）。
  - `docs/discovery.md`：补本次取证与修法。
- 命令与退出码：`npx tsc --noEmit` 0、`npx eslint .` 0、`npx vitest run` 0（7 文件 / **130 项**）、`npm run build` 0。
- 真机只读复核：`node tools/live-cli.cjs status` → 目标 1.18.29 supported，备份 original/previous 各一份。
  注：本会话沙箱已把 `reg.exe` 列入黑名单，注册表分支在此环境内不可复现，改由注入 `regRunner` 的单元测试覆盖。
- 未执行：真机 GUI 复看（需 jc 打开界面确认列表已干净）。

## 交接填写模板

每个执行 agent 提交：任务 ID、完成状态、改动文件、测试命令/退出码、证据位置、已知问题、下一任务。需要真人授权的操作单独列出，未执行测试明确写「未运行」。

## P5c：按 P0 审查 R1–R8 的修复（2026-09-11）

审查报告：`handoff/review-2026-09-11/REVIEW.md`。执行顺序按报告建议：
**先修识别 → 修备份语义与旧主题冲突 → 统一预览与可读性 → 补 GUI 闭环测试**。
没有用「把应用按钮强行启用」绕过任何一条。

### 改动文件（按问题编号）

| 问题 | 改动 |
|---|---|
| R1 | 新增 `src/core/patch/physical-fs.ts`、`src/core/patch/archive-io.ts`；`asar.ts`、`discover.ts`、`paths.ts`、`backup.ts`、`stage.ts`、`commit.ts`、`recovery.ts`、`precheck.ts`、`apply.ts` 全部切到物理 I/O；新增 `tools/electron-asar-probe.cjs`、`tools/electron-fixture-e2e.cjs`、`tools/run-electron-e2e.cjs`、`tests/integration/electron-runtime.test.ts` |
| R2 | 新增 `src/core/patch/original-evidence.ts`、`docs/original-evidence.md`；`backup.ts` 增加 `evidence` 与自动迁移（含 `meta.json.pre-r2.bak`）；`apply.ts` 用证据判定；`restore.ts` 拆出 `takeover`；`shared/ipc.ts`、`operation-service.ts`、`RestorePanel.tsx` 同步 |
| R3 | 新增 `src/core/patch/legacy-theme.ts`、`src/core/theme/tokens.ts`；`stage.ts` 撤下已确认旧主题层、拒绝来源不明层；`css.ts` 改用真实 token 映射并按 `data-variant` 处理按钮；`ApplyDialog.tsx` 披露撤下清单 |
| R4 | 新增 `src/core/theme/surfaces.ts` 的层级模型；`report.ts` 扩到 28 条并按多采样点取最差、标 `estimated`；`generate.ts` 修链接 / 主按钮 pressed / 焦点环 / 选区气泡四个真实缺陷并新增 `accentText` token；`styles.css` 修侧栏 `.06` 偏差与 `opacity:.6` |
| R5 | `surfaces.ts` 供三处共用；`css.ts` 面板改真 `rgba()`、遮罩改到图片之上；`schema.ts` 增加 `reducedTransparency`、移除 `backgroundPosition`；`Preview.tsx` 双层背景；`App.tsx` 把开关接进参数 |
| R6 | `target-service.ts` 增加 `registerDirectory()`；新增 `chooseTargetDirectory` IPC 与「重新检测 / 选择安装目录 / 多目标选择」界面；`logic.ts` 的 `GateInput` 细化禁用原因与就绪文案 |
| R7 | 新增 `src/main/services/recovery-service.ts`、`RecoveryPanel.tsx`；`src/main/index.ts` 启动 `bootstrap()`；`operation-service.ts` 增加 `recoveryGuard`；`scanAllPending` / `cleanAllStages` / 落账方向校验 |
| R8 | `tests/e2e/theme-switcher.spec.ts`（真实窗口 8 项）、`playwright.config.ts`（去掉 `--pass-with-no-tests`）、`tests/e2e/README.md`、`tools/capture-ui*.cjs`、`tools/audit.cjs`（区分交付内容与本地诊断产物） |

### 关键取证

- `tools/asar-probe-result.json`：Electron 36.9.5 下 `statSync('…/app.asar')` 返回
  `isFile=false / size=0`；`original-fs` 返回真实文件；临时打开 `process.noAsar` 可恢复物理语义且无泄漏。
- 真机 `out/renderer/index.html`：同时挂着官方主 CSS、`snow-theme.css`（标记 `data-local-theme="snowfield"`）
  与本工具的 `oc-theme-custom.css`；且 `snow-theme.css` 的内容是**粉彩主题**（原型原地覆盖过）。
  这就是「旧主题 `#root` 级 `!important` 变量盖不住新主题」的实证。
- 真机备份 `original` 与 `previous` 的哈希相同、`pristine=true` —— 证明「靠标记缺失推断原版」确实错了。

### 命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无输出 |
| `npx eslint .` | 0 | 无告警 |
| `npx vitest run tests/unit` | 0 | 4 文件 / 96 项 |
| `npx vitest run tests/integration/{discover,transaction,main-services,main-recovery}.test.ts` | 0 | 4 文件 / 51 项 |
| `npm run build` | 0 | 主进程 + renderer |
| `npx vitest run tests/integration/electron-runtime.test.ts` | 0 | 真实 Electron 主进程 35 项断言（结果文件 `tools/electron-fixture-e2e-result.json`） |
| `npx playwright test` | 0 | 8 项真实窗口闭环 |
| `npm run audit` | 0 | FAIL 0 / WARN 0（豁免清单见输出） |
| `npm run verify` | 见下 | 一条命令串起以上全部 |

### 未完成（需要 jc）

- **真机视觉走查（T64）**：当前真机安装处于「本工具 + 旧雪景主题层」的混合状态。
  下一次应用的确认框会列明会撤下的旧主题层；确认后即可回到单一主题层。
- 干净环境启动验证（T65）。
- 出厂指纹登记（可选）：按 `docs/original-evidence.md` 补录后「恢复原版」入口才会出现。

## 事故修复：OpenCode 换肤后无法启动（2026-09-11，按 handoff/startup-incident-2026-09-11/RECOVERY_AND_FIX.md）

每修一项提交一次。全程只做真机只读取证，**未对真实安装做任何写入**；
恢复脚本 Recover-OpenCode.ps1 的 -Apply 需要 jc 明确授权后才执行。

### F1 打包内容来源（commit a77f7d6、4dac142）

- 根因在源码级确认：`@electron/asar` 的 `Filesystem.insertFile` 对 ≤2MB 文件走同步快路径，
  `fs.readFileSync(归档内逻辑路径)` 相对打包进程 cwd 解析。
- 修复：新增 `pack-worker.ts` + `pack.ts`，打包隔离到专用工作进程，cwd 固定为解包根目录；
  主进程绝不临时 chdir。Electron 下走 `utilityProcess.fork`，普通 Node 走 `child_process.fork`。
- 回归 7 项：两个不同版本的 jsonfile（2838/2014 字节）重打包后各自完整；
  去重方向对调、同长度不同内容、内容相同的合法去重；仓库根 cwd（真实同名 node_modules）
  下运行不再被污染；派生真实工作进程结果一致；事故复现脚本仍复现依赖库缺陷
  （证明修复靠隔离 cwd，不是改第三方库）。
- `pack-worker.ts` 纳入 tsconfig.node.json include；`npm run verify` 调整为先 build 再集成。

### 独立缺陷：noAsar 异步窗口（commit 7eb2764）

- 旧实现 `try { return fn() } finally { 恢复 }` 在 fn 返回 Promise 时立刻恢复，
  异步期间 I/O 不受保护。改为 `await fn()`，窗口覆盖整个异步过程；嵌套调用不排队。
- 新增 6 项状态机测试：await 期间为 true、抛错恢复、并发串行化、
  外层本开则还原为开、嵌套不死锁、toggle=false 不碰进程开关。

### F2 提交前不可变校验硬门禁（commit ef4fac8）

- 新增 `archive-verify.ts`，三层互相独立的检查，任一失败都不进入 committing：
  1. `verifyIntegrity` 逐条按头部完整性字段核对（整体 hash + 4MB 分块）+ 条目边界；
  2. `findSharedOffsetConflicts` 共享 offset 必须同内容同长度（事故的直接形态）；
  3. `checkScripts` 非白名单 .js/.json 按各自语义解析
     （CJS 用 vm.Script，ESM 用 SourceTextModule、不支持就如实跳过并计数）。
- 基线：首次接管时把当时的非白名单条目基线写进备份目录，之后每次应用逐条比对；
  白名单条目不进基线。
- `verifyPackedResult`：重打包结果用独立读取器逐条核对（完整性、共享 offset、
  unpacked 集合、条目集合、非白名单与基线一致、白名单等于预期新内容）。
- 新增错误码 `ARCHIVE_CORRUPT` / `ARCHIVE_VERIFY_FAILED`，错误信息列出具体路径。
- 新增 13 项回归，包括事故形态「截断 CJS 且 hash 自洽 —— 完整性自检绿灯但解析拦下」
  与端到端「损坏输入不能走到 applied 且目标 hash 不变」。
- 顺带修正 `scanArchive` 对 ASAR 头部布局的解析
  （[u32=4][u32=头 pickle 大小][u32=载荷长度][u32=JSON 长度][JSON]）。

### F3 备份健康标记（commit 832f30e）

- 备份记录新增 `health`（known-healthy / unverified / known-bad），旧记录迁移补齐。
- `verifyBackupHealth` 对备份归档本身跑完整性 + 脚本解析并写回元数据。
- restore 在写安装前查健康度：known-bad 一律拒绝（新错误码 `BACKUP_UNHEALTHY`）。
- apply 在硬门禁通过后把两份新备份如实标记为 known-healthy。
- 恢复面板按健康状态展示，known-bad 的条目不显示恢复按钮并说明原因。
- 新增 3 项回归。

### F4 重新验收（commit a214ed6）

真实 Electron 验收抓到两处新问题并当场修正：
1. `archive-verify.ts` 最初用了被包装的 `node:fs`，`.asar` 路径被当虚拟目录直接 ENOENT
   （与事故 R1 同源）→ 全部切到 physical-fs。
2. `utilityProcess` 子进程没有 `process.send`，用的是 `process.parentPort`；
   worker 入口守卫此前把它当成「被直接执行」而以 code=2 退出 → 兼容两种通道。

**最终验收结果**：
- 真实 Electron 主进程（utilityProcess 打包 + 三层门禁 + 基线比对 + 恢复闭环）：**35/35**
- Playwright 真实窗口闭环：**8/8**
- 单元 + 集成：**186/186**
- `npm run lint` 0、`npm run audit` FAIL 0

### F0 / F4 待 jc

- **恢复安装**：`Recover-OpenCode.ps1 -Apply` 需要明确授权。恢复候选是 10:15 的首次接管前快照
  （`1c53ca…`，jsonfile 语法通过），不是出厂原版。
- 修复后的工具对当前损坏安装的行为：三层门禁会拒绝应用
  （与首次接管基线不一致：jsonfile 被截断、semver/range.bnf 不同），
  界面会给出「请先用恢复入口回到接管时的状态」。这是有意为之的 F0 冻结。
- `release3/` 是事故前的构建，**已过期**；重新发布前必须 `npm run dist` 重建，
  并用 `npm run verify:package` 重新核对。

## 恢复安装执行（2026-09-11，jc 授权）

- 6 个僵死的 OpenCode.exe 已关闭；`Recover-OpenCode.ps1 -Apply` 成功，
  恢复后归档 `1c53ca24…`，损坏归档保留为 `app.asar.failed-218e45ca….bak`。
- 恢复后体检 6/6（`tools/post-restore-health.cjs`），过程中发现并修正校验器三处误报
  （空文件共享 offset、顶层 return、行中 export），详见事故目录 progress.md。
- 待 jc：手动启动 OpenCode 验证界面、会话与终端；theme-switcher 实例里的待恢复事务
  如有提示，在界面里按磁盘事实落账即可。
