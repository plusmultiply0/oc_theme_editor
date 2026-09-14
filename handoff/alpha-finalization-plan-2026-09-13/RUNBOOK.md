# RUNBOOK · Alpha 发布操作手册

适用版本：`0.1.0-alpha.1`（Windows x64）。所有命令在项目根
`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher` 执行。

本手册只写**已实现**的接口与真实可跑通的命令；未实现的伪命令不写入。
发布编排入口是 `tools/release-build.cjs`（P3），旧的 `tools/release-gate.sh`
已收敛为它的薄入口（只加日志与绑定预检）。旧的 `candidate-manifest.json`
（schema `/1`）仍是历史记录，发布链**不会**自动回落它。

> **[2026-09-14 重要前提] 「已实现命令」≠「整链实测通过」。**
> 截至本版，发布链**尚未**完整跑通：`test:integration` 存在 **RPC 基础设施错误**
> （`onTaskUpdate` 超时 → 退出码 1），当前**未达到 `ALL_GREEN`**。
> 详见 `P4-BLOCKERS-DIAGNOSIS.md` 与 `diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`。
> 本手册描述的是**接口形状**，不代表候选已产出或已通过。

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
node tools/test-release-gate.cjs        # 发布编排链路行为测试（71 项断言）
```

单项：
```bash
node tools/r5-run-suite.cjs run tests/unit
node tools/r5-run-suite.cjs run tests/integration
```

日志位置：`node_modules/.cache/ots-test-logs/suite-<runId>.log`（按 runId 独立，不覆盖历史）。

## 2. 构建并登记新候选（完整链，唯一一次构建+打包）

```bash
# buildId 省略时自动生成：<时间>-<源码短SHA>-<随机后缀>
npm run release:build
# 或显式指定
node tools/release-build.cjs build 20260914-0830-abcdef1-x7k2
```

编排器依次执行（任一步非 0 立即停止、保留原始退出码）：

```
冻结预检 → typecheck → lint → test:unit → test:integration → build
→ test:e2e → test:e2e:electron → audit → dist（electron-builder，唯一目录）
→ verify-package（包结构/依赖可用性）→ zip（从候选目录）→ register（登记）
→ verify:release（来源/内容/zip 绑定）→ 构建后冻结复核
```

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

## 3. 只读核验既有候选（不构建、不改变任何产物 hash）

```bash
node tools/release-build.cjs verify <buildId>
```

等价于依次跑：
```bash
node tools/verify-package.cjs candidate-<buildId>/win-unpacked \
     --manifest candidate-<buildId>/candidate-manifest.json
node tools/verify-release.cjs --manifest candidate-<buildId>/candidate-manifest.json \
     --candidate-dir candidate-<buildId>/win-unpacked --build-id <buildId>
```

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
npx tsx tools/smoke-packaged.ts candidate-<buildId>/win-unpacked
```
成功打印 `SMOKE_OK`，失败打印 `SMOKE_FAIL:`。

> **[2026-09-14 已知问题]** 该入口依赖 `npx tsx`，但 **`tsx` 既未被 `package.json`/锁文件
> 声明，本机 `node_modules` 里也没有**。发布链**不得**临时下载未锁定的工具。
> 处置（任务 D，二选一）：把小冒烟脚本改为 **CJS**，直接
> `node tools/smoke-packaged.cjs <候选目录>` 并使用项目已声明的 Playwright 测试包；
> 或正式固定 `tsx` 依赖并同步锁文件。
>
> **[2026-09-14 验收漏洞]** 现行冒烟的**验收条件不足**：隔离模拟探针显示，
> mock 窗口返回**空标题/空 body**、或 `innerText` **直接抛异常**时，
> 两种情况**均输出 `SMOKE_OK`、exit 0**。这不代表真实打包程序一定是空白，
> 只说明**当前判据不能证明界面可用**。任务 D 将改为断言关键控件存在、
> 监听页面错误/崩溃，并让坏页面返回非 0。

- 必须清掉子进程环境里的 `ELECTRON_RUN_AS_NODE`（脚本内已 `delete`）。某些开发
  环境全局导出它，Electron 会退化成纯 Node、不建窗口即退出 0，误判为「包坏了」。
- 不修改系统全局变量，不关闭 Chromium sandbox。
- 保持 `contextIsolation`/`sandbox`/`webSecurity` 不变。
- 现有禁 GPU 启动只是**自动化诊断配置**，**不等于普通双击环境已验证**；
  真实 P5 仍需要正常用户启动证据。
- 包内依赖探针（如 sharp）可用 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`），
  见 `verify-package.cjs`，不需要窗口与 GPU。

## 5.1 发布资格 vs 开发构建（任务 C 起）

> **[2026-09-14 已登记缺口]** 当前 `--skip-e2e` / `--skip-gui` 省略的步骤**不进入
> build-record**，编排器结尾**仍打印 `ALL_GREEN`**；`verify-release` 只核对
> build-record 的 hash，**不检查发布必需步骤是否执行** → **「跳过检查仍可发布」**。
> 这是代码审查确认的后续风险，**不是**本轮真实构建复现。

任务 C 落地后：

- **开发构建**：可以跳检查，但只能标 `DEV_BUILD_COMPLETE` 且 `releaseEligible=false`，
  **不得**输出发布 `ALL_GREEN`，也**不被 release verify 接受**。
- **发布候选**：必须跑齐必需步骤集合
  （typecheck、lint、unit、integration、build、两类 E2E、audit、dist、GUI 冒烟、
  包可用性、zip）；build-record 逐步记录 `passed/failed/skipped` 与退出码，
  **不以缺字段隐含跳过**。
- 生产入口检测到 `OTS_STEP_STUB` / `OTS_NODE_BIN` 等**测试注入环境**时，
  必须明确拒绝或进入带不可发布标记的测试模式 —— 不能让遗留环境变量把 mock 成功
  伪装成真实通过。

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

- **发布链未跑通**：`test:integration` 存在 RPC 基础设施错误（`onTaskUpdate` 超时），
  当前**未达 `ALL_GREEN`**；本手册命令为**已实现但未整链验证**。
- **GUI 冒烟判据不足**：空白页/读取失败仍可能返回 `SMOKE_OK`；入口依赖未声明的 `npx tsx`。
- **跳过检查仍可发布**：`--skip-e2e`/`--skip-gui` 不进入 build-record，仍打印 `ALL_GREEN`。
- `EPERM` 访问被拒：**原因未定**（日志无持锁者证据），不指认安全进程，不关闭防护。
- A6 干净机器验证：用户决定跳过，**未验证**，不得记为通过。
- 候选未签名；fuse 为 Electron 默认值（未加固）。
- 旧候选（buildId `manual-repack-20260912`，schema `/1`）为历史记录，禁止作为最新分发。
