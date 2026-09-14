# RUNBOOK · Alpha 发布操作手册

适用版本：`0.1.0-alpha.1`（Windows x64）。所有命令在项目根
`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher` 执行。

本手册只写**已实现**的接口与真实可跑通的命令；未实现的伪命令不写入。
发布编排入口是 `tools/release-build.cjs`（P3），旧的 `tools/release-gate.sh`
已收敛为它的薄入口（只加日志与绑定预检）。旧的 `candidate-manifest.json`
（schema `/1`）仍是历史记录，发布链**不会**自动回落它。

> **[2026-09-15 重要前提] 「已实现命令」≠「整链实测通过」；历史记录不得当作当前版本结论。**
> 本手册混合两类事实，**必须区分**：
>
> | 类别 | 含义 | 当前状态 |
> |---|---|---|
> | **旧提交执行记录** | 在**旧代码**上跑出的结果，只描述当时那版 | 任务 A/B/C/D 的定向测试、`onTaskUpdate` 超时根因修复（`5679c06`） |
> | **当前工作树结论** | HEAD 及其改动下的实测 | 见下；**未跑整链前不宣称 `ALL_GREEN`** |
>
> 截至本版：发布链**整链仍未以发布模式重跑**（授权关口，任务 F），
> **尚无 `ALL_GREEN`、无候选产物**。已落地的代码修复按提交登记：
> R1/R2（`4ddf644`，生命周期去自引用 + 资格校验信任边界）、R3（`33925dd`，
> 严格完整性＝完成集合相等的机器校验）、R4（`a794c08`，`build` 提前到集成之前
> + 打包前 out 快照复核）、S1（`6947483`，record↔manifest/receipt 同一次构建身份校验）。
> 每项的证据是 `node tools/test-release-gate.cjs` 全量门禁（逐项全绿，最新 179 项断言
> 全过，日志 `node_modules/.gate-log-*.txt`，**不入库**）+ typecheck/lint 0。
> 门禁测的是**编排器行为**（含大量桩注入），**不等于真实整链产物已产出**。

## 状态词（五者含义不同，**不得互相代替**）

| 状态词 | 含义 |
|---|---|
| `已实现但未整链验证` | 接口/脚本已写好，但从未完整跑通 |
| `定向测试通过` | 指定子集测试通过（不代表全量） |
| `完整测试有基础设施错误` | 测试框架层报错（如 RPC 超时），结论不可采信 |
| `候选工程验证通过` | 候选产物通过 verify-package + verify-release |
| `真实闭环通过` | 在真实安装上完成应用→重启→换图→恢复 |

## 0. 环境前提

- Node ≥ 22；依赖已安装（`npm install`）。
- Windows 上 `npm`/`npx` 是 `.cmd`，本仓库脚本已处理（编排器对 npm 用
  `shell:true`，对 node 直接调用 `process.execPath`）。
- 若需要 shell 入口，用**已安装的 Git Bash**，不要依赖 PATH 里的 WSL bash：
  - Git Bash 路径：`D:\SOFTWARE\Git\bin\bash.exe`
  - 提示：本机某些自动化 shell 的 `PATH` 可能连 `/usr/bin` 都没有
    （`dirname`/`mkdir`/`ls` 全不可用），显式 `export PATH` 也无效。
    此时改用 `node -e` 做文件操作，或直接读日志文件。
- **测试临时目录策略（按真实行为）**：单元/集成测试经 `tools/r5-run-suite.cjs` 运行时，
  若外部已注入 `TEMP`/`TMP`，则沿用；本仓库脚本会传 `<repo>/node_modules/.cache/ots-test-tmp`。
  可用 `OTS_TEST_TMP` 覆盖根目录。
  **注意**：`tests/fixtures/test-tmp.ts` 在**未注入** `TEMP`/`TMP` 时回退到 `os.tmpdir()`
  （系统默认），**不是**「CI 自动识别并回落」——是「未注入就用系统默认」。
  发布链（任务 B 起）会为每次运行分配**独立**临时子目录，不再共用同一个固定目录。
- **受控并发（任务 B 起）**：发布模式的集成测试固定使用
  `--pool=forks --maxWorkers=1 --no-file-parallelism`（**不使用 `singleFork`**，
  避免把所有文件长期塞进同一 worker 状态）。**单靠该配置仍会 RPC 报错，必须配合任务 A 的异步化。**

## 1. 代码测试（不产出候选）

```bash
npm run typecheck                       # 类型
npm run lint                            # 静态检查
node tools/r5-run-suite.cjs run         # 全量单元+集成（推荐入口，注入临时目录策略）
node tools/test-release-gate.cjs        # 发布编排链路行为测试（约 179 项断言，逐项增长）
```

单项：
```bash
node tools/r5-run-suite.cjs run tests/unit
node tools/r5-run-suite.cjs run tests/integration --pool=forks --maxWorkers=1 --no-file-parallelism
```

**受控并发（任务 B 起，发布链固定使用）**：集成测试必须带
`--pool=forks --maxWorkers=1 --no-file-parallelism`（**不用 `singleFork`**，
该选项与文件级并行控制语义重叠）。理由是并行资源竞争会在高负载机器上造成
假失败与 RPC 超时；受控并发把这类环境噪声排除掉。（不删用例、不跳用例、不调阈值。）

**严格完整性判据（R3 `33925dd` 起；发布链固定开启 `--strict-completeness --expect-no-skip`）**：

包装层**不依赖「最后显示全 ✓」的文本汇总**。严格模式下：

1. 运行前用**同配置同过滤条件**的 `vitest list --filesOnly` 收集**预期文件集合**
   （任何不可解析行 → 失败关闭）；
2. 运行时附加 `--reporter=json --outputFile.json=<logDir>/result-<runId>.json`；
3. 比对的是**规范化后的完成文件集合相等**，不是「数量/分母/计划数」；
4. 机器结果 `numTotalTests`/`numFailedTests` 必须与逐条聚合一致且 `success===true`；
   JSON 缺失、不可解析、或 `startTime` 不在本次运行窗口（runId 绑定）→ 失败关闭；
5. 文件级失败 0、文件收集错误（`message` 非空）0、测试失败 0；
6. **`pending > 0` 即拒绝**（worker 未跑完视同未完成）；`skipped`/`todo` 仅
   `--skip-allow` 名单豁免（精确 id / `entry::` 前缀 / 尾 `*` 通配）；
7. 进程退出码必须 0；**进程自称 0 但完整性不通过时强制拉成 1**。

不通过时输出 `COMPLETENESS_FAIL:` / `STRICT_FAIL:` 并逐条列出原因。
文本汇总只在**机器结果不可用**时兜底（保留 Unhandled Error 启发式）。

| 判据 | 说明 |
|---|---|
| 预期集合可收集 | `vitest list --filesOnly` 成功且每行都能 stat 到 |
| 完成集合相等 | 实际完成文件集合 == 预期集合（规范化路径比对） |
| 机器结果可信 | JSON 存在、可解析、`startTime` 落在本次运行窗口 |
| 失败为 0 | 文件级失败、收集错误、断言失败均为 0 |
| 无 pending | 任何 pending 都拒绝 |
| skipped/todo | 默认 0，仅 allowlist 豁免 |
| Unhandled Error 为 0 | 文本兜底时仍检查 |
| 退出码 | 必须为 0；不满足上述任一条时强制拉成 1 |

不通过时输出 `COMPLETENESS_FAIL:` 并逐条列出原因。每次运行的日志写在
`node_modules/.cache/ots-test-logs/suite-<runId>.log`（含 command/cwd/独立 tempRoot/
status/signal/timeout/spawnError + 完整 stdout/stderr），**每次运行独立临时子目录**
`<tmpRoot>/run-<runId>`，不同运行互不干扰。


## 2. 构建并登记新候选（完整链，唯一一次构建+打包）

```bash
# buildId 省略时自动生成：<时间>-<源码短SHA>-<随机后缀>
npm run release:build
# 或显式指定
node tools/release-build.cjs build 20260914-0830-abcdef1-x7k2
```

编排器依次执行（任一步非 0 立即停止、保留原始退出码）：

```
冻结预检 → typecheck → lint → test:unit
→ build（唯一一次完整构建，产出 out/）
→ test:integration（用同一份 out/）→ test:e2e → test:e2e:electron → audit
→ out 快照复核（与构建时逐文件 hash 一致，防止中途被改）
→ dist（electron-builder，唯一目录）→ verify-package（包结构/依赖可用性）
→ zip（从候选目录）→ register（登记）→ core verify:release（来源/内容/zip 绑定）
→ 完成回执 release-receipt/1（仅当 manifest 真实存在时写出）
→ 构建后冻结复核 → 发布级只读终检（S2）→ ALL_GREEN
```

> **[R4 `a794c08`]** 旧顺序把 `build` 排在 `test:integration` **之后**，而集成用例
> 依赖 `out/` 产物（`electron-runtime.test.ts` 断言 `out/main/index.js`），
> 在干净环境必然失败。现改为**先构建、集成与打包共用同一份 `out/`**；
> 原 `prepare:out` 前置补建步骤已删除（不再是「两套构建并存」）。
> 打包前用**构建时的 out 快照**复核：missing/extra/changed 任一差异即拒绝。

产物（均落在已忽略范围，不入库）：

```
candidate-<buildId>/
  win-unpacked/                候选程序目录（zip 只从这里生成）
  builder-out/                 electron-builder 原始输出
  candidate-manifest.json      本次身份登记（schema candidate-manifest/3）
  build-record.json            本次构建记录（sourceCommit/version/锁文件/out 清单/各步退出码）
candidate-<buildId>.zip        分发 zip
```

- **禁止覆盖**：同名 `candidate-<buildId>/` 已存在即拒绝，换一个 buildId。
- 源码未冻结（已跟踪文件有改动、或新增未跟踪源码/脚本）→ 构建前拒绝。
- 快速迭代可加 `--skip-e2e --skip-gui`，但**发布链不得省略**这两步；
  任务 C 起，带 skip 的构建只能标 `DEV_BUILD_COMPLETE` / `releaseEligible=false`，
  **不得**输出发布 `ALL_GREEN`，也不被 release verify 接受。
- **不得携带测试注入变量**（`OTS_STEP_STUB`/`OTS_NODE_BIN`）跑发布模式。
- **`--pack-method` 必填（S5）**：`electron-builder`（自动化打包链）或
  `manual-repack`（手工重封）。登记器**不提供默认值**——缺参即拒绝登记。
  来源方式不能由工具替调用方猜测；编排器的真实 builder 分支已显式传
  `electron-builder`。
- **`reproducibleBuild` 的真实含义（S5）**：该字段**只表示**「本次由
  electron-builder 自动化链产出」，**不是**两次构建字节级一致的证明
  （本仓库从未做过位级可复现验证）。字段名保留以维持 `candidate-manifest/3`
  结构稳定，但**不得**把它当作可复现性证据写进对外材料。

## 3. 只读核验既有候选（不构建、不改变任何产物 hash）

```bash
node tools/release-build.cjs verify <buildId>
```

等价于依次跑：
```bash
node tools/verify-package.cjs candidate-<buildId>/win-unpacked \
     --manifest candidate-<buildId>/candidate-manifest.json
node tools/verify-release.cjs --manifest candidate-<buildId>/candidate-manifest.json \
     --candidate-dir candidate-<buildId>/win-unpacked --build-id <buildId> \
     --require-release-eligibility
```

第二个命令带 `--require-release-eligibility`（R1）：除来源/内容/zip 绑定与
build-record/2 事实外，还要求 12 项必检步骤齐全真实通过、**持有完成回执
release-receipt/1 且其 buildId/sourceCommit/manifestHash/buildRecordHash 与
当前产物完全绑定**。缺回执、绑定错误、注入环境、跳过必检一律不得给绿色结果。

**两类成功标记含义不同（S2，不得混用）**：

| 标记 | 由谁输出 | 含义 |
|---|---|---|
| `CORE_VERIFY_GREEN` | core 核验（**不带** `--require-release-eligibility`） | 只证明**事实/产物/来源**自洽，**不等于可发布** |
| `RELEASE_GREEN` | 发布级核验（**带**该旗标） | 额外要求完整资格 + 回执绑定，才是发布结论 |

> 旧版 core 与发布级共用 `RELEASE_GREEN`，且 `release-gate.sh` 在编排器成功后
> **自行再补一句 `ALL_GREEN`** → 阶段性结论被当成最终结论。S2 已分开；shell
> 只做日志落盘，不再自行补成功标记。**`ALL_GREEN` 只能由编排器在发布级只读
> 终检真实退出 0 后输出一次**（不是自判输出）。

**身份交叉校验（S1 `6947483`）**：`record.buildId` 必须是非空字符串；显式
`--build-id` 若提供必须与之相等；`sourceCommit`/`version`/`lockfileSha256`/`out`
四项必须一致（锁文件 hash 为**必填**，不是「有才比」）。登记器与核验器共用同一
纯函数 `checkRecordBinding`，核验端**不假设** manifest 一定由当前登记器正确写出。
因此「拿 A 的记录配 B 的 manifest/receipt」在**登记阶段**即被拒绝。

两个职责必须都通过：`verify-package` = 结构/依赖可用性（入口、unpacked 实体、
依赖完整性、隐私扫描、包内 sharp 真实出图）；`verify-release` = 来源/内容/zip 绑定
（buildId、候选目录、sourceCommit、锁文件与构建记录 hash、out 清单逐文件、zip 逐条目
与深度完整性）。日志中两者名称分别显示，不混为一条。

显式绑定核验（不回落默认候选）：
```bash
node tools/verify-release.cjs --manifest <路径> --candidate-dir <目录> --build-id <id>
```

## 4. 包内依赖检查

由 `verify-package` 自动完成（第 3 节）。单独跑：
```bash
node tools/verify-package.cjs <候选目录> --manifest <登记路径>
```
`--no-identity` 仅用于核对**未登记**目录的取证场景，**不得**用作发布通过的捷径。

## 5. GUI 启动环境处理

打好的包启动冒烟（Playwright，与真实双击启动同一机制）：
```bash
node tools/smoke-packaged.cjs candidate-<buildId>/win-unpacked
```
成功打印 `SMOKE_OK`；失败打印 `SMOKE_FAIL: <原因>` 并 **exit 1**。

> **[2026-09-14 已修（任务 D）]** 原先用 `npx tsx tools/smoke-packaged.ts` ——
> `tsx` **既未被 `package.json`/锁文件声明，本机也没有**，发布链不得临时下载未锁定工具。
> 现改为 **`.cjs`**，由 `node` 直接运行，只依赖已声明的 Playwright 测试包；
> 发布编排器的 `smoke:gui` 步骤同步改用该入口。

**冒烟判据（任务 D 起强制；任一不满足即失败）**：

| 判据 | 说明 |
|---|---|
| 渲染进程真的起来 | 能拿到窗口（`firstWindow`） |
| 顶栏标题正确 | `.topbar h1` 精确等于「OpenCode 换肤助手」 |
| 关键控件可见 | 「应用到 OpenCode」按钮可见 |
| 非空白页 | body 可见文本 ≥ 40 字符 |
| 无致命错误 | 渲染进程 `console error` / `pageerror` 计数为 0 |

> **[2026-09-14 验收漏洞已修]** 旧版只打印前 3 行文本就无条件 `SMOKE_OK`——
> 空白页、白屏崩溃、渲染进程挂掉都能「通过」。现在上述四条任一不满足即非 0。
> 可用 `--self-test-negative` 自检：脚本会清空 DOM，**必须**判为失败并打印
> `SMOKE_SELFTEST_OK`，用于证明断言真的会失败（避免「永远通过的检查」）。

- 必须清掉子进程环境里的 `ELECTRON_RUN_AS_NODE`（脚本内已 `delete`）。某些开发
  环境全局导出它，Electron 会退化成纯 Node、不建窗口即退出 0，误判为「包坏了」。
- 不修改系统全局变量，不关闭 Chromium sandbox。
- 保持 `contextIsolation`/`sandbox`/`webSecurity` 不变。
- 现有禁 GPU 启动只是**自动化诊断配置**，**不等于普通双击环境已验证**；
  真实 P5 仍需要正常用户启动证据。
- 包内依赖探针（如 sharp）可用 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`），
  见 `verify-package.cjs`，不需要窗口与 GPU。

## 5.1 发布资格 vs 开发构建（任务 C 起）

> **[2026-09-14 已修]** 原缺口：`--skip-e2e` / `--skip-gui` 省略的步骤**不进入
> build-record**，编排器结尾**仍打印 `ALL_GREEN`**；`verify-release` 只核对
> build-record 的 hash，**不检查发布必需步骤是否执行** → **「跳过检查仍可发布」**。
> 任务 C（`076a38e`）已关闭：新增 `tools/release-eligibility.cjs` 作为**唯一事实来源**，
> 构建与核验共用同一把尺子。

- **必需步骤 14 项**：typecheck、lint、test:unit、test:integration、build、test:e2e、
  test:e2e:electron、audit、dist、smoke:gui、verify-package、zip、register、verify:release。
- **开发构建**：可以跳检查，但只能标 `DEV_BUILD_COMPLETE` 且 `releaseEligible=false`，
  **不得**输出发布 `ALL_GREEN`，也**不被 release verify 接受**。
- **发布候选**：必须跑齐上述 14 项；build-record 逐步记录
  `{ step, status: passed|failed|skipped|pending, exit, seconds }`，
  **不以缺字段隐含跳过**。
- **绝不乐观放行**：`releaseEligible` 缺失、`testInjectedEnvironment=true`、
  有步骤 `skipped`、有步骤非 `passed`、退出码非 0 —— 任一都判为不可发布。
- 生产入口检测到 `OTS_STEP_STUB` / `OTS_NODE_BIN` 等**测试注入环境**时，
  在 build-record 打标并拒绝发布资格 —— 不能让遗留环境变量把 mock 成功伪装成真实通过。
- `--strict` 模式：本次构建不可发布时直接 `exit 1`（供 CI 使用）。


## 6. 真实安装闭环（授权关口，P5）

**执行前必须当次取得用户确认**，并请用户保存工作、完全退出 OpenCode；不继承历史
授权、不强杀进程。未确认就停在此阶段。

目标：`D:\...\<OpenCode 安装路径>`（以实际识别为准）。步骤与核验见
`ALPHA_IMPLEMENTATION_PLAN.md` P5 表（应用 JFIF → 换 PNG/WebP → 重复应用 no-op →
深浅主题/缩放 → 恢复上一主题 → 恢复首次接管快照）。每步绑定同一 buildId 与归档 hash。

失败即停，先按已验证健康快照恢复；无健康可恢复证据则请示用户，不换旧版安装绕过。

## 7. 失败日志位置

| 场景 | 位置 |
|---|---|
| 编排链整链输出（shell 入口） | `<GATE_LOG_DIR>/a4-gate-<时间>-<pid>.txt`（默认 `/tmp`，可用 `GATE_LOG_DIR` 覆盖） |
| 单元/集成测试 | `node_modules/.cache/ots-test-logs/suite-<runId>.log` |
| 发布核验（verify-release） | 标准输出（`RELEASE_GREEN buildId=...` 通过，`RELEASE_VERIFY FAILED` 失败） |
| 包可用性（verify-package） | 标准输出（`核对 N 项，失败 M 项`） |
| 构建记录 | `candidate-<buildId>/build-record.json`（含逐步状态与退出码） |

**日志完整性判据（任务 B 起，不得只看「最后显示全 ✓」）**：

放行必须同时满足 —— **应运行文件集合 = 实际完成文件集合**、失败 0、
`pending`/`skipped`/`todo` 与预期一致、**Unhandled Error 0**、进程退出 0。
日志需记录 spawn error、signal、超时、日志路径与**执行命令**（不能只输出最后六行而丢失摘要）。
`RPC 错误`或**少跑文件**一律不得放行。

**踩坑提醒**：本机 Git Bash 下 `/tmp` 实际映射为
`C:\Users\ylzho\AppData\Local\Temp`。把 `/tmp/x.log` 直接传给 node 会被解析成
`D:\tmp\x.log` 而 `ENOENT`；读日志请用真实路径或 Read 工具。

## 8. Shell 入口（历史兼容）

```bash
"D:/SOFTWARE/Git/bin/bash.exe" tools/release-gate.sh build <buildId>
"D:/SOFTWARE/Git/bin/bash.exe" tools/release-gate.sh verify <buildId>
```
该脚本只做绑定预检与日志落盘，实质委托 `tools/release-build.cjs`；退出码为第一个
失败步骤的退出码（绑定缺失为 2）。不要用会弹出前台窗口的后台启动方式。

## 9. 已知限制

- **整链仍未以发布模式重跑**（授权关口，任务 F）：`onTaskUpdate` RPC 超时的根因
  已修（`5679c06`），**但「根因已修」≠「整链已通过」**——当前**未达 `ALL_GREEN`、
  无候选产物**。本手册命令状态为**已实现 + 定向/门禁验证通过，但未整链验证**。
- ~~**GUI 冒烟判据不足**~~：已由任务 D（`492322b`）关闭——入口改 `.cjs`、不依赖未声明
  的 `npx tsx`；空白页/白屏/渲染进程挂掉均判失败，并提供 `--self-test-negative` 自检。
- `EPERM` 访问被拒：**归因未证实**。日志保留 `code`/`errno`/`syscall`/时间/目标路径，
  但**没有目标句柄或事件对应证据**，因此**不指认具体进程**、不关闭防护、不强杀进程、
  不把整仓或整个临时目录加入信任区。同类阻塞按「审批阻塞」独立登记，不与产品错误混写。
- ~~**跳过检查仍可发布**~~：已由任务 C + R1/R2 关闭——skip 构建只能得
  `DEV_BUILD_COMPLETE`；发布级 verify 额外要求完整资格与完成回执绑定。
- ~~**发布记录自引用**~~（R1，2026-09-14 已修）：旧 build-record/1 把尚未发生的
  register/verify:release 写成 pending，正常链永远拿不到发布资格；现由
  build-record/2（登记前事实）+ release-receipt/1（完成回执）分离承担。
- A6 干净机器验证：用户决定跳过，**未验证**，不得记为通过。
- 候选未签名；fuse 为 Electron 默认值（未加固）。
- 旧候选（buildId `manual-repack-20260912`，schema `/1`）为历史记录，禁止作为最新分发。
