# P4 阻塞诊断报告

日期：2026-09-14
源码冻结：`5689cf710dadacabf21e804c97aad2827ba55551`（P3 提交）
本轮性质：**只诊断，不改代码**（用户 2026-09-14 决定）
结论：**NO-GO**（P4 未产出候选，发布链未达 `ALL_GREEN`）

> **[2026-09-14 复诊纠偏]** 本报告已被同目录
> `diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md` 复诊。**第 4 节阻塞 3
> （`candidate-manifest.cjs:283` `--root` 缺陷）判定撤销**，第 1/3 节若干过强表述已按
> 证据收窄（见文末「复诊纠偏」）。第 2 节构建事实与退出码仍然有效，保留不动。

---

## 1. 一句话结论

P4 构建链在 `test:integration` 停止。串行受控复测**未复现业务断言失败**，
但**测试执行基础设施未能完整、无错误地完成** —— 遗留 `onTaskUpdate` RPC 超时，
它独立于业务断言却把退出码拉成 1，使发布链**到不了 `ALL_GREEN`**。

判定：当前最直接的阻塞是**测试执行基础设施（受控并发 + worker 同步阻塞）**，
不是已证明的产品业务回归。详细技术判断与修复方案见
`diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`。

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
- **仅 1 项是断言失败**：`transaction.test.ts:160 > 重复应用同一主题为 no-op`
  → `AssertionError: expected false to be true`。
  **复诊更正**：该处失败的是**第一次 `applyTheme` 的 `success` 为 false**，
  **尚未进入第二次调用的 no-op 判定**；原断言只显示布尔值，未记录 `error.code/detail`，
  因此**不能据此定位 no-op 逻辑，也无法判断是否由文件锁导致**。
- **仅 1 项非超时的 I/O 错误**：`image-content-fixed.test.ts` →
  `EPERM: operation not permitted, open '...\ots-test-tmp\ots-a2-src-edbT5d\wallpaper.jfif'`
  → 对合成 `wallpaper.jfif` 的覆盖写入被拒。
  **复诊更正**：日志**不含持锁进程、句柄、ACL 或安全事件证据**，不能指认某个安全进程持锁。
  改述为「**环境相关访问失败，原因未定**」；本轮受控复测未复现。不得据此关闭安全软件或强杀进程。

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

### 第 3 轮：全量 `tests/integration` 串行 → **本报告汇总不完整（复诊更正）**

```
EXIT=1（原因仅为 Unhandled Error）
Test Files  7 passed (15)      ← 只有 7 个文件被完整计入
Tests  84 passed (84)
Errors  1 error  [vitest-worker]: Timeout calling "onTaskUpdate"
Duration  376.15s
```

> **复诊更正（重要）**：本轮的 `7 passed (15)` 说明**还有 8 个文件未被完整计入**。
> 原报告据这份**部分结果**推出「全部 16 项都是假失败」，**证据不足**；更不能断言
> 「worker 只是丢报、实际都跑完了」。
>
> 复诊轮以 `--maxWorkers=1 --no-file-parallelism` 完整复跑，才汇总到
> **15 文件 / 172 测试**（仍有 1 个 RPC 错误、exit 1）。这支持
> 「**在当前受控配置中未观察到业务断言失败**」，**不等于穷尽证明所有并行情形都是环境假失败**。

**修正后的表述**：
`并行失败包含超时、访问被拒和首次应用失败；受控复测未复现业务断言失败，
具体环境来源待证实，RPC 错误仍需修复。`

### 对比总表

| 模式 | 断言失败数 | 退出码 | 说明 |
|---|---|---|---|
| 并行（默认） | 1 项断言 + 15 项超时 | 1 | 含超时、访问被拒、首次应用失败 |
| 受控串行（`--maxWorkers=1 --no-file-parallelism`） | **未复现业务断言失败** | 1 | 仍剩 `onTaskUpdate` Unhandled Error |

> 注：不能由本表推出「并行失败全部是假失败」——受控复测只能说**未复现**，
> 具体环境来源待证实。

---

## 4. 阻塞点（复诊后：2 项成立，1 项撤销）

### 阻塞 1：`onTaskUpdate` 是**任务更新 RPC**，不是独立心跳（**发布链主因**）

**复诊更正**：原报告称之为「心跳超时」不准确。本机 Vitest 3.2.7 已安装代码表明：

- `node_modules/vitest/dist/chunks/index.CwejwG0H.js:47` 把任务更新转为 `rpc().onTaskUpdate(...)`；
- `rpc.-pEldfrD.js:49` 在该 RPC 超时后抛错；
- `index.B521nVV-.js:3` 的默认 RPC 超时为 `6e4` = **60 秒**；当前 fork 的 RPC 选项未覆盖此值。

它与 `testTimeout: 30_000` / `hookTimeout: 30_000` **不是同一超时层**：
**只改测试用例时限不解决 RPC 回执超时**。本地也未发现项目可直接配置的「心跳超时」选项，
**不应凭空增加一个 Vitest 不识别的配置字段**。

**优先修复方向 —— 消除 worker 侧的同步子进程阻塞**（高优先级假说，非已证明的唯一根因）：

- `tests/integration/candidate-manifest.test.ts:14` 大量使用 `execFileSync` / `spawnSync`。
  夹具创建、git 配置/add/commit、登记 CLI 及 check 都同步执行。
- 等待同步子进程期间，**测试 worker 自己的事件循环不能正常处理 IPC 消息**，
  于是 `onTaskUpdate` 回执无法及时发出 → 60 秒后超时。
- 注意区分：**独立 CLI 内部用同步 Git 不一定有问题**；问题优先在
  **Vitest worker 用同步方式等待 CLI**、以及连续执行同步夹具操作。
  无需第一步就重写产品的全部 Git 逻辑。
- 本轮观察支持该假说：独立候选套件 42.10s 测试耗时、无 RPC 错误；
  完整单 worker 集成中该套件 72.372s，其余套件明显较快，全部断言通过但出现 60 秒 RPC 错误。
- **若异步化后仍出现 RPC 错误，必须继续调查 IPC/reporter/环境，不得硬写「已修好」。**

### 阻塞 2：`EPERM` 访问被拒（**原因未定**）

- `image-content-fixed.test.ts` → `EPERM: operation not permitted, open
  '...\node_modules\.cache\ots-test-tmp\ots-a2-src-edbT5d\wallpaper.jfif'`。
- **复诊更正**：日志**不含持锁进程、句柄、ACL 或安全事件证据**，不能指认某个安全进程持锁。
  `r5-run-suite.cjs` 注释记载过「本机安全进程可能持久锁文件」的背景，但那是**背景说明**，
  不等于本次有锁持有者证据。
- 表述保留为「**环境相关访问失败，原因未定**」。
- **禁止**关闭安全软件、修改系统防护设置或强杀进程；本轮未删除旧日志中被占用的文件。
- 受控完整串行运行**未复现**该 EPERM。

### 阻塞 3：~~`candidate-manifest.cjs` 的 `--root` 契约缺陷~~ —— **判定撤销（误读）**

**复诊结论：原判定不成立，撤销。** 依据：

- `tools/candidate-manifest.cjs:40` 声明的是 `let ROOT`（可变）；
- `applyRoot(opts)`（`:134`）执行 `ROOT = r`；
- `register` **先调用 `applyRoot`**，之后才用 `ROOT` 查询 `git log`。

因此 `ROOT` 在 `--root` 生效后**就是目标根**，并非「不可变宿主根」——原报告属误读。

本轮端到端实测（真实调用 `register`，非纯函数）：

```text
夹具 HEAD             = 88675855eadad7c870e346ab9a84fe6747c306f6
manifest sourceCommit = 88675855eadad7c870e346ab9a84fe6747c306f6
manifest Subject      = "fixture init"        ← 与夹具一致，非宿主仓库主题
```

复诊轮的同类观测：`sourceCommit 004d1f3c…` / `sourceCommitSubject fixture init`，
与该夹具 `git log` 完全一致。

**处置**：**不安排代码修复**。可给现有正例补一条
`expect(m.sourceCommitSubject).toBe('fixture init')` 断言，防止以后回归（属任务 A 范围）。

---

## 5. 未修项与理由（首次诊断轮：只诊断）

| 项 | 决定 | 理由 |
|---|---|---|
| 编排器集成测试改受控并发 | **未改** | 用户选择先出诊断（→ 复诊后转任务 B） |
| ~~vitest worker RPC 超时调整~~ | **放弃该方向** | 复诊查明项目侧无对应配置项，不得凭空造字段或改 `node_modules` |
| ~~`candidate-manifest.cjs:283` bug~~ | **判定撤销，无需修复** | 复诊证明 `applyRoot` 已正确设置 ROOT，原属误读 |
| 测试用例 / 阈值 | **未动** | 不放宽门槛、不删不跳（计划硬约束） |

**本轮（2026-09-14 首次诊断）未做任何源码改动**，当时工作树冻结在 `5689cf7`。
（后续 `55ba0e4` 提交仅含本报告与执行状态文档，不含源码。）

---

## 6. 对发布链的影响与可选处置（供决策，未执行）

**复诊更正**：原第 2 项「调长 vitest worker RPC 心跳超时」**不可行**——
经查 Vitest 3.2.7 已安装代码，该 60 秒是 RPC 默认值且项目侧无对应配置项，
**不应凭空增加 Vitest 不识别的字段**；也不得改 `node_modules` 里的常量。

修正后的处置方向（详见 `diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`）：

1. **任务 A（优先）**：把 worker 侧子进程等待**异步化**，消除事件循环阻塞 —— 根治方向。
2. **任务 B**：发布模式固定受控并发 `--pool=forks --maxWorkers=1 --no-file-parallelism`
   （**不使用 `singleFork`**），并接入完整性检查（应跑文件集合 = 实际完成集合、
   Unhandled Error 0）。**单靠 B 仍会 RPC 报错，必须配合 A。**
3. 若要临时分组执行，必须清单化分组且两组之和覆盖全部集成测试，**不得变成漏测**。

**任何方案都不得**用删除/跳过用例、或提高断言超时阈值的方式「变绿」；
也不得忽略 Unhandled Error。

---

## 7. 当前状态

- P4：**阻塞**（`已实现但未整链验证` + `完整测试有基础设施错误`），未产出候选。
  buildId `20260914-alpha1-p3full` 的候选目录不存在。
- 当前 HEAD：`55ba0e4`（诊断文档提交）；上次构建源码来源：`5689cf7`。
- P5（真实安装闭环）：需当次授权，未执行。
- P6（材料与 GO/NO-GO）：待执行。
- 总体结论：**NO-GO**。

### 状态词使用约定

`已实现但未整链验证` / `定向测试通过` / `完整测试有基础设施错误` /
`候选工程验证通过` / `真实闭环通过` —— 五者含义不同，**不得互相代替**。

### 证据文件位置

| 内容 | 路径 |
|---|---|
| 首次构建完整日志 | `node_modules/.cache/ots-test-logs/suite-2026-09-14T03-04-20-111Z-9072.log` |
| 受控串行全量集成日志（部分汇总） | `node_modules/.cache/ots-test-logs/suite-2026-09-14T03-23-27-401Z-9390.log` |
| 串行 transaction 日志 | `node_modules/.cache/serial-t.log` |
| 编排器标准输出 | `%TEMP%\p4-build.log`（本机即 `C:\Users\ylzho\AppData\Local\Temp\p4-build.log`） |
| 复诊报告与证据 | `diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md`、`diagnosis-2026-09-14/evidence/` |

---

## 8. 复诊纠偏小结（2026-09-14）

复诊由 `diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md` 发起，本节汇总本报告被更正的判定：

| 原表述 | 复诊结论 | 依据 |
|---|---|---|
| 「并行下报的 16 项失败**全部**是资源竞争假失败」 | **证据不足，收窄为**「受控复测**未复现**业务断言失败，来源待证实」 | 原串行日志仅 `7 passed (15)`、`84 passed (84)`，**8 个文件未完整计入** |
| 「发布链**永远**到不了 `ALL_GREEN`」 | **收窄为**「到不了 `ALL_GREEN`」（当前阻塞，可通过任务 A/B 解决） | 阻塞根因可修，非不可逆 |
| 「`onTaskUpdate` 是**独立心跳**超时」 | **更正**：是**任务更新 RPC** 超时（默认 60s），与 `testTimeout`/`hookTimeout` 不同层 | Vitest 3.2.7 已安装代码 |
| 「EPERM 是安全软件/索引进程**锁定**」 | **更正**：日志无持锁者证据，改述「**环境相关访问失败，原因未定**」 | 无句柄/ACL/安全事件证据 |
| 「`transaction` no-op 用例失败 = no-op 逻辑问题」 | **更正**：失败在**第一次 `applyTheme` 的 `success=false`**，未进入 no-op 判定；断言未记录 `error.code/detail` | `transaction.test.ts:160` |
| 「`candidate-manifest.cjs:283` 的 `--root` 契约缺陷」 | **判定撤销（误读）**：`applyRoot` 已设 `ROOT=r`，实测 `sourceCommitSubject='fixture init'` 与夹具一致 | `:40` `let ROOT`、`:134` `ROOT=r`、端到端实测 |

**保留有效的内容**：第 2 节的构建事实与逐步退出码、编排器失败关闭行为、
以及「不得删/跳用例或放宽阈值」的约束。
