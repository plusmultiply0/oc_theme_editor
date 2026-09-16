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



