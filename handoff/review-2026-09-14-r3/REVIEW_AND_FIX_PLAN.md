# 第三轮复审：问题与可执行解决方案

日期：2026-09-14；实际仓库：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。

用户消息中的嵌套目录 `D:\zjcfile\weblearn\vibecoding\OpenCode\_Theme\_Switcher` 不存在。本报告保存到实际仓库 `handoff/review-2026-09-14-r3/`，没有另建项目。

## 1. 结论

**修复有明显进展，但仍不建议宣布 Alpha 发布验证完成。** 上轮的主要设计问题已着手修正，本轮发现的重点转为：构建身份交叉校验、阶段成功标记、严格测试结果的边界校验，以及交接材料同步。

本轮仅审查、定向测试、创建隔离微型夹具与报告；未修改业务代码，未构建或打包项目，未启动真实/模拟 exe，未改 OpenCode 安装，未删除旧候选或改变安全控制。

### 审查基线（务必保留）

- HEAD：`33925dd60921bd7963d7c0a496cdcb61ee071ae7`。
- 新提交：`4ddf644`（R1+R2）、`33925dd`（R3）。
- 检查的是 HEAD **加工作树内容**：`tools/release-build.cjs`、`tools/test-release-gate.cjs` 有既存未提交修改，主要是 R4 构建顺序/out 快照。未提交不等于代码缺陷，但不能把该工作树的验证结果归为纯 HEAD 提交的结果。
- 本轮保留这些修改；对应差异在 `evidence/reviewed-working-tree.patch`。六个关键文件 SHA256 记录于 `evidence/results.json`，便于后续 agent 判断是否又有变更。

### 上轮问题处置状态

| 上轮问题 | 当前检查结果 |
|---|---|
| R1 发布生命周期自引用 | 已拆为不可变 build-record/2 与独立 receipt；本轮真实合成候选 core/发布级核验可以分别执行，旧的必然失败环已消除 |
| R2 记录自行缩减必检集合 | 已按可信 policyVersion 校验集合并拒绝重复步骤；相关单测通过；不要重做旧方案 |
| R3 不核对完成文件集合 | 已接入 vitest list + JSON reporter，严格入口实际跑通；仍有下文 S3/S4 边界问题 |
| R4 集成使用旧 out | 工作树已把 build 提前到集成之前，并加入构建后/打包前 out 清单比较；未做真实整链验收，暂列“已有实现” |
| R5 环境诊断和安全处置文档 | 仍未完成，见 S6 |

### 本轮验证

- `npm.cmd run typecheck`：exit 0。
- `npm.cmd run lint`：exit 0。
- 新严格入口定向单测：**3 文件/43 项通过**，failed/skipped/todo/pending/Unhandled Error 均为 0。
  - release-eligibility：24；run-suite-wrapper：10；smoke-packaged：9。
- `node tools/audit.cjs`：exit 0，FAIL 0、WARN 0。它是仓库自定义审计，不是依赖漏洞扫描或完整候选验证。
- 隔离微型候选：真实执行当前 register/core verify/发布级 verify，复现 S1、S2；纯函数/派生参数夹具复现 S3、S4。
- 本轮没有跑全量集成、完整门禁脚本、E2E、真实 GUI 或真实安装闭环。没有新图片功能修改；不把上轮图片测试结果记为本轮实测。

## 2. 问题清单

| 编号 | 等级 | 问题 | 证据 |
|---|---|---|---|
| S1 | P1 | 构建记录属于 A，却能配 B 的 manifest/receipt 通过发布级核验 | 真实微型候选 CLI 复现 |
| S2 | P1 | core 核验与最终发布使用相同成功标记，shell 又自行补 ALL_GREEN | core 真实复现；shell/最终分支静态定位 |
| S3 | P2 | 严格结果校验把缺失 assertionResults 当成零项成功 | 当前纯函数复现 |
| S4 | P2 | 包装器参数解析会改变过滤条件，strict 默认不禁止 skip | 派生参数夹具 + CLI 源码 |
| S5 | P2 | 正常 builder 链登记时被标记为 manual-repack | 调用链静态定位 + 登记器默认行为复现 |
| S6 | P2 | 运行手册/状态表落后于代码，并保留不安全的环境处置建议 | 文档原文核对 |

## 3. 逐项修复与验收

### S1 · P1：缺少 record 与 manifest 的同一次构建身份校验

定位：`tools/candidate-manifest.cjs:255`、`:276`、`:303`；`tools/verify-release.cjs:534`；`tools/test-release-gate.cjs:570` 附近。

登记器验证了 record.sourceCommit/version/out，却使用 `opts.buildId || record.buildId` 生成 manifest，并不拒绝二者不同。核验器检查 manifest 与 CLI、receipt 与 manifest，却未交叉检查 record.buildId。

本轮真实微型夹具结果（不是 stub 核验）：

```text
record.buildId   = original-build
manifest.buildId = renamed-build
receipt.buildId  = renamed-build
register exit   = 0
发布级 verify exit = 0  ← 应拒绝
```

这是身份一致性漏洞，不是声称真实候选已经被人篡改。相同提交可以有多次构建，buildId 被设计为一次构建的身份，不能静默改名。现有门禁测试甚至要求“另一 buildId 的第二份登记成功”，随后只检查拿旧 CLI buildId 去验新 manifest 会失败，漏掉了“全部外部参数一起改成新 ID，但 record 仍旧”的负例。

**执行方案：**

1. 增加共享 `checkRecordBinding(record, context)`；record.buildId 必须是非空字符串，显式 --build-id 如提供，必须与之相等。
2. register 在任何新 manifest 写入前验证 buildId、sourceCommit、version、lockfileSha256、out。锁文件 hash 应为必填，不能采用“字段有才比较”的条件。
3. 发布核验端独立执行同样的交叉校验，不假设所有 manifest 一定由当前登记器正确写出。
4. receipt 绑定的身份必须同时等于 record 和 manifest；保留不可变 record，不通过修改旧记录来消除不一致。
5. 如确有“同一构建多次发布/重新包装”需求，另引入 registrationId/packageId 并明确 schema，不冒用 buildId 表示登记别名。

**回归验收：**

- A/A/A 正例通过。
- record=A、manifest/CLI/receipt=B 的完整组合必须失败。
- 缺 record.buildId、缺锁文件 hash、记录与 manifest 的提交/版本不符均明确失败。
- 修改现有“第二份登记另一 buildId 成功”的用例：它应在登记阶段失败；再独立构造错误 manifest，证明核验端也会拒绝。
- 原有二次只读核验与哈希不变用例继续通过。

### S2 · P1：阶段成功被打印成发布成功

定位：`tools/verify-release.cjs:538`、`:653`；`tools/release-build.cjs:582`、`:598`；`tools/release-gate.sh:51`、`:61`；`tools/test-release-gate.cjs:534` 附近。

真实夹具在**尚无 receipt**时：不带发布资格旗标的 core verify 返回 0 且打印 `RELEASE_GREEN`；带 `--require-release-eligibility` 的终检返回 1。这说明资格拒绝本身有效，但日志没有区分“产物基础核验通过”和“发布资格通过”。`package.json` 的 `verify:release` 直调入口默认也是 core 语义，容易被人或日志扫描器当成最终结果。

其他静态确认的缺口：

- shell 薄入口只要子进程返回 0 就补打印 `ALL_GREEN`，没有识别 `DEV_BUILD_COMPLETE`。这是条件性误标：下层若正常完成一个不可发布的开发构建，上层仍会给发布标记。本轮未执行该 shell 构建链。
- build 写回执后只检查文件存在及 record 资格，没有调用完整 receipt 绑定终检。这不意味着正常刚写出的回执必坏，但 build 与独立 verify 的最终验收标准仍不统一。

**执行方案：**

1. core 只输出 `CORE_VERIFY_GREEN` 或结构化 `{stage:'core', publishable:false}`；只有发布级资格与回执绑定全通过才输出最终发布标记。
2. 最终模式作为对外默认；内部 core 使用明确的 `--core-only` 或单独命令。若暂不改默认，至少同步命令名与输出，不能继续把 core 标为发布成功。
3. build 写完 receipt 后调用发布级只读终检，退出 0 后才输出唯一 `ALL_GREEN`；不要重新往 record 塞未来步骤，也不要回写已绑定的记录。
4. shell 仅透传下层结论和退出码，不自己将所有 0 都升级为 ALL_GREEN；需要严格发布时显式传 strict，并正确透传后续参数。
5. 更新错误的旧测试期望：core 不得出现 `RELEASE_GREEN`/`ALL_GREEN` 等最终标记。

**回归验收：** 缺 receipt、缺 GUI 步骤、注入步骤桩、DEV_BUILD_COMPLETE、损坏 receipt 的情形，无论从 node 还是 shell 入口调用都不得输出发布绿色标记。完整正例只在最后输出一次；基础核验和失败步骤保留准确退出码。

### S3 · P2：缺少测试断言数组也能通过“严格校验”

定位：`tools/r5-run-suite.cjs:272`、`:306`。

当前代码把 `assertionResults` 非数组统一转换成 `[]`。以下机器结果被 `checkStrictCompleteness` 接受：

```js
{
  success: true, numTotalTests: 0, numFailedTests: 0,
  testResults: [{ name: '预期测试文件的绝对路径', status: 'passed' }]
}
```

结果是 files=1/1、tests=0/0、ok=true。该样本是畸形机器报告，不是宣称实际 43 项测试没有运行；真实报告确实完成了 43 项。本问题涉及“解析失败应失败关闭”的防线。当前还未校验 suite 级 pending 计数；本地 Vitest JSON reporter 的 success 仅基于存在文件以及失败数计算，不能单靠 success 推断所有 suite 完成。

**执行方案：**

1. 按当前锁定 Vitest 的 JSON 契约校验必需字段，assertionResults 缺失、null、非数组都失败，不做空数组兜底。
2. 发布套件总测试数为 0 时拒绝。若个别文件确有合法空套件，应明确理由和细粒度策略，不让全零报告自动通过。
3. 校验数值类型/非负整数、通过/失败/pending/todo 的逐条聚合一致性；suite pending/failed 必须为 0。注意 Vitest 的 suite 数包含嵌套 describe，不能机械等同于测试文件数。
4. 继续保留完成文件集合相等、无未批准 skip、子进程非零/信号/超时必失败等现有检查。
5. Unhandled Error 仍不能只依赖 JSON success；当前 reporter 的 onFinished 忽略 errors 参数，需可靠保留进程退出码与完整错误证据，必要时加项目自己的 reporter 显式记录错误数。

**回归验收：** 缺数组、错误类型、全零、suite pending、计数不一致均失败；真实小套件和完整套件正例通过。新负例放入可被常规 unit/门禁运行的测试，而非只留文档。

### S4 · P2：参数解析未保持“相同过滤条件”和严格默认值

定位：`tools/r5-run-suite.cjs:156`、`:157`、`:526`、`:552`。

输入两段式 `--reporter dot --outputFile.json my-report.json`，预期文件收集器只剔除键，留下 `dot` 与 `my-report.json`，把它们作为额外测试过滤器。等号形式不会出现这个问题。过滤值碰巧匹配其他测试文件时，预期集合会多文件，造成严格校验误报或范围偏离。

另一个默认值不一致：纯函数默认 expectNoSkip=true，但 CLI 初始化为 false，因此只加 `--strict-completeness` 不会禁止 skip。**当前发布编排器同时传了两个旗标，所以不能说发布入口已经因此漏检 skip**；漏洞在独立 CLI 语义与默认承诺。

**执行方案：**

1. 使用统一解析器或维护明确的带值参数表；两段式剔除键时必须同时消费其值，等号形式消费整项；缺值或未知参数要有明确错误。
2. strict 默认禁止未经批准的 skip/todo；例外只能通过具体身份 allowlist，不增加全局宽松开关作为发布默认。
3. 同一解析结果派生 list 与 run 参数，保持配置、测试过滤和项目选择完全一致；报告参数只影响 run。

**回归验收：** 两种参数形式产生相同的预期集合；日志路径含空格仍作为单参数；缺值报错；仅 strict 时 skip 被拒；允许清单只放过指定项。保留当前两个旗标的兼容调用。

### S5 · P2：正常打包被登记成“手工重封”

定位：`tools/release-build.cjs:541` 附近的 register 参数；`tools/candidate-manifest.cjs:195`、`:308`。

编排器真实分支使用 electron-builder，但登记时没有传 `--pack-method electron-builder`；登记器默认 manual-repack，继而写 `reproducibleBuild:false` 和手工重封说明。

本轮复现了登记器的默认字段，未运行真实 builder。根据调用链可确定正常 builder 分支也未传该参数。该问题不直接破坏背景图片，但会使发布材料中的来源方式不真实。

**执行方案：**

1. 正常 builder 分支显式传入 electron-builder；手工重封仍显式标为 manual-repack。
2. 测试注入或模拟归档不能通过修改 packMethod 获得真实构建资格，注入标志与资格拒绝机制必须保留。
3. 增加编排派生参数契约测试，确认真实分支和登记字段一致。
4. `reproducibleBuild` 目前只是由工具选择推导，并未证明两次构建字节级一致。建议改为准确的字段名/含义，例如有自动化构建流程；若保留原名，文档明确它不是位级可复现保证。

**验收：** 正常 builder 链不再出现手工重封备注；人工路径与测试夹具仍有正确标识；版本/源码/lock/out 身份核验不放宽。

### S6 · P2：交接状态不再反映当前实现，安全建议未纠正

定位：`handoff/alpha-finalization-plan-2026-09-13/EXECUTION_STATUS.md:90`、`:104`、`:362`；同目录 `RUNBOOK.md:10`、`:74` 附近。

- RUNBOOK 仍称整链“尚未重跑”，状态表又留有已跑到 E2E 的记录；应区分旧提交执行记录与新版本尚未全链验证。
- 完整性说明仍以旧文本汇总/expectedFiles 条件为主，未清楚说明严格模式的机器结果与文件集合；任务 C 的旧版本标记也容易误导实施者。
- 状态表仍建议换新会话让安全删除计数归零、把全仓库和整个临时目录加入信任区。不能以重置/绕过护栏或扩大防护豁免作为让测试变绿的默认方法。
- 服务 Running 仍不能证明其持有目标文件锁；rename EPERM 与 SAFE_DELETE_BULK_CONFIRM_REQUIRED 不是同一机制。

**执行方案：**

1. 新增按提交/工作树标识划分的修复矩阵，准确登记 R1/R2、R3、未提交 R4 与本轮 S1–S5，不覆写旧测试事实。
2. 更新 RUNBOOK 中新 schema、core/最终验收区别、严格入口、产物绑定与当前停止点；每条“已通过”链接具体日志及来源。
3. 删除以换会话清计数、关闭/暂停防护、全目录信任为默认步骤的建议；遇到删除审批则核对精确生成目标后走平台正规授权，未获授权即保留阻塞。
4. 文件访问失败保留 code/errno/syscall/时间/目标路径；有目标句柄或事件对应证据再归因到具体进程。保持防护，不强杀、不自动修改系统设置。

**验收：** 文档命令与当前参数一致；不把静态实现、定向测试、真实整链、真实安装闭环混写；审批阻塞与产品错误独立登记。

## 4. 给实施 agent 的工作顺序

1. **先核对漂移**：读取 evidence/results.json 的源文件 SHA，与当前工作树比较。尤其不要覆盖本轮看到的两个未提交文件，也不要擅自提交别人的改动。
2. **优先 S1 + S2**：修复跨文件身份校验与阶段结论；它们影响发布结果可信度。保留上轮非自引用设计，不重新大改整个发布框架。
3. **然后 S3 + S4**：补机器报告 schema 和参数边界；增加可自动运行的负例。
4. **处理 S5 + S6**：登记方式与手册同步，分别记录代码修复和文档修复。
5. **检查 R4 落地**：协调原实施者完成现有工作树变更，核验“先 build，再集成/E2E，再 out 复核，再打包”。提交前先跑相关回归，不凭未提交 diff 宣布完整修复。
6. **由低风险到高成本验证**：typecheck/lint → 定向单测 → 新的微型生命周期测试 → 全量测试 → 同一 buildId 完整发布链。当前审查未执行最后两项。
7. **真实安装关口**：仍需用户当次授权才能应用/重启/恢复真实安装；不得从本审查请求推导出该权限。既往用户明确跳过的新机器验证不擅自重新列为强制任务。

### 本轮实际使用的定向命令（PowerShell）

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm.cmd run lint
if ($LASTEXITCODE -ne 0) { throw 'lint failed' }
node tools/r5-run-suite.cjs run tests/unit/release-eligibility.test.ts tests/unit/run-suite-wrapper.test.ts tests/unit/smoke-packaged.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism --strict-completeness --expect-no-skip
if ($LASTEXITCODE -ne 0) { throw 'strict unit check failed' }
node tools/audit.cjs
if ($LASTEXITCODE -ne 0) { throw 'audit failed' }
```

这些旧用例通过不代表 S1–S6 已修。先添加本报告指出的负例，再跑同一入口；新增文件需纳入调用范围。

### 重跑本轮缺陷复现

```powershell
node handoff/review-2026-09-14-r3/reproduce-review.cjs 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
```

脚本每次新建 evidence-run-* 微型夹具，不删除旧内容，假 exe 绝不执行。它断言“当前缺陷确实存在”，退出 0 是成功复现，不是发布通过。修复后应将相同输入改为正式回归中的正确预期，不能以修改报告样本来掩盖缺陷。它要求本地 Node/Git 和已有项目依赖，不联网安装。

## 5. 交付文件

- `REVIEW_AND_FIX_PLAN.md`：本报告。
- `reproduce-review.cjs`：微型隔离复现脚本。
- `evidence/results.json`：缺陷复现结果、源文件 SHA。
- `evidence/register.log`、`core-without-receipt.log`、`full-without-receipt.log`、`full-mismatched-record-build-id.log`：真实 CLI 原始日志。
- `evidence/strict-unit.log`、`strict-unit-result.json`：43 项严格入口实测日志与原始 JSON。
- `evidence/reviewed-working-tree.patch`：本轮基线未提交修改的快照。
- `task_plan.md`、`findings.md`、`progress.md`：审查过程记录，不属于产品发布资格证据。

不要把审查夹具、个人路径日志或本地记录打进面向用户的发布包。本报告只放在内部 handoff 中。
