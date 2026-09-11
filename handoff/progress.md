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

## 交接填写模板

每个执行 agent 提交：任务 ID、完成状态、改动文件、测试命令/退出码、证据位置、已知问题、下一任务。需要真人授权的操作单独列出，未执行测试明确写「未运行」。
