# Alpha 发布收尾 · 执行状态记录

计划：`ALPHA_IMPLEMENTATION_PLAN.md`（本目录）。方案编写完成不代表任务完成；
本表由实施者按实际执行填写：每步填命令、退出码、证据、提交/来源，未执行保持未执行。

| 阶段 | 状态 | 来源提交/buildId | 命令与退出码 | 证据位置 | 负责人/时间 |
|---|---|---|---|---|---|
| P0 基线与保护 | **完成**（无代码改动，故无独立提交） | 基线 `eed1f45` | `git log`/`git status` → 0；`node tools/candidate-manifest.cjs check` → 0 | 下方「P0 明细」；`archive/out-871703d-before-refresh.tar.gz` | agent / 2026-09-13 22:2x |
| P1 清单规范及真实调用测试 | **完成** | 基线 `eed1f45` | `tsc --noEmit` → 0；`eslint .` → 0；`node tools/r5-run-suite.cjs run tests/unit/verify-release.test.ts` → 0（23 项） | 下方「P1 明细」 | agent / 2026-09-14 07:5x |
| P2 新登记与冻结分离 | **完成** | 基线 `eed1f45` | `npx tsc --noEmit` → 0；`npx eslint .` → 0；`node tools/test-release-gate.cjs` → 0（含缺 manifest 失败关闭场景）；全量 `r5-run-suite run` → 0（26 文件 / 346 项）；`candidate-manifest.test.ts` 14 项 | 下方「P2 明细」 | agent / 2026-09-14 08:3x |
| P3 完整发布链与双重校验 | **完成** | 基线 `eed1f45` | `npx tsc --noEmit` → 0；`npx eslint .` → 0；`node tools/test-release-gate.cjs` → 0（71 项）；`vitest run tests/unit` → 0（11 文件 / 174 项）；`tests/integration/candidate-manifest.test.ts` → 14 项通过；`discover+main-services+electron-runtime` → 0（29 项） | 下方「P3 明细」；`RUNBOOK.md` | agent / 2026-09-14 10:5x |
| P4 新候选构建与GUI冒烟 | **阻塞**（`候选工程验证通过` 的前半段已确认：整链跑到 e2e；**停因是环境文件占用，非 A–D 缺陷**；未产出候选） | 当前 HEAD `49134ae`；本次构建源码来源 `49134ae` | `node tools/release-build.cjs build 20260914-alpha1-p4full` → **1**，逐步：`typecheck 0` / `lint 0` / `test:unit 0`（13 文件/200 项）/ **`test:integration 0`（15 文件/173 项，104.9s，Unhandled Error 0、无 RPC 错误）** / `build 0` / **`test:e2e 1`（3 failed / 13 passed）→ `STOPPED at test:e2e`** | 下方「P4 整链重跑明细」；`P4-BLOCKERS-DIAGNOSIS.md`；`diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`；`.workbuddy/p4full-build.log` | agent / 2026-09-14 13:5x |
| P5 真实安装闭环 | 等待当次授权，未执行 | — | — | — | — |
| P6 材料与GO/NO-GO | 待执行 | — | — | — | — |

## 任务 A–E 实施登记（2026-09-14，按 `diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`）

每项**独立提交**；状态词按五档约定（`已实现但未整链验证` / `定向测试通过` / `完整测试有基础设施错误` / `候选工程验证通过` / `真实闭环通过`）。

| 任务 | 提交 | 状态 | 证据 |
|---|---|---|---|
| A 测试 worker 异步化 | `5679c06` | **定向测试通过** | 候选套件 15/15、exit 0、Unhandled Error 0（44.93s）；完整集成连跑两次均 exit 0（15 文件/173 项）；最大事件循环延迟 12ms（RPC 上限 60000ms） |
| B 受控并发 + 完整性检查 | `602708f` | **定向测试通过** | `unit` 11 文件/179 项 exit 0；`integration`（`--pool=forks --maxWorkers=1 --no-file-parallelism`）15 文件/173 项 exit 0、Unhandled Error 0（54.68s）；包装层测试 10 项全过（含完整性负例 5 项） |
| C 发布资格与必需步骤契约 | `076a38e` | **定向测试通过** | 新增 `tools/release-eligibility.cjs`（唯一事实来源）；`test-release-gate.cjs` 全部通过（含 skip-gui/skip-e2e/skipped/非 0/测试注入/缺字段 六类负例全被拒） |
| D GUI 冒烟真实校验 | `492322b` | **定向测试通过**（真实 exe 冒烟待整链） | 冒烟改为 `.cjs` 纯 node 运行（去掉未声明的 `npx tsx`）；四条界面断言 + `--self-test-negative`；`smoke-packaged.test.ts` 9 项全过；`smoke:gui` 失败传播入闸门测试 |
| E 文档与阶段状态纠偏 | `673b39b`（首轮）+ 本表更新 | **完成** | 见「P4 复诊纠偏」与 `RUNBOOK.md` 前提块 |

**关键限定**：以上均为**定向测试**结果，不等于整链通过。任务 F 的整链重跑见下节；在整链 `ALL_GREEN` 之前，P4 仍为**阻塞**，不得据定向结果宣称发布资格。

## 复审修复矩阵（按提交/工作树标识划分，2026-09-14 → 09-15）

**用途**：把「哪份代码上做了什么修复、证据是什么」与「旧提交上跑出的历史事实」分开登记。
旧表（P0–P4、任务 A–E）的**结论不因本表而改写**；本表只追加，不覆写。
「门禁」= `node tools/test-release-gate.cjs`（编排器**行为**测试，含大量桩注入，
**不等于真实整链产物已产出**）；日志在 `node_modules/.gate-log-*.txt`（**不入库**）。

| 编号 | 提交 | 主题 | 验证 | 状态 |
|---|---|---|---|---|
| R1+R2 | `4ddf644` | 发布生命周期去自引用（build-record/2 登记前事实 + release-receipt/1 完成回执）；资格校验改由共享校验器重算 | 门禁 160 项全过；unit 24/24、integration 19/19（140s、0 Unhandled） | 已提交 |
| R3 | `33925dd` | 完整性检查升级为**完成集合相等**的机器校验（预期集合 + JSON 结果 + runId 绑定）；顺带修 `--require-release-eligibility` 从未被解析、`gitsha(root)` 签名、asar 异步包装、zip 条目分隔符 | 门禁 160 项全过 | 已提交 |
| R4 | `a794c08` | `build` 提前到 `test:integration` 之前（集成与打包共用同一份 out）；删除 `prepare:out` 前置；打包前 out 快照复核 | 门禁 167 项全过（含新场景 5b3/5b4） | 已提交 |
| S1 | `6947483` | record↔manifest/receipt **同一次构建身份**交叉校验（共享 `checkRecordBinding`；锁文件 hash 必填） | 门禁 179 项全过（含 5e 负例翻转、9b 手工改名拒绝、5e-fn 函数级负例） | 已提交 |
| S2 | 未提交 | core 与发布级成功标记分离（`CORE_VERIFY_GREEN` / `RELEASE_GREEN`）；`ALL_GREEN` 仅在发布级只读终检真实退出 0 后输出；shell 不再自行补标记 | 门禁验证中 | 进行中 |
| S3 | `2cc2e31` | 机器报告 schema：缺失/非数组 `assertionResults` 失败关闭（不兜底成零项成功）；零项文件与全零报告拒绝；计数类型校验；suite 级 pending/failed 必须为 0 | 门禁 194 项全过（新增 9.18–9.23 六类畸形报告负例）；真实严格入口 212/212 通过 | 已提交 |
| S4 | `b146d87` | 参数解析：两段式报告参数**连值一起剔除**（过滤条件不被污染）；strict 默认禁 skip（与纯函数一致），放行需显式 `--allow-skip` | 门禁 204 项全过（新增 9.24–9.28） | 已提交 |
| S5 | 进行中 | 打包方式必须显式声明（取消 `manual-repack` 兜底默认）；`reproducibleBuild` 语义文档化 | 门禁验证中 | 进行中 |
| S6 | 进行中 | 文档纠偏：修复矩阵、RUNBOOK 同步、删除「换会话清计数 / 关防护 / 全目录信任」类建议 | 文档核对 | 进行中 |

**基建（非产品）**：门禁夹具清理原为进程内 `fs.rmSync`，本机存在间歇性文件锁会
**无限期阻塞**（实测 >9 分钟、CPU 增量 0、无子进程）。已改为**有界子进程删除**
（超时 20s，失败只告警）——夹具均为 `mkdtemp` 唯一目录，残留不污染断言。

## 任务 F · 整链重跑明细（2026-09-14）

**命令**：`node tools/release-build.cjs build 20260914-alpha1-p4full`（发布模式：不加
`--skip-gui`/`--skip-e2e`、未注入 `OTS_STEP_STUB`/`OTS_NODE_BIN`；源码提交 `49134ae`）。

| 步骤 | 退出码 | 耗时 | 关键证据 |
|---|---|---|---|
| 冻结预检 | 0 | — | 工作树干净（仅 `handoff/` 豁免项） |
| typecheck | 0 | 4.9s | — |
| lint | 0 | 4.4s | — |
| test:unit | 0 | 3.9s | 13 文件 / 200 项 |
| **test:integration** | **0** | **104.9s** | **15 文件 / 173 项，Unhandled Error 0、无 RPC 错误** —— 任务 A/B 修复在真实整链生效 |
| build | 0 | 8.8s | `out/` 生成 |
| **test:e2e** | **1** | 188.4s | **3 failed / 13 passed** → `STOPPED at test:e2e` |
| （后续步骤） | — | — | e2e 失败即停，未执行 e2e:electron/audit/dist/smoke:gui/verify-package/zip/register/verify:release |

**e2e 失败定性：单一环境根因 + 两个级联失败（非三个独立缺陷）**

1. **根因（`theme-switcher.spec.ts:210`）**：应用流程正常推进（状态依次显示
   「正在写入应用资源…」→「正在生成准备区资源（20%）」），随后**系统层文件替换被占用**：
   `目标文件被占用，替换失败请确认应用已退出后重试；安装未被修改。`
   → 属**环境相关访问失败**（本机安全软件/索引进程锁定），与 P4 诊断记录的 EPERM 同类；
   **非界面/业务逻辑缺陷**。
2. **级联 1（`:231`）**：因首次应用失败，**首次接管快照未建立** → 「恢复到首次接管时」按钮不存在。
3. **级联 2（`:239`）**：同因 → 该按钮点击超时。

**复现性**：单独复跑 `npx playwright test tests/e2e/theme-switcher.spec.ts` →
**同样 3 failed（同一条因果链）/ 5 passed**，非偶发抖动，但属环境锁定而非断言逻辑缺陷。

**任务 A–D 修复的有效性**（本整链实测）：integration 在受控并发下 173/173 全过、
**RPC 错误与 Unhandled Error 均为 0**，此前「长耗时下 `onTaskUpdate` 超时」的现象**未再出现**。

### P4-F2 修复的端到端真实验证（2026-09-14，提交 `690eea6` + `9cd840a`）

在**手工清空 `out/`** 后以发布模式重跑整链（`build 20260914-alpha1-p4f2b`），
`prepare:out` 段**真实出现**并成功补建 out，随后 `test:integration` **15 文件 / 173 项
全过、exit 0（61.2s）**——即 P4-F2 的修复在真实整链（非仅闸门测试）下生效。
（日志：`.workbuddy/p4f2b-build.log`、`.workbuddy/p4f2d-build.log`）

**次生优化（`9cd840a`）**：原 `prepare:out` 调 `npm run build:main`，而该脚本首动作是
`rmSync('out')`——但进入该分支的前提正是 `out/` 不存在，该删除必为空操作。
改为直调 `node_modules/typescript/bin/tsc -p tsconfig.node.json`，编译语义等价，
对 CI 少一次全目录删除。优化后再次实跑，`prepare:out` 段与补建行为均正常。

### 环境护栏新证据：整链在本会话内已无法跑到 `build`（非仓库缺陷）

重跑时 `build` 步稳定停在：

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":408,"threshold":300,"scope":"turn",...}
```

**机制已查明**（读 `safe-delete-bulk-guard.cjs` + 状态文件）：
- 计数 key 为 `requestId`（= `CODEBUDDY_CONVERSATION_REQUEST_ID`，取不到才回落 tool call id），
  TTL 7 天；**同一轮对话的所有工具调用共享同一个计数桶**，阈值 300。
- 状态文件实测：本会话两个 request 桶 count 分别为 **361** 与 **371/408**，
  与本轮三次整链报出的 314 → 361 → 408 **单调递增序列吻合**。
- 因此**本轮对话的删除配额已耗尽**，`rmSync('out')` 必被拦；这是环境机制，
  与仓库代码无关。**未采取任何绕过手段**（未设 `CODEBUDDY_SAFE_DELETE_ENABLED=0`、
  未改系统设置、未强杀进程）。
- **处置**（2026-09-14 纠偏，r3-S6）：删除审批护栏是**独立的策略审批拦截**，
  与 rename EPERM 不是同一机制。正确做法：核对精确生成目标（out/ 为 tsc 产物，
  可重建）后走平台正规审批；**未获审批即保留阻塞**。不通过「换新会话使删除
  计数归零」等方式绕过或重置护栏。

**遗留阻塞（P4 仍为阻塞）**：
- P4-F1：e2e 应用步骤遭遇**目标文件被占用**（环境文件访问失败）——
  **归因降级（2026-09-14 纠偏，r3-S6）：持锁者待证实**。已证实的事实：
  最小复现（纯 Node，无 Electron / 无本仓库代码）在临时目录反复
  「写 staged → rename 覆盖 target」，**300 次命中 18 次 `EPERM`（6%）**；
  `%TEMP%` 与 `HOME` 下均有命中——说明**脱离产品代码也能出现访问失败**。
  此前「QQPCRtp Running、WinDefend Stopped」只是服务状态快照，**没有失败
  时目标文件的句柄或文件系统事件证据，不足以确认锁来源**；界面错误标签
  `FILE_LOCKED` 本身也不是持锁证据（EACCES 也可能是权限问题，现有代码把
  EPERM/EBUSY/EACCES 一律显示 FILE_LOCKED）。应用侧 `physical-fs`（Electron 下走
  `original-fs`）与 `archive-io`（`noAsar` 窗口 + `uncacheArchive`）**均无缺陷**；失败点是
  `commit.ts:98` 的 `rename` 覆盖已存在的 `app.asar`。详见 `P4_DIAGNOSIS_AND_FIX_PLAN.md` §2.3.1。
  验收项「EPERM/首次 apply 失败有具体错误码及诊断信息，未靠关闭防护或吞异常放行」**已满足**
  （错误码 `FILE_LOCKED`、诊断明确、未吞异常、未关闭防护）。
  **处置**（纠偏）：维持「不关防护、不改系统设置、不强杀进程」；**不把加入
  信任区/暂停实时防护作为默认步骤**。如需确定持锁者，由有权限的操作者取得
  针对该文件的句柄或文件系统事件证据并与失败时间对应；拿不到则保持「待证实」。
  文件访问失败优先保持防护、收集 code/errno/syscall/时间/目标路径/前后 hash、
  稍后有限次数重试。
- ~~P4-F2（新发现，待确认）~~ → **已修复（`690eea6` 首版 → 被 r2-R4 方案取代，现行为 `a794c08`）**：
  编排器把 `test:integration` 排在 `build` **之前**，而部分集成用例**依赖 `out/` 产物**。
  首版方案（`690eea6`）在集成前加 `ensureIntegrationPrereq()`（仅凭 `out/main/index.js`
  存在即跳过）。**r2 复审指出该方案会让集成用到旧 out worker**；r2-R4 已改为：
  **干净 `build` 提前到 `test:unit` 之后、`test:integration` 之前**（唯一一次构建），
  删除 `ensureIntegrationPrereq`；构建后记录 out 快照、打包前逐一复核（含 sha256），
  测试期间 out 被更改即拒绝（`a794c08`）。闸门场景 5b3 已改断言「build 在集成之前、
  prepare:out 不再出现」，并新增 5b4 快照复核负例。
- 本次另遇**本机环境护栏**（**与 P4-F1 的 rename EPERM 是两类不同机制**，
  r3-S6 纠偏：前者是删除策略审批拦截，后者是文件操作失败，不得混为同一根因）：
  构建环境的 `node-safe-delete-shim` 对单次进程内批量删除设有阈值
  （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），`build:main` 的 `rmSync('out')`
  在累计超阈值时被拦。**属环境机制，不是仓库缺陷**；未通过关闭护栏
  （`CODEBUDDY_SAFE_DELETE_ENABLED=0` 等）、未通过换会话重置计数、未通过
  扩大防护豁免绕过。



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

**下一阶段（任务 A–F）**：
- A 测试 worker 异步化 —— **已实施**（`5679c06`，定向测试通过）。
- B 受控并发 + 完整性检查接入发布链 —— **已实施**（`602708f`，定向测试通过）。
- C 发布资格与必需步骤契约 —— **已实施**（`076a38e`，定向测试通过）。
- D GUI 冒烟真实校验 —— **已实施**（`492322b`，定向测试通过；真实 exe 冒烟待整链）。
- E 文档纠偏 —— **已完成**（`673b39b` + 本表）。
- F 恢复 P4 重跑 —— **已发起（2026-09-14），受阻于环境文件占用**：以发布模式
  （不加 `--skip-gui`/`--skip-e2e`、不注入 `OTS_STEP_STUB`/`OTS_NODE_BIN`）重跑
  `node tools/release-build.cjs build 20260914-alpha1-p4full`，跑到 `test:e2e` 失败
  （3 failed/13 passed，根因＝目标文件被占用）。**未得到 `ALL_GREEN`、未产出候选**。
- F2 缺陷修复 —— **已完成**（`690eea6` 修复 + `9cd840a` 次生优化）：`test:integration`
  依赖 `out/` 却排在 `build` 之前，干净环境必失败。已在集成测试前加
  `ensureIntegrationPrereq()`（幂等补 out，不计入发布必需步骤），并新增闸门场景 5b3
  锁定该顺序。**端到端真实验证**：清空 out 后重跑整链，prepare:out 真实补建、
  integration 173/173 全过 exit 0。
- F 剩余动作（2026-09-14 纠偏，r3-S6）：**以发布模式重跑整链**。此前登记的
  两个前置按纠偏后口径处理：①批量删除护栏若再拦截，核对精确生成目标后走
  平台正规审批，**不得换新会话重置计数**，未获审批即保留阻塞；②`test:e2e`
  的文件访问失败在**保持防护**的前提下收集证据、有限次数重试，**不加信任区、
  不暂停实时防护**；持锁者待有句柄/事件证据再归因。在拿到发布级 `ALL_GREEN`
  之前，P4 仍为**阻塞**、无候选产物、总体 **NO-GO**。


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
