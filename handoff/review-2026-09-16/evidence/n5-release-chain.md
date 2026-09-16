# E 项：当前提交全量验证及新候选（复审）

执行时间：2026-09-16
源码提交：`f425ea3`（D 项提交，含 A/B/C 全部修复）
完成标准（计划 §5 E 行）：**同一 buildId 串联全部证据，不以单元通过代替**。

## 0. 结论速览

| 环节 | 结果 |
|---|---|
| 全量验证 `verify-entry.cjs` | ✅ **exit 0 / VERIFY_OK**（229 单测 + 179 集成 + 16 e2e） |
| 发布链首次尝试 | ❌ STOPPED at `test:unit`（包装层临时根导致 9min 超时，**非测试失败**） |
| 定位并绕过临时根 | ✅ 13s 全绿（`OTS_TEST_TMP` 指向系统盘） |
| 发布链第二次尝试 | ➡️ 推进到 `smoke:gui`，`SMOKE_FAIL: Target crashed` |
| 定位 GUI 冒烟崩溃 | ✅ **`smoke-packaged.cjs` 缺 `--no-sandbox` / `--in-process-gpu`** |
| 修好冒烟开关后单独复测 | ✅ **SMOKE_OK**，窗口标题「OpenCode 换肤助手」 |
| 发布链第三次尝试 | 见 §6（源码冻结检查要求先提交本工具修复） |

## 1. 全量验证（`node tools/verify-entry.cjs`）

同一提交、一次调用、按 §4.2 第 7 条的顺序执行，**exit 0**，终标记 `VERIFY_OK`：

| 步骤 | 结果 |
|---|---|
| typecheck | exit 0（`tsc --noEmit -p tsconfig.json`，无输出） |
| lint | exit 0（`eslint .` 干净） |
| unit | **229 passed / 14 files**，0 failed |
| build | 产出 `out/`（main + renderer） |
| integration | **179 passed / 15 files**，0 failed |
| e2e（Playwright） | **16 passed**（43.5s） |
| 终标记 | `VERIFY_OK（开发验证通过；这不是发布验收）` |

原始日志：`evidence/n5-full-verify.json`（含机器结果摘要与关键行）。
**这一条排除了「以单元通过代替」的做法**：单元只是链上第 3 步，后面还有构建、
集成与 GUI 冒烟。

## 2. 发布候选链（`node tools/release-build.cjs build <buildId>`）

buildId = `20260916064743-f425ea3-8b4671`（时间 + 源码短 SHA + 随机后缀，
由工具自身规则生成；`sourceCommit` 记录为 `f425ea3f7170a17160fc70969f7770547f33c5e5`）。

**结果：exit 1，STOPPED at test:unit。** 但失败原因**不是测试失败**：

```
=== test:unit ===
strict=on expectedFiles=14
exit=null signal=SIGTERM
timeout=true
spawnError=spawnSync ...node.exe ETIMEDOUT
summary files=14passed/14total tests=229passed/229total failed=0 unhandledErrors=0
strict=files=14/14 tests=229/229 failed=0 skipped=0 todo=0 pending=0
EXIT test:unit = 1 (543.4s)
STOPPED at test:unit
```

即：**229/229 全部通过、0 失败、0 跳过**，但包装层因为 `spawnSync` 在
**9 分钟超时**（`r5-run-suite.cjs` 默认 `timeoutMs = 9 * 60 * 1000`）后
SIGTERM 了子进程，于是判定失败。

## 3. 归因：不是产品缺陷，是包装层的 TEMP 重定向 × 嵌套 vitest（有对照证据）

| 对照 | 命令 | 耗时 | 结果 |
|---|---|---|---|
| 链上同款（超时 9min） | `r5-run-suite.cjs run tests/unit --strict-completeness --expect-no-skip` | **>540s → SIGTERM** | 229/229 通过但判失败 |
| 空闲重跑（同上） | 同上 | **547s → SIGTERM** | 复现（非偶发、非瞬时争用） |
| 放大超时到 30min | 同上 + `--timeout-ms=1800000` | **>1290s 仍在跑**（主动终止） | 预算不是唯一问题 |
| 收敛并发 + 10min 预算 | 同上 + `--pool=forks --maxWorkers=1 --no-file-parallelism` | **>580s 仍在跑**（主动终止） | 收敛并发也不足以修复 |
| **plain vitest（不经包装层）** | `vitest run tests/unit` | **16.1s，exit 0，signal=null** | 正常 |
| `vitest list`（枚举预期文件） | `vitest list tests/unit --pool=forks --maxWorkers=1` | 15.0s，exit 0 | 正常 |
| **临时根改为系统盘** | 同链上同款 + `OTS_TEST_TMP=%LOCALAPPDATA%\Temp\ots-rtmp` | **13s，exit 0** | **229/229 通过，问题消失** |
| `verify-entry.cjs` 的 unit 步（`vitest run`） | 链上第 3 步 | ~15s | 正常 |

**结论**：慢的是 **`r5-run-suite.cjs` 包装层的临时根位置**，不是 vitest、不是产品
代码、也不是并发度。同一台机器、同一时刻、同一条命令：

- 临时根在**项目盘**（默认 `node_modules/.cache/ots-test-tmp`）→ **9 分钟仍跑不完，被判失败**；
- 临时根在**系统盘**（`OTS_TEST_TMP=%LOCALAPPDATA%\Temp\...`）→ **13 秒，exit 0**。

整条命令、严格判据、测试集合**完全相同**，唯一变量是临时根落在哪个盘/多深。

机制（`tools/r5-run-suite.cjs:388-400`）：

```js
const tmpRoot =
  options.tmpRoot ||
  process.env.OTS_TEST_TMP ||
  path.join(repo, 'node_modules', '.cache', 'ots-test-tmp');   // ← 默认落在项目盘
...
const env = { ...process.env, TEMP: runTmp, TMP: runTmp };     // ← 重定向给子进程
```

包装层把 `TEMP`/`TMP` 重定向到项目盘的深层一次性目录，并带 `--strict-completeness`
先 `vitest list` 收集预期集合。而 `tests/unit` 里的 `run-suite-wrapper.test.ts`
**会再 spawn 嵌套的 vitest 进程**，这些子进程继承被重定向的 TEMP，继续在项目盘上
建目录、写文件、做递归删除。

在这台机器上（D 盘、深度嵌套路径、递归删除开销大 —— 与 D 项取证里
`stage/<opId>/app` 的慢删除/`EBUSY` 同源），这条嵌套链把 wall-clock 拖到
10 分钟以上并触顶。**不是并发数能解决的问题** —— 收敛并发后仍然 >580s。

**该包装层与 TEMP 重定向来自提交 `602708f`（B 任务）与 `b146d87`（S4），
早于本轮 A–D 的改动**，因此不是本轮修复的回归。

## 4. 处置与保留

- **未改产品代码**：本项全程只读产品行为，未放宽超时、未改断言、未绕过门禁
  （计划 §4.2 第 6 条禁止用无限重试/新会话清计数规避审批）。
- 包装层临时根是**真问题**，但属于发布编排链在**本机**的临时目录策略问题，
  不是 N1–N5 修复的回归。按计划「不扩展范围」，**本项只取证与记录，不顺手改**。
- 发布候选因此**未生成**（链在 `test:unit` 即停）。`ALL_GREEN` 未产出，
  也未出现任何假冒成功的标记 —— 这恰好说明门禁的**失败关闭是有效的**：
  它宁可停在一个「其实全绿但没跑完」的步骤，也不放行。
- 真实 OpenCode 安装→应用→重启→恢复仍**需用户当次授权**，本项未执行。

## 5. 待用户决策

### 5.1 临时根（已用证据定位，未改默认）

- ✅ **临时根改到系统盘 → 13s 全绿**（现成的 `OTS_TEST_TMP` 环境变量即可验证，
  已在第三次发布链尝试中采用）。
- ❌ 收敛并发参数**不足以**修复（仍 >580s），不推荐单独使用。
- ❌ 单纯提高 `--timeout-ms` 治标，且会掩盖真实回归。

可选路径（**均需用户确认后再动**）：

1. **把 `runSuite` 的默认 `tmpRoot` 从项目盘改为系统临时目录**（保留 `--tmp` /
   `OTS_TEST_TMP` 覆盖）—— 针对根因，**不放松任何严格判据**。推荐。
2. **发布链里给 unit 步骤设 `OTS_TEST_TMP`**（不改默认，只改链上环境）——
   影响面更小，但只在链上生效。
3. 保持现状，发布时手工设 `OTS_TEST_TMP`。

### 5.2 GUI 冒烟开关（**已修，本轮提交**）

`tools/smoke-packaged.cjs` 只传了 `--disable-gpu --disable-software-rasterizer`，
缺 `--no-sandbox` 与 `--in-process-gpu`。`docs/acceptance.md:175` 已明确记录：
无显示会话下这几个开关缺一不可，否则 GPU 子进程反复重启。

症状极具误导性：Playwright 报 `Target crashed`，且该错误**从子进程异步逃逸出
`try/catch`**，只留一句没有上下文的 `SMOKE_FAIL`。对照实验：

| args | 结果 |
|---|---|
| `--disable-gpu --disable-software-rasterizer`（原） | ❌ `Target crashed` |
| 上述 + `--no-sandbox --in-process-gpu --disable-dev-shm-usage --disable-gpu-compositing` | ✅ `OK title= OpenCode 换肤助手` |
| 直接 spawn exe（不经 Playwright） | ✅ 运行 8s 无报错（说明**包本身是好的**） |

已把开关补齐为文档推荐集合，并把这段判断写进代码注释（避免后人再当成「包坏了」）。

## 6. 发布链第三次尝试与源码冻结

补齐开关后重跑 `node tools/release-build.cjs build <buildId>`（带
`OTS_TEST_TMP` 指向系统盘），链在第一道闸就停下：

```
[FAIL] 源码未冻结，拒绝构建：
  - 已跟踪文件有未提交改动：tools/smoke-packaged.cjs
```

这是**正确行为**：门禁要求被测源码先冻结（提交）再构建，避免「构建的
和记录的不是同一份」。所以本项先提交冒烟工具修复，再用新 buildId 重跑
（见提交后的复测记录）。

## 7. 发布链第四次尝试：test:e2e 失败（`未发现目标`）

提交 `b64203e`（冒烟开关修复）后重跑，buildId = `20260916081110-b64203e-408e68`：

```
EXIT typecheck        = 0 (8.0s)
EXIT lint             = 0 (7.3s)
EXIT test:unit        = 0 (12.5s)   ← 229/229，含 OTS_TEST_TMP
EXIT build            = 0 (32.0s)
EXIT test:integration = 0 (240.8s)  ← 179/179
EXIT test:e2e         = 1 (50.6s)   ← 1 failed / 15 passed
STOPPED at test:e2e
```

失败用例（唯一一个）：

```
tests\e2e\theme-switcher.spec.ts:174:7
  图形界面闭环（先不碰用户安装） › 窗口与渲染进程启动，且只看到临时目录里的合成安装
  expect(installText.toLowerCase()).toContain(baseDir.toLowerCase())
  Expected substring: "c:\\users\\ylzho\\appdata\\local\\temp\\ots-gui-z1q2qo"
  Received string:    "未发现目标"
```

界面上 `.target .muted` 渲染出的是 `未发现目标`（`App.tsx:418` 的空状态分支），
即**主进程的 `discoverTargets` 没有认出名合成安装**。同 spec 的其余 7 个用例
（拖拽导入、可读性、确认框、恢复、重新检测）**全部通过**。

### 7.1 复现与排除（对照实验）

| # | 条件 | 结果 |
|---|---|---|
| 1 | `npm run test:e2e`（单独，系统 Temp） | ✅ 16 passed（34.5s） |
| 2 | `test:e2e` + `OTS_TEST_TMP` 指向系统盘 | ✅ 16 passed |
| 3 | 链上同款 TEMP 重定向（系统盘深层） | ✅ 16 passed |
| 4 | **精确复刻「build → test:e2e（链上 TEMP）」** | ✅ 16 passed（38.8s） |
| 5 | **同一 runDir 先 integration 再 e2e** | ❌ **复现**（1 failed / 15 passed） |
| 6 | 同 runDir 下**只跑 theme-switcher** | ❌ **复现**（1 failed / 7 passed） |
| 7 | 同上，但**不重定向 TEMP**（对照） | ✅ 8 passed |
| 8 | 精确重建「`ots-test-tmp/run-<pid>-<ts>`」形状后重跑 | ✅ 8 passed（**未复现**） |

实验 5→6 把范围从「integration 制造的临时文件」收窄到 **`theme-switcher.spec.ts`
自身 + TEMP 重定向**；实验 6→7 锁定**唯一变量就是 TEMP 被重定向**；
实验 8 说明**并非**「路径形状/盘符」决定，而是**时序相关**。

### 7.2 直接定位：`discoverTargets` 在 Electron 里的候选根

用独立探针（`tools/e2e-target-discovery-probe.cjs`，真实 Playwright 启动，
只读界面文本）在**同一份 out 产物**上做了三组对照：

| 探针条件 | `.target` 渲染 |
|---|---|
| 系统 Temp（基线） | ✅ `supported / 1.18.29 / ...\ots-probe-gui-*\localappdata\Programs\@opencode-aidesktop` |
| TEMP → 系统盘深层 runDir | ✅ 同上（认出） |
| TEMP → 项目盘深层 runDir | ✅ 同上（认出） |

即：**在没有其它用例并行的干净进程里，无论 TEMP 指向哪里都能认出**。
这排除了「TEMP 位置本身破坏 realpath/stat」这类静态原因，
与实验 8 一致地指向**并发/时序**因素。

### 7.3 参照对象：`background-cascade.spec.ts` 会拉起外部浏览器

同一次 `test:e2e` 里，先跑 8 个 `background-cascade` 用例再跑
`theme-switcher`（配置 `workers: 1`、`fullyParallel: false`，同 worker 串行）。
前者用 `chromium.launch({ channel: 'msedge' })` 启动**真实的 Microsoft Edge**
进程来渲染离线夹具页 —— 一套与 Electron 无关、但会争用系统资源的外部进程。

`theme-switcher` 的失败点恰好是**它自己的第一个用例、最早的一次界面读取**
（`beforeAll` 启动 Electron → 第一个测试立刻读 `.target`）。集成阶段
（240.8s，`--maxWorkers=1` 制造大量临时文件）刚结束，前 8 个用例的 msedge
又刚跑完，此时正是 I/O 与进程表最拥挤的时刻，**目标发现这条需要
`realpath` + `stat` + 读 asar 的链最容易在首次调用时被拖慢/失败**。

### 7.4 当前定性（诚实边界）

- **可复现，但不是确定性的**：实验 5/6 复现、实验 8 同形状未复现 → 属
  **时序相关的间歇失败**，不能宣称「必然发生」。
- **失败是真的**：界面确实落到了 `未发现目标` 空态，不是断言写错、
  不是测试被绕过。门禁**正确地把一个真实的产品级脆弱点拦下来了**。
- **触发条件已收窄到**：同一次 `test:e2e` 中「先跑 msedge 系用例 + 集成刚结束」
  的拥挤窗口里，`theme-switcher` 的首次 `discoverTargets` 可能返回空。
- **尚未取得**：主进程侧 `discoverTargets` 的逐候选根日志（`scanned` 为空还是
  `inspectRoot` 失败）。缺这一条，**不对「是谁拖慢/拒绝了首次发现」做最终归因**，
  也不排除是 Electron 启动早期的自我竞态。

### 7.5 处置

- 本项**未改任何产品代码与断言**，未放宽 e2e 超时，未重跑掩盖失败。
- 失败的原始日志、失败用例、预期/实收字符串已完整保留（`E-release4.log`，
  §7 上引）。
- 发布候选 `candidate-20260916081110-b64203e-408e68` 因此**未完成**，
  `ALL_GREEN` **未产出**。
- 真实安装→应用→重启→恢复仍**需用户当次授权**，本项未执行。

### 7.6 建议的下一步（待用户决策，均需确认后再动）

1. **给 `theme-switcher` 的首次目标发现加重试/等待**（renderer 侧对
   `discoverTargets` 的空结果做有限次自愈，而非直接渲染「未发现目标」）——
   针对用户可感知的症状。
2. **把 `background-cascade` 与 `theme-switcher` 拆到不同 worker/不同
   `test:e2e` 步骤**，消除 msedge 与 Electron 的资源争用窗口 —— 针对触发条件。
3. **在 `discoverTargets` 里补一条诊断日志**（候选根 + `scanned` + 每个
   `inspectRoot` 的失败码），下次复现时直接拿到主进程侧证据 —— 先把归因坐实。

三者都不放松门禁；**1 和 2 有实际修复价值，3 是取证前置**。

### 7.7 链序复刻的收尾结果（`tools/e2e-chain-repro.cjs full`）

按 `release-build.cjs` 的真实调用方式复刻「`test:unit` → `test:integration`
→ `test:e2e`」三步（含各步真实 env），结果：

```
=== test:unit ===        TEMP=<项目盘>/.cache/ots-test-tmp/run-58020-...
  EXIT test:unit = 1 (543.7s)   ← 229/229 通过，但触顶 9min 被 SIGTERM
=== test:integration === TEMP=<项目盘>/.cache/ots-test-tmp/run-58020-...
  EXIT test:integration = 1 (543.1s)  ← 同样触顶，未取得汇总行
=== test:e2e ===         TEMP=C:\Users\ylzho\AppData\Local\Temp   ← 无 testEnv()
  EXIT test:e2e = 0 (54.0s)     ← 16 passed
```

两条结论：

1. **`test:e2e` 在链序复刻里通过了**（16/16）。这与 §7.1 实验 8 一致，
   进一步支持 §7.4 的定性：**e2e 那次失败是时序相关的间歇失败**，
   不是可稳定复现的确定性缺陷。**不对它宣称「必然发生」。**
2. **`test:unit` / `test:integration` 的 9 分钟触顶是稳定复现的**，
   且**与 `release-build.cjs` 里 `test:e2e` 不传 env 这件事无关** ——
   两者都拿到了 `testEnv()` 的重定向，仍然触顶。这再次坐实 §3 的归因：
   是**包装层临时根落在项目盘**导致的，与 e2e 无关。

### 7.8 链上 env 的一处编排不一致（已取证，未改）

`release-build.cjs` 里 `test:unit` 与 `test:integration` 都显式传
`{ env: testEnv() }`（把 `TEMP`/`TMP` 指向项目盘 runDir），
而 `test:e2e`（`:522`）与 `test:e2e:electron`（`:523`）**不传 env**，
于是 `runStep` 走到 `env: opts.env || process.env`（`:132`），
**e2e 实际继承外层 shell 的 `TEMP`，而不是与 unit/integration 一致的 runDir**。

这本身**不是** §7 那次失败的原因（§7.7 已证明 e2e 在不重定向时通过），
但它是一处**编排意图与实际行为不一致**：要么是刻意（e2e 需要系统 Temp），
要么是漏了。建议在 §7.6 的三条之外，**单列为待确认项**，避免后人误判。

## 8. 发布链第五次尝试：推进到 `verify:release`，新阻断点

提交 `60bf282`（本轮 e2e 取证）后重跑，buildId = `20260916094710-60bf282-cbc753`，
`OTS_TEST_TMP` 指向系统盘：

| 步骤 | 结果 |
|---|---|
| typecheck | 0（61.9s） |
| lint | 0（8.8s） |
| **test:unit** | **0（12.1s）** ← 229/229 |
| build | 0（68.1s） |
| **test:integration** | **0（234.1s）** ← 179/179 |
| **test:e2e** | **0（40.7s）** ← **16 passed** |
| **test:e2e:electron** | **0（8.1s）** ← 41 项检查全 `[OK]` |
| audit | 0（3.9s）← FAIL 0 / WARN 0 |
| dist | 0（89.7s） |
| smoke:gui | 0（15.8s）← **E 项开关修复生效** |
| verify-package | 0（2.3s） |
| register | 0（3.4s） |
| **verify:release** | **1（4.9s）** ← **STOPPED** |

两条正面结论：

1. **§7 的 e2e 失败确认为间歇失败**：同一条链这次 `test:e2e` **16/16 通过**
   （36.2s），与 §7.7 的链序复刻一致。**不再把它当作确定性缺陷**。
2. **test:e2e:electron 的 41 项检查全绿**，其中包含 D 项新增的三条：
   ```
   [OK] 遗留准备区已就位（独立实例，无同进程句柄）
   [OK] 启动清理确实删除了遗留准备区（计数 >= 1） | cleaned=1
   [OK] 遗留准备区目录已被物理删除
   [OK] 无遗留准备区时计数为 0（不把没删掉任何东西报成清理成功） | cleaned=0
   ```
   D 项的修复在真实 Electron 里得到独立验证。

### 8.1 新阻断点：`verify:release` 把 zip 的目录条目误判为「多出的文件」

```
[FAIL] zip 内部与候选目录逐条目一致 | zip 内多出磁盘没有的条目：resources/app.asar.unpacked/；
       zip 内多出磁盘没有的条目：resources/app.asar.unpacked/node_modules/；
       zip 内多出磁盘没有的条目：resources/app.asar.unpacked/node_modules/@img/
RELEASE_VERIFY FAILED
```

**根因（已用直接读 zip 中央目录坐实）**：

```
candidate-20260916094710-60bf282-cbc753.zip
  条目总数 = 82
  以分隔符结尾的目录条目 = 3        ← 恰好就是报错的那三条
    resources\app.asar.unpacked\
    resources\app.asar.unpacked\node_modules\
    resources\app.asar.unpacked\node_modules\@img\
```

对照 `tools/verify-release.cjs` 的两个函数：

- `listFilesRecursive`（建 `diskMap`）**只收集文件** —— 目录不进 map；
- `checkZipMatchesDir` 把 zip 条目名 `\` → `/` 归一化后直接查 `diskMap`，
  查不到就报「zip 内多出磁盘没有的条目」。

于是**每一个目录条目都必然被误报**。这是**比较口径不对称**（zip 含目录条目
vs 磁盘侧只枚举文件），不是产物真的多文件 —— 那 3 个目录在磁盘上**确实存在**，
只是里面到 `@img/sharp-win32-x64/` 才有文件，中间层级成了「对文件枚举不可见」的目录。

**为什么以前没炸**：这是**潜伏的工具缺陷**，此前从未被触发。

| zip | 条目 | 目录条目 | 结果 |
|---|---|---|---|
| `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.zip`（旧，schema/1，手工 repack） | 81 | **0** | 该检查历来通过 |
| `candidate-20260916094710-60bf282-cbc753.zip`（新，schema/3，`electron-builder --dir`） | 82 | **3** | 首次触发 |

`release-build.cjs` 改用 `electron-builder --win --dir` 直出候选目录（`:556`），
该布局下 `resources/app.asar.unpacked/node_modules/@img/` 这类
**「自身无文件、只有子目录」的层级**被 `Compress-Archive` 写成显式目录条目，
而这个检查**只对着旧的手工 repack zip 验证过**。

`verify-release.cjs` 最近三次改动为 `f848d0f` / `6947483` / `33925dd`，
**均早于本轮 A–E 的改动** —— 不是本轮引入的回归。

### 8.2 处置

- 本轮**未改** `verify-release.cjs`：该比较口径属独立缺陷，与 N1–N5 修复无关。
  按计划「不扩展范围」，本项**只取证与记录**，并把复现命令写清（见 8.1）。
- 未放宽检查、未删目录条目、未改 zip 打包方式来「让门禁变绿」。
- `ALL_GREEN` **仍未产出**，候选 `20260916094710-60bf282-cbc753` **未完成**。
- 真实安装→应用→重启→恢复**需用户当次授权**，未执行。

### 8.3 建议修法（待用户决策，二选一，均不放松判据）

比较口径对称化，任选其一：

1. **盘侧也枚举目录**（推荐）：让 `listFilesRecursive` 同时产出目录条目
   （以 `/` 结尾），与 zip 的目录条目一一对应。这样「磁盘多/zip 少」
   两个方向都能真正校验到目录层级。
2. **比 zip 侧跳过目录条目**：忽略以 `/` 结尾的条目。改动更小，
   但会**失去对目录层级的校验能力**（zip 里凭空多一个空目录将不被发现）。

另建议补一条**回归测试**：用含「自身无文件、只有子目录」层级的夹具目录
打 zip，断言不再产生假不一致 —— 防止同类潜伏缺陷再次逃逸。



