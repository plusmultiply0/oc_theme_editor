# Alpha 发布收尾 · 执行状态记录

计划：`ALPHA_IMPLEMENTATION_PLAN.md`（本目录）。方案编写完成不代表任务完成；
本表由实施者按实际执行填写：每步填命令、退出码、证据、提交/来源，未执行保持未执行。

| 阶段 | 状态 | 来源提交/buildId | 命令与退出码 | 证据位置 | 负责人/时间 |
|---|---|---|---|---|---|
| P0 基线与保护 | **完成**（无代码改动，故无独立提交） | 基线 `eed1f45` | `git log`/`git status` → 0；`node tools/candidate-manifest.cjs check` → 0 | 下方「P0 明细」；`archive/out-871703d-before-refresh.tar.gz` | agent / 2026-09-13 22:2x |
| P1 清单规范及真实调用测试 | **完成** | 基线 `eed1f45` | `tsc --noEmit` → 0；`eslint .` → 0；`node tools/r5-run-suite.cjs run tests/unit/verify-release.test.ts` → 0（23 项） | 下方「P1 明细」 | agent / 2026-09-14 07:5x |
| P2 新登记与冻结分离 | **完成** | 基线 `eed1f45` | `npx tsc --noEmit` → 0；`npx eslint .` → 0；`node tools/test-release-gate.cjs` → 0（含缺 manifest 失败关闭场景）；全量 `r5-run-suite run` → 0（26 文件 / 346 项）；`candidate-manifest.test.ts` 14 项 | 下方「P2 明细」 | agent / 2026-09-14 08:3x |
| P3 完整发布链与双重校验 | **完成** | 基线 `eed1f45` | `npx tsc --noEmit` → 0；`npx eslint .` → 0；`node tools/test-release-gate.cjs` → 0（71 项）；`vitest run tests/unit` → 0（11 文件 / 174 项）；`tests/integration/candidate-manifest.test.ts` → 14 项通过；`discover+main-services+electron-runtime` → 0（29 项） | 下方「P3 明细」；`RUNBOOK.md` | agent / 2026-09-14 10:5x |
| P4 新候选构建与GUI冒烟 | **阻塞**（`已实现但未整链验证` + `完整测试有基础设施错误`；未产出候选） | 当前 HEAD `55ba0e4`；上次构建源码来源 `5689cf7` | `node tools/release-build.cjs build 20260914-alpha1-p3full` → **1**（typecheck 0 / lint 0 / test:unit 0 / **test:integration 1** → `STOPPED at test:integration`）；受控并发复跑 → 15 文件/172 项通过但**仍有 1 个 RPC 错误、exit 1** | 下方「P4 明细」；**`P4-BLOCKERS-DIAGNOSIS.md`**；**`diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`**；`node_modules/.cache/ots-test-logs/` | agent / 2026-09-14 12:0x |
| P5 真实安装闭环 | 等待当次授权，未执行 | — | — | — | — |
| P6 材料与GO/NO-GO | 待执行 | — | — | — | — |

## P0 明细（2026-09-13）

- **基线提交**：`eed1f45`（master，提交主题「验收记录补充第二轮审查修复 S1–S6…」）。
- **工作树**：仅 3 个未跟踪目录 `handoff/alpha-finalization-plan-2026-09-13/`、`handoff/review-2026-09-13-r2/`、`handoff/review-2026-09-13/`（计划与取证文档）；已跟踪文件无改动。未使用 `git reset --hard`、批量还原或强制删除。
- **旧候选身份（留存，禁止冒充最新）**：schema `candidate-manifest/1`，buildId `manual-repack-20260912`，sourceCommit `871703d`；exe `99c02d67…` / asar `7ca56cc5…` / zip `92126171…`（完整值见 `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.sha256.txt`）。`candidate-manifest.cjs check` 通过（磁盘与登记一致）。
- **out/ 保护**：`build:main` 会 `rmSync('out')`（`package.json:35`），故先把旧构建输出归档为 `archive/out-871703d-before-refresh.tar.gz`（173540 bytes，61 条目 = 50 文件 + 11 目录，可用 `tar -xzf` 原样恢复）。归档不参与源码提交。
- **候选/历史目录**：`candidate-*/`、`candidate-*.zip`、`release*/` 均在 `.gitignore` 内；本轮不删除、不重命名、不占位覆盖。`win-unpacked`、`win-unpacked-fresh`、`win-unpacked.new` 全部保留。
- **已知阻断**（本轮待修）：B1 清单路径命名不一致（磁盘清单 `main/…` vs 归档/必需模块 `out/main/…`，真实调用下 50 缺 / 50 多）；B2 登记与源码冻结冲突（根 manifest 被 Git 跟踪 → 登记即判脏，提交又换 HEAD）。另须保留 `verify-package` 的包可用性检查，不得让 `verify-release` 把它顶掉。
- **环境注记**：本会话 shell 的 `PATH` 缺 `/usr/bin`（`dirname`/`head` 不可用），执行命令前显式 `export PATH="/usr/bin:/bin:$PATH"`；属命令环境问题，非仓库缺陷。

## P1 明细（2026-09-14）

**修复 B1（清单路径命名不一致）**：`outManifestOfDir(outDir)` 的参数固定为 **out 目录本身**，
返回键统一加一次 `out/` 前缀，与 `outManifestOfAsar` 键、`REQUIRED_MODULES` 采用同一规范。

- 新增 `validateOutKey()`：拒绝反斜杠分隔符、绝对路径/盘符、不以 `out/` 开头、`out/out/` 重复前缀、空段与 `./..` 越界段。
- `outManifestOfDir` 现在对空清单、非法键、重复键**直接抛错**，不再静默产出不一致清单；`candidate-manifest.cjs` 捕获并给出明确失败信息。
- 测试改为**真实调用**：`outManifestOfDir(fixture/out)` 与同内容合成 ASAR 比较，不再只对手写 manifest 对象。
- 真实数据验收：本地 `out/`（50 文件）与旧候选 asar 比较 → **磁盘 50 键 / 归档 50 键，missing 0 / extra 0 / changed 0**（修复前为 50 缺 / 50 多、三个图片模块全判缺失）。
- `tsc --noEmit` → 0；`eslint .` → 0；`verify-release.test.ts` 23 项通过（含正例 3 项、B1 回归 2 项、越界/重复/空清单/中文空格路径负例）。

## P2 明细（2026-09-14）

**修复 B2（登记与源码冻结冲突）**：候选身份登记不再写回仓库根的被跟踪文件，
改为写到 `candidate-<buildId>/candidate-manifest.json`（落在 `.gitignore` 的
`candidate-*/` 忽略范围内），从而「登记」不弄脏工作树、也不改变 HEAD。

- `candidate-manifest.cjs` 升级到 schema `candidate-manifest/3`：
  - `register` 必须显式 `--manifest <路径>`，缺则明确失败（不再回落根目录历史 manifest）；
  - 默认**拒绝覆盖**已有登记，仅在 `--force` 时允许；
  - 严格源码冻结判定 `classifyWorktree(porcelain)`：把工作树状态分成
    `trackedDirty`（必须拒绝）/ `untrackedCode`（新增未跟踪源码或脚本，必须拒绝，
    不能统一忽略 `??`）/ `ignored`（豁免前缀 `candidate-`、`release`、`out/`、
    `dist/`、`node_modules/`、`backups/`、`handoff/`、`.workbuddy/`、`test-results/`、
    `playwright-report/` + 豁免文件 `build-record.json`）；Git 查询失败直接报错
    （绝不把空字符串当成「干净」）。
  - `register` 必须 `--build-record <路径>`，校验 `sourceCommit == HEAD`、
    `version == package.json`、`lockfileSha256` 与 `out` 清单四项一致；
    manifest 内记录 `buildRecord.path` 与 `sha256`。
  - 新增 `--root <仓库根>`，使命令级集成测试能在独立小型 Git 夹具里真实执行。
- `verify-release.cjs`：`--manifest` 必填；接受 `/3` 与 `/2`（过渡兼容，拒绝 `/1`）；
  新增锁文件 hash、构建记录 hash 一致性检查；新增 zip 深度完整性校验
  `deepVerifyZip`（读本地文件头、校验 CRC、拒绝越界/绝对路径/重复条目）。
- `release-gate.sh`：绑定预检加入 `GATE_MANIFEST`（缺任一即 `exit 2`、一步不跑），
  最后一步 `verify:package` 带全 `--manifest/--candidate-dir/--build-id` 三元绑定。
- 测试：
  - 新增 `tests/integration/candidate-manifest.test.ts`（14 项，命令级真实调用）：
    正例「小夹具真实注册 → Git 仍干净、HEAD 未变」+ 覆盖脏源码、未跟踪源码、
    豁免路径、Git 不可用、缺 `--manifest`、缺构建记录、过期 sourceCommit、
    锁文件不符、out 不一致、空/旧记录、缺候选目录、默认拒覆盖、`--force` 覆盖。
  - `tests/unit/verify-release.test.ts` 增补 `/3` 接受、`deepVerifyZip` 三例。
  - `tools/test-release-gate.cjs` 增补缺 `GATE_MANIFEST` 的失败关闭场景，
    全绿断言改为校验 `--manifest` 三元绑定。
- 验收命令与结果：`tsc --noEmit` → 0；`eslint .` → 0（已消除新增测试的
  `require()` 违规，改用 `createRequire`/顶层 `spawnSync`）；`test-release-gate.cjs`
  → 0；全量套件 → **26 文件 / 346 项通过**。
- 注记：全量套件首次运行曾出现一次 vitest worker `Timeout calling "onTaskUpdate"`
  非确定性报错（`candidate-manifest.test.ts` 62s 的 Git 子进程高压导致），
  测试本身 346 项全过；立即复跑一次干净通过。按计划要求登记为**已知不确定性**，
  不作为通过证据，也不掩盖。

## P3 明细（2026-09-14）

**新增统一发布编排入口 `tools/release-build.cjs`**（唯一构建/打包一次的链）：

- **两种模式**：`build <buildId>`（完整链：冻结预检 → typecheck → lint →
  test:unit → test:integration → build → test:e2e → test:e2e:electron → audit →
  dist → verify-package → zip → register → verify:release → 构建后冻结复核）；
  `verify <buildId>`（只读核验，不 build/dist/写产物，供真实闭环后再次核验）。
  `buildId` 省略时自动生成 `<时间>-<源码短SHA>-<随机后缀>`，禁止只用日期。
- **只构建一次**：`dist` 步骤直接调用 `electron-builder`（**不用 `npm run dist`**，
  后者内部会再跑一次 `npm run build`），并用 `--config.directories.output` 把输出
  固定到本次唯一目录 `candidate-<buildId>/builder-out`，再收拢到
  `candidate-<buildId>/win-unpacked`；杜绝「只给 verify 传新目录、dist 仍写旧目录」。
- **manifest 在打包与 zip 之后生成**：zip 只从候选目录内容生成（排除 manifest/
  构建记录，避免自引用）；登记绑定 `build-record.json`（含各步退出码、sourceCommit、
  version、锁文件 hash、out 清单）。候选目录已存在即拒绝覆盖。
- **双职责保留**：`verify-package`（结构/依赖可用性：入口、unpacked 实体、依赖完整性、
  隐私扫描、包内 sharp 真实出图）与 `verify-release`（来源/内容/zip 绑定：buildId、
  候选目录、sourceCommit、锁文件与构建记录 hash、out 清单逐文件、zip 逐条目+深度完整性）
  分别执行、名称分别显示；`--no-identity` 不得作为发布通过捷径。
- **测试临时目录策略接入实际步骤**：test:unit / test:integration 不再直接调
  `npm run test:integration`，而是走 `tools/r5-run-suite.cjs`（注入项目内安全 TEMP/TMP），
  可用 `OTS_TEST_TMP` 覆盖，不硬编码个人路径。
- **GUI 冒烟环境**：`tools/smoke-packaged.ts` 已 `delete env.ELECTRON_RUN_AS_NODE`
  （不修改系统全局变量、不关闭 sandbox）；包内依赖探针用 Electron Node 模式。
- `tools/release-gate.sh` 收敛为**薄入口**：只做绑定预检（verify 模式缺
  GATE_MANIFEST/GATE_CANDIDATE_DIR/GATE_BUILD_ID 即 `exit 2`）与日志落盘，实质委托
  `release-build.cjs`；退出码为第一个失败步骤的退出码。
- `tools/verify-package.cjs` 新增 `--manifest <路径>` 显式绑定（发布链用），保留默认
  根登记的历史兼容；实机验证：旧候选 + `--manifest candidate-manifest.json` → 40 项核对 0 失败。
- `package.json` 新增脚本：`release:build` / `release:verify` / `release:gate`。

**测试**：`tools/test-release-gate.cjs` 重写为编排链路行为测试（71 项断言，0 失败）：
以**仅测试**的 `OTS_STEP_STUB`（JSON 步骤→退出码）在独立 Git 夹具里驱动编排器，
覆盖冻结预检（脏源码/未跟踪源码）、拒绝覆盖、**逐步失败**（typecheck/lint/test:unit/
test:integration/build/audit/dist/zip/verify-package/register/verify:release —— 退出码
保留、后续不执行、无 ALL_GREEN、有 STOPPED）、全绿路径（步骤顺序与预期完全一致）、
verify 模式缺 buildId → exit 2、manifest 缺失 → 失败关闭不构建、未知模式 → exit 2；
并清除继承的 `GATE_*` 绑定变量后再按场景注入。
`verify-release.test.ts` 27 项通过（含 P1/P2/P3 新增用例）。

**已知环境注记**：本机自动化 shell 的 `PATH` 偶发缺 `/usr/bin`（`dirname`/`ls` 不可用）
且 `r5-run-suite.cjs` 在该 shell 下被 SIGTERM；改用直接调用
`node node_modules/vitest/vitest.mjs run <dir>` 并显式注入 TEMP/TMP 后正常。
属命令环境问题，非仓库缺陷。

## 新候选身份（P4 生成中）

- 构建工具链：Node `v22.22.2`；electron `^36.4.0`；electron-builder `^26.0.12`。
- 锁文件 `package-lock.json` sha256：`b1e390a8adb83aec8fd81fa7deed94cb3cf6d9b7ceb00654e8c772b48de74768`。
- sourceCommit：`5689cf7`（P3 提交，源码冻结）
- buildId：`20260914-alpha1-p3full`
- manifest绝对路径：`candidate-20260914-alpha1-p3full/candidate-manifest.json`（生成中）
- 候选目录/zip：`candidate-20260914-alpha1-p3full/win-unpacked` / `candidate-20260914-alpha1-p3full.zip`
- exe/app.asar/zip SHA256：待填
- 锁文件/构建记录hash：待填
- 测试数量/失败数：待填
- 包内sharp及GUI启动：待验证
- 用户真实安装操作授权：未取得
- 真实应用/重启/恢复：未验证
- A6：用户决定跳过，未验证；不得填通过
- 发布渠道与外部操作授权：未取得
- 结论：NO-GO，等待 P4/P5 结果

## P4 明细（2026-09-14）

**第 1 次构建尝试：在 `test:integration` 停止，未产出候选（符合预期失败即停）。**

- 命令：`node tools/release-build.cjs build 20260914-alpha1-p3full`；start `5689cf7`，
  工作树冻结（仅 `handoff/...` 未跟踪，属豁免）；总耗时 8m42s。
- 逐步退出码：`typecheck = 0`(16.0s) → `lint = 0`(94.7s) → `test:unit = 0`(27.7s，174 项全过)
  → **`test:integration = 1`**(379.1s) → `STOPPED at test:integration`；**无 `ALL_GREEN`**，
  未执行 build/e2e/audit/dist/smoke/verify-package/zip/register/verify:release，无半成品候选。
- 集成失败形态：8 文件 / 16 项失败，**绝大多数是资源性超时**——
  `Test timed out in 30000ms`、`Hook timed out in 30000ms`、
  `[vitest-worker]: Timeout calling "onTaskUpdate"`；单文件耗时异常膨胀
  （`candidate-manifest.test.ts` 366s、`transaction.test.ts` 279s、`main-services.test.ts` 173s，
  正常全套约 1–2 分钟）。
- 唯一断言式失败：`transaction.test.ts > 正常闭环（T34–T42） > 重复应用同一主题为 no-op，不产生写入`
  → `AssertionError: expected false to be true`。**需与并行挤压区分**，待串行复测定性。
- 唯一非超时 I/O 错误：`image-content-fixed.test.ts` →
  `EPERM: operation not permitted, open '...\ots-test-tmp\ots-a2-src-edbT5d\wallpaper.jfif'`
  → 临时目录文件被占用/被安全软件或索引进程锁定（环境性，非逻辑缺陷）。
- **判据（为何倾向环境性而非代码回归）**：
  1. 同一次运行的 `test:unit` 里 P2 引入的 `deepVerifyZip` / `verify-release` **174 项全绿**；
  2. 集成里失败的 `candidate-manifest.test.ts` 正是 P2 已独立验证通过的套件（14 项），
     此处 3 项为纯超时，无断言差异；
  3. P3 提交仅改 `tools/release-build.cjs` / `release-gate.sh` / `verify-package.cjs` /
     `package.json` / 测试，**未触碰 `src/` 下任何图片或事务代码**。
- **处置**：不改源码、不放宽阈值、不把超时当通过。先以
  `--pool=forks --poolOptions.forks.singleFork --no-file-parallelism` 串行复测
  已失败套件，以区分「并行资源挤压」与「真实回归」；结果记入下表后再决定是否重跑整条链。

**定性结论（串行复测后）：并行竞争导致的假失败，不是代码回归。**

| 复测对象 | 模式 | 结果 | 说明 |
|---|---|---|---|
| `transaction.test.ts`（含首次失败的 4 项） | 单独串行 | **EXIT=0，29/29 全过**，无 Unhandled Error | 关键证据：并行下 `expected false to be true` 的那一项，串行下通过 |
| `candidate-manifest.test.ts` | 单独串行 | **14/14 全过**（189s） | 但该次运行 vitest 报 1 个 `onTaskUpdate` Unhandled Error → 退出码 1 |
| 全量 `tests/integration` | 串行 | 见下一次记录 | 待完成 |

- **`onTaskUpdate` 超时的性质**：它是 vitest worker 与主进程间的 RPC 心跳超时，
  **独立于断言结果**，在长耗时（单项 12–19s、单文件 130–366s）的高负载下触发；
  它会让退出码变 1，但**没有任何被测逻辑断言失败**。
- **为什么不是回归**：① 串行下同样用例全过；② P3 提交未触碰 `src/` 图片/事务代码；
  ③ 同一次运行的 `test:unit` 174 项全绿（含 P2 新增的 `deepVerifyZip`）。
- **对发布链的影响**：若集成测试保持默认并行，在高负载机器上会**持续假失败**，
  整条链永远到不了 `ALL_GREEN`。需在编排器里让集成测试走可控的串行/并发上限，
  并在文档中说明该选择的理由（不得靠删除或跳过用例来「变绿」）。

| 全量 `tests/integration` | 串行（单 fork，经 `r5-run-suite.cjs`） | **0 项断言失败**；退出码 1（仅 Unhandled Error） | `Tests 84 passed (84)`，逐项全 ✓；`Errors 1 error: onTaskUpdate`；376.15s |

- **决定性结论**：串行下**没有任何一项断言失败**——并行时报的 16 项全部消失。
  → 并行失败包含超时、访问被拒与首次应用失败；**受控复测未复现业务断言失败**，
  具体环境来源待证实。（**复诊更正**：原「100% 假失败」说法证据不足，见下方「复诊纠偏」）
- **唯一遗留问题**：`onTaskUpdate` **任务更新 RPC** 超时（`candidate-manifest.test.ts` 单文件 214s，
  其 14 项各 10.3–26.5s，每项反复 spawn `git.exe`）。它与 `testTimeout`/`hookTimeout` 不同层，
  独立于断言，但把退出码拉成 1 → **当前到不了 `ALL_GREEN`**（可修，非不可逆）。
- 汇总行 `Test Files 7 passed (15)` / `Tests 84 passed (84)` 不一致，
  **复诊更正**：说明**还有 8 个文件未被完整计入**，不能据此断言「实际都跑完了」。

**~~另发现一处真实潜在 bug~~ —— 复诊判定撤销（误读）**：
`tools/candidate-manifest.cjs:283` 的 `git log -1 --format=%s <sourceCommit>` 用 `cwd: ROOT`，
但 `:40` 声明的是 `let ROOT`、`:134` `applyRoot` 执行 `ROOT = r`，`register` 先 `applyRoot`
再用 `ROOT` → **`ROOT` 就是 `--root` 目标根**。端到端实测 `sourceCommitSubject='fixture init'`
与夹具一致。**不安排代码修复**。

**P4 阻塞点（复诊后：2 项成立）**：
1. `onTaskUpdate` 任务更新 RPC 超时（发布链阻塞主因；优先修 worker 同步阻塞）；
2. `image-content-fixed` 的 `EPERM`（环境相关访问失败，**原因未定**，不指认持锁者）。
（原第 3 项 `--root` 缺陷已撤销。）

**处置（用户 2026-09-14 决定）：本轮只出诊断，不改代码。**
- 未修编排器串行策略、未调 vitest RPC 超时、未修 `candidate-manifest.cjs:283`
  （用户明确「记入清单，本轮不修」）。
- 未删/未跳过任何用例、未放宽任何阈值。
- **零源码改动**；当时工作树冻结在 `5689cf7`（仅 `handoff/` 路径未跟踪/改动，属豁免）。
- 完整诊断见同目录 **`P4-BLOCKERS-DIAGNOSIS.md`**。

### P4 复诊纠偏（2026-09-14 复诊轮）

复诊报告：`diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`（本轮仅诊断，未改业务源码）。

| 原判定 | 复诊结论 |
|---|---|
| 「16 项失败**全部**是资源竞争假失败」 | **证据不足，收窄**：受控复测**未复现**业务断言失败，来源待证实（原串行汇总仅 `7 passed (15)`，8 文件未完整计入） |
| 「发布链**永远**到不了 `ALL_GREEN`」 | **收窄为**当前阻塞，可由任务 A/B 解决 |
| 「`onTaskUpdate` 是独立心跳」 | **更正**：是**任务更新 RPC** 超时（默认 60s），与 `testTimeout`/`hookTimeout` 不同层；项目侧无对应配置项，**不得凭空造字段或改 `node_modules`** |
| 「EPERM 是安全软件持锁」 | **更正**：无持锁者证据，改述「环境相关访问失败，原因未定」 |
| 「no-op 用例失败 = no-op 逻辑问题」 | **更正**：失败在**第一次 `applyTheme` 的 `success=false`**（`transaction.test.ts:160`），未进入 no-op 判定；断言未记录 `error.code/detail` |
| 「`candidate-manifest.cjs:283` `--root` 契约缺陷」 | **判定撤销（误读）**：`:40` 声明 `let ROOT`、`:134` `applyRoot` 执行 `ROOT=r`，实测 `sourceCommitSubject='fixture init'` 与夹具一致 —— **不安排修复** |

**复诊新增阻塞判定**：优先修复**测试 worker 侧同步子进程阻塞**
（`candidate-manifest.test.ts` 大量 `execFileSync`/`spawnSync`，等待期间事件循环无法处理 IPC
→ `onTaskUpdate` 回执超时）。本轮观察：独立候选套件 42.10s 无 RPC 错误；
完整单 worker 集成中 72.372s、断言全过但出现 60s RPC 错误。
这是**高优先级假说，非已证明唯一根因**；异步化后若仍报错须继续调查 IPC/reporter/环境。

**本轮发现的新缺口（代码审查确认的后续风险，非本轮真实构建复现）**：
`--skip-e2e` / `--skip-gui` 省略的步骤不进入 build-record，编排器仍打印 `ALL_GREEN`，
`verify-release` 只核对 build-record hash、不检查发布必需步骤是否执行
→ 「跳过检查仍可发布」。已登记为任务 C。

**下一阶段（任务 A–F，待授权执行）**：
A 测试 worker 异步化；B 受控并发 + 完整性检查接入发布链；C 发布资格与必需步骤契约；
D GUI 冒烟真实校验；E 文档纠偏（本轮进行）；F 恢复 P4 重跑（授权关口）。

## 新增接口及RUNBOOK交付

- [x] 记录实际新增脚本及参数：
  - `tools/release-build.cjs`：`build [buildId] [--root] [--skip-e2e] [--skip-gui]`、
    `verify <buildId> [--root]`。
  - `tools/verify-release.cjs`：`--manifest`（必填）/`--candidate-dir`/`--build-id`/
    `--source-commit`/`--skip-deep-zip`。
  - `tools/verify-package.cjs`：`[候选目录] [--manifest <路径>] [--no-identity]`。
  - `tools/candidate-manifest.cjs`：`register --manifest <路径> --candidate-dir <目录>
    --build-record <json> [--zip <zip>] [--build-id <id>] [--force] [--root <仓库根>]`；
    `check/show --manifest <路径>`。
  - `tools/release-gate.sh`：`build|verify [buildId]`（薄入口）。
  - 测试专用：`OTS_STEP_STUB`（编排器步骤桩，仅测试）、`OTS_NODE_BIN`（测试注入 node 桩）、
    `OTS_TEST_TMP`（测试临时根覆盖）。
- [x] 补 `RUNBOOK.md` 完整命令（代码测试 / 构建登记 / 只读核验 / 依赖检查 / GUI 环境 /
  授权关口 / 失败日志 / 已知限制），成功与失败路径均可照做；Windows shell 明确用已安装
  Git Bash（`D:\SOFTWARE\Git\bin\bash.exe`），不依赖 PATH 里的 WSL bash。
- [ ] 按实际结果更新兼容范围、许可、隐私及恢复说明（P6 处理）。

## 异常与处理

逐条记录：发生阶段、原始错误码、是否影响用户安装、已采取的安全操作、剩余事项。不得省略失败，也不得把mock成功标为真实安装通过。
