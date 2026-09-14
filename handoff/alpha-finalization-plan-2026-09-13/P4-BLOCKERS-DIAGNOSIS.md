# P4 阻塞诊断报告

日期：2026-09-14
源码冻结：`5689cf710dadacabf21e804c97aad2827ba55551`（P3 提交，未变动）
本轮性质：**只诊断，不改代码**（用户 2026-09-14 决定）
结论：**NO-GO**（P4 未产出候选，发布链未达 `ALL_GREEN`）

---

## 1. 一句话结论

P4 构建链在 `test:integration` 停止。经三轮串行复测证明：
**串行下零断言失败，并行下报的全部 16 项失败都是资源竞争造成的假失败。**
遗留一个真实问题 —— vitest 的 `onTaskUpdate` 心跳超时，它独立于断言结果却把退出码
拉成 1，使发布链**永远到不了 `ALL_GREEN`**。三条阻塞点均非源码逻辑缺陷，未修。

---

## 2. 发生了什么

### 2.1 构建命令与逐步退出码

```
node tools/release-build.cjs build 20260914-alpha1-p3full
```

| 步骤 | 退出码 | 耗时 | 备注 |
|---|---|---|---|
| typecheck | 0 | 16.0s | |
| lint | 0 | 94.7s | |
| test:unit | 0 | 27.7s | 174 项全过 |
| **test:integration** | **1** | 379.1s | **在此停止** |
| build ～ verify:release | — | — | 未执行（编排器失败即停） |

编排器输出 `STOPPED at test:integration`，**无 `ALL_GREEN`**，未产出半成品候选，
未执行 `dist` / `zip` / `register`。**编排器行为完全正确**（失败关闭，不静默降级）。

### 2.2 首次失败的形态（并行，默认模式）

`Test Files 8 failed | 7 passed (15)`、`Tests 16 failed | 156 passed (172)`：

- **15 项是纯超时**：`Test timed out in 30000ms` / `Hook timed out in 30000ms` /
  `[vitest-worker]: Timeout calling "onTaskUpdate"`。
- 单文件耗时被拉到 **80s–366s**（正常全套约 1–2 分钟），是典型资源饥饿特征。
- **仅 1 项是断言失败**：`transaction.test.ts > 重复应用同一主题为 no-op`
  → `AssertionError: expected false to be true`。
- **仅 1 项非超时的 I/O 错误**：`image-content-fixed.test.ts` →
  `EPERM: operation not permitted, open '...\ots-test-tmp\ots-a2-src-edbT5d\wallpaper.jfif'`
  → 临时目录文件被安全软件/索引进程锁定。

---

## 3. 三轮串行复测（决定性证据）

复测参数：`--pool=forks --poolOptions.forks.singleFork --no-file-parallelism`

### 第 1 轮：两个套件

| 对象 | 结果 |
|---|---|
| `transaction.test.ts` | 首次失败那一项**未被报告**；另一文件 `candidate-manifest.test.ts` **14/14 全过**（189s） |
| 遗留 | vitest 报 1 个 Unhandled Error `onTaskUpdate` → 退出码 1 |

### 第 2 轮：`transaction.test.ts` 单独运行 → **干净通过**

```
EXIT=0
Test Files  1 passed (1)
Tests  29 passed (29)     ← 含并行时失败的「重复应用同一主题为 no-op」
Duration  130.67s
无 Unhandled Error
```

**这是最关键的一条证据**：并行下断言失败的那一项，串行下通过。

### 第 3 轮：全量 `tests/integration` 串行 → **零断言失败**

```
EXIT=1（原因仅为 Unhandled Error）
Test Files  7 passed (15)
Tests  84 passed (84)     ← 零断言失败
Errors  1 error  [vitest-worker]: Timeout calling "onTaskUpdate"
Duration  376.15s
```

逐项全 ✓，包括并行时全部失败的：`main-services` 9 项、`image-content-fixed` 9 项、
`archive-verify` 16 项、`image-format-cycle` 1 项、`image-import-formats` 15 项、
`stage-idempotence` 20 项、`candidate-manifest` 14 项（单文件 214s）。

> 汇总行 `Test Files 7 passed (15)` 与 `Tests 84 passed (84)` 不一致：7 个文件的 84 项
> 通过、另 8 个文件用例未计入汇总。这是 vitest 在 worker RPC 中断后**丢报**的表现，
> 进一步印证问题在 worker 通信层，不在测试逻辑。

### 对比总表

| 模式 | 断言失败数 | 退出码 | 说明 |
|---|---|---|---|
| 并行（默认） | 1 项断言 + 15 项超时 | 1 | 假失败为主，偶发真断言假失败 |
| 串行（单 fork） | **0 项** | 1 | 只剩 `onTaskUpdate` Unhandled Error |

---

## 4. 三条阻塞点

### 阻塞 1：`onTaskUpdate` 心跳超时（**发布链主因**）

- **现象**：`Error: [vitest-worker]: Timeout calling "onTaskUpdate"`。
- **触发条件**：单个文件耗时过长时出现。本例 `candidate-manifest.test.ts` 214s，
  其 14 项各 **10.3–26.5s**，每项都在反复 spawn `git.exe`（夹具 init/add/commit/rev-parse、
  工具内部再查 `git status`，每次 spawn 在本机约 0.6–1.5s）。
- **性质**：vitest worker↔主进程的 **RPC 心跳超时**，**独立于断言结果**。
  它不会让任何用例失败，但会让 vitest 退出码变 1 → **发布链永远到不了 `ALL_GREEN`**。
- **为什么不是代码缺陷**：串行下所有断言通过；P3 提交未触碰 `src/` 下图片/事务代码；
  同一次运行的 `test:unit` 174 项全绿（含 P2 新增的 `deepVerifyZip`/`verify-release`）。

### 阻塞 2：`EPERM` 临时文件锁

- `image-content-fixed.test.ts` → `EPERM: operation not permitted, open
  '...\node_modules\.cache\ots-test-tmp\ots-a2-src-edbT5d\wallpaper.jfif'`。
- 本机安全进程会持久锁 `node_modules/.cache` 下的文件（`r5-run-suite.cjs` 注释亦已记载
  该现象）。属**机器环境问题**，串行下未复现。

### 阻塞 3：`candidate-manifest.cjs` 的 `--root` 契约缺陷（本轮新发现）

`tools/candidate-manifest.cjs:283`：

```js
sourceCommitSubject: execFileSync('git',
  ['log', '-1', '--format=%s', sourceCommit], { cwd: ROOT, ... }).trim(),
```

- **问题**：用的是 `cwd: ROOT`（脚本所在仓库），而不是已由 `--root` 解析出的目标根。
- **后果**：夹具场景下 `sourceCommitSubject` 取到的是**宿主仓库的提交主题**，不是夹具的。
  实测旧候选：`sourceCommit=871703d…` → `sourceCommitSubject="候选包重封：修复三个让包跑不起来的打包缺陷…"`
  （恰好巧合正确，因为那次本来就在本仓库登记；但夹具下必然错）。
- **严重性**：**元数据错误，不影响冻结/来源绑定的判定主权**
  （主权在 `sourceCommit` / 锁文件 hash / `out` 三项核对上）。但 `--root` 契约不完整，
  属真实缺陷。
- **处置**：按用户决定**记入清单，本轮不修**。

---

## 5. 未修项与理由（用户决定：只诊断）

| 项 | 决定 | 理由 |
|---|---|---|
| 编排器集成测试改串行 | **未改** | 用户选择先出诊断 |
| vitest worker RPC 超时调整 | **未改** | 同上 |
| `candidate-manifest.cjs:283` bug | **记入清单，不修** | 用户明确「记入清单，本轮不修」 |
| 测试用例 / 阈值 | **未动** | 不放宽门槛、不删不跳（计划硬约束） |

**未做任何源码改动**，工作树仍冻结在 `5689cf7`（仅 `handoff/` 路径有未跟踪/改动，属豁免）。

---

## 6. 对发布链的影响与可选处置（供决策，未执行）

1. **编排器让集成测试走串行/限并发**：最保守、可审计，代价是集成约 6.3 分钟。
2. **调长 vitest worker RPC 心跳超时**：直接治 `onTaskUpdate`，但属改测试基础设施参数，
   需论证「不算放宽通过门槛」。
3. **拆分长耗时套件分别运行**：让 `candidate-manifest.test.ts` 独占一进程，降低单文件时长。

**任何方案都不得**用删除/跳过用例、或提高断言超时阈值的方式「变绿」。

---

## 7. 当前状态

- P4：**进行中 / 阻塞**，未产出候选，buildId `20260914-alpha1-p3full` 的候选目录不存在。
- P5（真实安装闭环）：需当次授权，未执行。
- P6（材料与 GO/NO-GO）：待执行。
- 总体结论：**NO-GO**。

### 证据文件位置

| 内容 | 路径 |
|---|---|
| 首次构建完整日志 | `node_modules/.cache/ots-test-logs/suite-2026-09-14T03-04-20-111Z-9072.log` |
| 串行全量集成日志 | `node_modules/.cache/ots-test-logs/suite-2026-09-14T03-23-27-401Z-9390.log` |
| 串行 transaction 日志 | `node_modules/.cache/serial-t.log` |
| 编排器标准输出 | `%TEMP%\p4-build.log`（本机即 `C:\Users\ylzho\AppData\Local\Temp\p4-build.log`） |
