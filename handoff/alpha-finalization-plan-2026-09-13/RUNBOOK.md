# RUNBOOK · Alpha 发布操作手册

适用版本：`0.1.0-alpha.1`（Windows x64）。所有命令在项目根
`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher` 执行。

本手册只写**已实现**的接口与真实可跑通的命令；未实现的伪命令不写入。
发布编排入口是 `tools/release-build.cjs`（P3），旧的 `tools/release-gate.sh`
已收敛为它的薄入口（只加日志与绑定预检）。旧的 `candidate-manifest.json`
（schema `/1`）仍是历史记录，发布链**不会**自动回落它。

## 0. 环境前提

- Node ≥ 22；依赖已安装（`npm install`）。
- Windows 上 `npm`/`npx` 是 `.cmd`，本仓库脚本已处理（编排器对 npm 用
  `shell:true`，对 node 直接调用 `process.execPath`）。
- 若需要 shell 入口，用**已安装的 Git Bash**，不要依赖 PATH 里的 WSL bash：
  - Git Bash 路径：`D:\SOFTWARE\Git\bin\bash.exe`
  - 提示：本机某些自动化 shell 的 `PATH` 可能缺 `/usr/bin`，导致 `dirname` 等
    不可用；`tools/release-gate.sh` 内已显式 `export PATH="/usr/bin:/bin:$PATH"`。
- 测试临时目录策略：单元/集成测试通过 `tools/r5-run-suite.cjs` 注入
  `TEMP/TMP=<repo>/node_modules/.cache/ots-test-tmp`（可用 `OTS_TEST_TMP` 覆盖），
  避免 `%TEMP%` 下新建的 `*.asar` 被安全进程锁住。CI 无此干扰时自动回退系统默认。

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
- 快速迭代可加 `--skip-e2e --skip-gui`，但**发布链不得省略**这两步。

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

- 必须清掉子进程环境里的 `ELECTRON_RUN_AS_NODE`（脚本内已 `delete`）。某些开发
  环境全局导出它，Electron 会退化成纯 Node、不建窗口即退出 0，误判为「包坏了」。
- 不修改系统全局变量，不关闭 Chromium sandbox。
- 包内依赖探针（如 sharp）可用 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`），
  见 `verify-package.cjs`，不需要窗口与 GPU。

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
| 构建记录 | `candidate-<buildId>/build-record.json`（含每步退出码） |

## 8. Shell 入口（历史兼容）

```bash
"D:/SOFTWARE/Git/bin/bash.exe" tools/release-gate.sh build <buildId>
"D:/SOFTWARE/Git/bin/bash.exe" tools/release-gate.sh verify <buildId>
```
该脚本只做绑定预检与日志落盘，实质委托 `tools/release-build.cjs`；退出码为第一个
失败步骤的退出码（绑定缺失为 2）。不要用会弹出前台窗口的后台启动方式。

## 9. 已知限制

- A6 干净机器验证：用户决定跳过，**未验证**，不得记为通过。
- 候选未签名；fuse 为 Electron 默认值（未加固）。
- 旧候选（buildId `manual-repack-20260912`，schema `/1`）为历史记录，禁止作为最新分发。
