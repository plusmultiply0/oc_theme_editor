# 2026-09-16 复审：当前问题与执行方案

实际项目：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。
基线：`900f7f3c20c52d5ef9064d946083eaa2516c6f14`，开始和收尾检查时已跟踪工作树均干净。
消息中的嵌套路径 `OpenCode\_Theme\_Switcher` 仍不存在；本报告保存实际项目的 `handoff/review-2026-09-16/`。

## 1. 结论：上轮修复已有进展，发布验收仍未完成

**目前仍不宜宣称 Alpha 已完成发布验证。主要阻断是集成/应用/恢复闭环没有稳定通过，而非上轮六项修复没有落实。**

不建议继续大幅重写发布流程。本轮建议修复下面四处具体代码/入口问题，然后集中处理测试失败与真实候选验证。

本轮没有修改业务代码，没有构建或打包项目，没有应用背景到真实安装，没有启动或关闭 OpenCode，没有清理旧缓存/候选、修改防护或绕过审批。隔离复现仅在内存里执行当前 TypeScript 的状态机，使用假的 process、归档库和子进程。

### 上轮六项核对

| 上轮项 | 当前状态 |
|---|---|
| S1 构建身份交叉校验 | 已提交 `6947483`：登记和核验共用 checkRecordBinding，拒绝 buildId 静默改名、强制锁文件 hash |
| S2 阶段/发布成功标记 | 已提交 `f848d0f`：CORE_VERIFY_GREEN 与 RELEASE_GREEN 分开，build 增加发布级终检，shell 不再补 ALL_GREEN |
| S3 机器报告缺少断言数组 | 已提交 `2cc2e31`：缺数组、零项、suite pending/failed 等失败关闭 |
| S4 CLI 报告参数/strict 默认 | 已提交 `b146d87`：两段式参数连值剔除，strict 默认禁 skip；发布入口未使用宽松开关 |
| S5 打包方式登记 | 已提交 `f5710b4`，并由 `8cba0db` 修复集成用例缺参数回归 |
| S6 文档纠偏 | 已提交 `430a4c0`，增加修复矩阵与限制说明；历史表与部分旧段落仍需清晰标为历史，不与最新结论并列 |

上述是代码/记录复核，不表示本轮跑完了全部发布门禁场景。不要重复执行上轮已经完成的重构，也不要将历史 stub 门禁通过视为真实候选发布通过。

### 本轮实测与历史证据分开列示

| 项目 | 结果 | 证据/限定 |
|---|---|---|
| typecheck | exit 0 | 本轮执行 |
| lint | exit 0 | 本轮执行 |
| 完整单元测试，严格模式 | **13 文件、212 项全过**，无 skipped/todo/pending/Unhandled Error，exit 0 | 本轮执行，含图片和归档窗口现有用例 |
| 仓库 audit | FAIL 0、WARN 0，exit 0 | 本轮执行；非依赖漏洞审计 |
| 两个运行时状态机负例 | 均复现 | 本轮内存夹具，不是真实 Electron 运行结果 |
| 集成测试 | 15 文件，51 failed / 128 passed / 179，exit 1 | **9/15 历史日志**，本轮读取核对，未重跑 |
| 单元+集成全套 | 28 文件，55 failed / 334 passed / 389，exit 1 | **9/15 另一轮历史日志**，不能与当前 212+179 简单拼成同一次测试 |
| 同一 buildId 完整发布/真实安装闭环 | 尚无本轮通过证据 | 没有因历史报错去重跑高成本/真实安装操作 |

## 2. 本轮问题概览

| 编号 | 优先级 | 类型 | 问题 |
|---|---|---|---|
| N1 | P2 | 归档 I/O 代码缺陷 | 错峰并发被误当嵌套，noAsar 开关可泄漏 |
| N2 | P2 | 工作进程错误处理 | Node child_process 的异步 error 无监听，错误可逃逸 |
| N3 | P2 | 开发验证入口 | npm run verify 仍先集成后构建，干净环境依赖不满足 |
| N4 | P2 | shell 验证入口 | 声明的 GATE_MANIFEST/GATE_CANDIDATE_DIR 绑定实际被忽略，尾部参数也未透传 |
| N5 | **发布阻断** | 验证/诊断未闭环 | 历史失败含真实 apply/restore 断言，不能仅归为清理错误或凭基线同样失败排除产品问题 |

P2 表示应修复的条件性缺陷，不等于已证实所有用户都会遇到。N5 是发布条件没有满足，不能把它当作已经确认某一产品代码根因。

## 3. 代码问题与可执行方案

### N1：归档窗口用全局 depth 判断嵌套，错峰并发会破坏状态

位置：`src/core/patch/archive-io.ts:107`，尤其 `if (depth > 0) return insideWindow(...)`；现有回归 `tests/unit/archive-io-window.test.ts`。

`depth > 0` 只能说明某个任务在归档窗口中，不能证明当前调用来自那个任务的嵌套调用。已有并发测试同一时间调用两项，两项都在首个队列回调开始前入队，未覆盖“第一项已经在 await 中、第二项才从外部进来”。

本轮以当前源码转译后执行，确定性复现：

```text
A 进入窗口并等待，depth=1，noAsar=true
B 从外部独立调用，被误当嵌套直接进入，depth=2
A 先结束，将 noAsar 恢复为 false；B 仍在窗口中
B 结束，将自己保存的 true 恢复回去
最终 depth=0，但 noAsar=true（状态泄漏）
```

影响边界：Electron 使用的是进程级开关，泄漏可能影响后续 ASAR 路径解析和模块加载。**目前生产读头/读取/解包包装主要调用同步归档方法，异步打包也已移入专用 worker，因此本轮没有证明普通 GUI 必然触发该序列，更没有认定它导致了历史启动事故或当前文件锁。**但公开异步窗口函数的串行化契约确实错误。

**修改步骤：**

1. 分离“公开排队入口”和“内部已持有窗口的操作”，不要用进程级 depth 自动授权任何新调用绕过队列。
2. 若必须支持异步嵌套，用异步调用上下文/明确的窗口所有权令牌识别真正嵌套；独立调用必须排队。所有权令牌还需有效期，已结束上下文的延迟任务不能复用旧窗口。
3. 最外层保存并恢复开关；内部嵌套不得按各自完成顺序覆盖全局原值。保留异常 finally 恢复路径。
4. 普通 Node `toggleNoAsar=false` 不得改变开关。可优先收窄未使用的异步写接口，降低主进程全局状态风险。

**验收用例：**

- A 已进入并等待后，外部 B 才调用：B 必须等 A 退出才能进入。
- A/B 的成功、抛错和不同耗时组合都不泄漏状态。
- 真正嵌套可完成，不死锁；初始 noAsar=false/true 均正确还原。
- 全部任务后 depth=0，noAsar 与进入前相同。
- 将本次错峰负例加入现有 unit，而不是只保留同一时刻 Promise.all 的用例。

### N2：打包工作进程未监听异步 error

位置：`src/core/patch/pack.ts:43` 的 WorkerHandle，`:98` 的 forkWithNode，`:132` 后主流程，`:182` 的 finish。

目前只监听 message 和 exit。fork/child.send 的错误并非都同步抛出，Node 子进程可在返回对象后发出 error。外围 try/catch 只能兜同步错误，不能兜后续事件；无 error listener 的 EventEmitter 会把该错误抛出，而非返回预期的 `Result`。

本轮假子进程使用真实 EventEmitter：监听数为 0；注入异步派生失败形态 EAGAIN，错误从 emit 逸出。没有制造真实系统资源耗尽，没有启动实际子进程。

范围限定：该复现验证 **Node child_process 路径**，不能据此宣称 Electron utilityProcess 使用相同 error 事件契约。两个适配器要分别按本地运行时 API 检查。

**修改步骤：**

1. WorkerHandle 增加明确的失败通知能力。Node 分支尽早监听 error，在发送任务前注册；同时处理 IPC 发送回调错误与通道提前关闭。
2. 异步错误转为一次性的 `STAGE_FAILED`，带 code/message/workerPath/阶段；停止计时并释放监听，不触发全局未捕获异常。
3. 测试 error→exit、exit→晚到 message、send callback error、超时等事件交错，Promise 只结算一次。
4. **附带生命周期改进**：当前成功消息立即进入 finish，调用 kill 后 resolve，不等 exit。本轮确认该顺序，但它是否造成历史文件锁尚未证实。建议成功时等待可验证的正常退出并设有界等待；kill 只用于超时/取消/故障回收，待退出或报告回收超时后再交付下游。
5. worker 发送成功消息时也应确认消息已发送，再正常退出；不要在 IPC 尚未发送完成时强制结束。Node/Electron 分别实现，不混用回调签名。

**验收用例：** 异步派生 error 不使测试进程崩溃；IPC 发送失败返回结构化结果；成功消息先到而 exit 后到时行为明确且有界；异常退出/超时不遗留计时器，不会先报成功再后台失败。

禁止把“延长 timeout”或“忽略 error”当成修复；也不要据此直接宣称已解决所有 EBUSY。

### N3：release:build 顺序修好了，npm run verify 仍保留旧顺序

位置：`package.json` 的 `scripts.verify`；`tests/integration/electron-runtime.test.ts:122`；`src/core/patch/pack.ts:63`。

现在的普通验证入口仍是：

```text
typecheck → lint → test:unit → test:integration → build → test:e2e
```

集成明确要求 `out/main/index.js` 存在，pack 也可能使用 `out/core/patch/pack-worker.js`。因此新克隆/无 out 时会先失败；有旧 out 时则可能先验证旧 worker 再构建新 worker。R4 只修了 release-build，未覆盖这个公开入口。

证据是当前脚本顺序与集成源码前置条件；本轮没有删除用户 out 去重现。

**修改步骤：**

1. 将普通 verify 调整为类型/lint/单元 → 一次构建 → 集成 → E2E，与已修复发布入口共享相同顺序定义或辅助编排，避免两份脚本持续漂移。
2. 常规验证也使用统一严格测试包装器；集成沿用受控并发，并记录临时目录策略。直接 npm test 可保留为开发入口，但说明其与发布验收不同。
3. 不在集成通过后再次重建同一份 worker。需要清理生成目录时遵循精确路径/审批，不在本审查中执行清理。

**验收用例：** 临时微型项目或可恢复的专用测试副本中无 out 也能按正确顺序启动；build 非零则集成不执行；完整验证只有一次构建；源码变更后测试用到新产物。不要在真实用户工作区删除 out 作为默认验收动作。

### N4：shell 入口承诺显式绑定，但只校验变量非空

位置：`tools/release-gate.sh:17`、`:31`、`:51`。

注释承诺 GATE_MANIFEST/GATE_CANDIDATE_DIR 与推导目标一致。实际只判断它们非空，然后调用 `node tools/release-build.cjs "$MODE" "$BUILD_ID"`；这两个路径既不比较也不传递。即便变量指向 A，buildId 指向 B，下层仍只验证 B 的默认路径。第三个及以后的参数（例如 strict）同样被丢弃。

这属于**调用者意图与实际验证目标不一致**，不是说底层发布核验被绕过或 B 的坏产物会通过。本轮是源码级确认，没有运行 shell 发布或读写任何实际候选。

**修改步骤（选择一个清楚的接口）：**

1. 保留兼容变量：将路径交给 Node 层，按仓库根解析、Windows 路径语义规范化后，严格比较它们与 buildId 推导的 manifest/候选路径；不一致在运行核验前非零退出。
2. 或废弃冗余路径变量：对设置了这些变量的调用明确报迁移错误，统一只使用 buildId；不能静默忽略。
3. 正确消费 mode/buildId 后透传合法剩余参数，未知/冲突参数报错；不重新增加 shell 自行打印 ALL_GREEN。

**验收用例：** 一致三元组通过；manifest=A/buildId=B、candidate=A/buildId=B、相对路径、空格路径、缺参数、额外 strict、未知参数都有明确结果。测试用假子命令记录实际 argv 即可，无须每次完整构建。

## 4. N5：当前发布阻断的诊断方案

### 4.1 原始日志说明的不只是清理失败

本轮读取两份本地日志，副本随报告交付：

- `node_modules/.cur-integration.txt`：51 个失败测试；详细错误块有 62 个，**错误块数不是失败用例数**。
- `node_modules/.full-test.txt`：55 个失败测试、总测试 389。它是另一轮执行，不能与当前单元总数及后来集成总数合并出一个“当前全量结果”。

具体业务失败包括：

- `tests/integration/electron-runtime.test.ts:143`：恢复上一主题、恢复首次接管都 FILE_LOCKED；恢复后指纹未达到预期。
- `tests/integration/image-format-cycle.test.ts`：`.jfif → .png → .webp` 闭环中应用返回失败，而非只在 afterEach 清理时出错。
- 日志另有大量 unlink EBUSY，可能在清理阶段出现，并可能掩盖同一测试的原始断言。

因此只把夹具清理改成忽略错误，不能证明应用/恢复已经正确。基线也失败、当前失败更少，最多说明存在共同问题，**不能单凭数量比较排除产品缺陷或确认某安全软件是持锁者**。

### 4.2 实施顺序

1. **先补记录，不先关防护。** 每次保存 commit、测试命令、Node/Electron/Vitest 实际版本、并发参数、临时根、是否复用 out、测试文件集合和机器结果。
2. **按用例身份分类错误。** 分别保存 setup、业务断言、cleanup 和 worker 错误；同一测试多条错误归在同一 ID 下。输出“仅清理失败”“业务失败且伴清理失败”“业务失败”“未完成”四类，而不是简单 grep EBUSY 的次数。
3. **对最小业务闭环定向复测。** 优先格式轮换、应用/恢复、Electron 物理归档用例；使用项目已声明的并发/临时目录设置，并记录该设置。更换测试目录可以做对照，不可把它本身当作产品修复或绕过安全护栏的办法。
4. **排查句柄生命周期。** 记录 worker PID、reply/exit/close 的时间、父进程还持有的流/句柄以及失败的 syscall/path。N2 中“成功消息早于退出”的改进需与这些证据对照；尚不能确证它导致当前锁。
5. **环境归因需证据。** 有权限时取得目标文件对应的句柄/文件系统事件，并按时间关联；拿不到就保持“访问失败原因待定”。EACCES/EPERM 并不只表示文件锁，当前 commit.ts 将它们归为 FILE_LOCKED，诊断应保留原始错误码。
6. **处理清理错误但不吞业务失败。** 自建夹具清理只能作用于登记的精确目录，有限重试或有界清理；失败保留路径和日志。不要扫描/清空整个 TEMP 或缓存，不要用无限重试/新会话清计数规避审批。
7. **重新跑当前版本的完整集成与发布链。** 先全量测试无失败/未完成，再生成唯一 buildId 的候选、做 GUI 冒烟和只读复核。历史不同提交/不同运行的日志不能拼成一次完整绿色验收。

真实 OpenCode 应用→重启→恢复依旧需要用户当次授权。此前明确跳过的新机器验证不自动恢复为强制任务；保留限制说明即可。

## 5. 给实施 agent 的最小任务拆分

| 顺序 | 工作 | 完成标准 |
|---|---|---|
| A | 修 N1，补错峰并发测试 | 独立任务串行，真嵌套不死锁，最终状态正确 |
| B | 修 N2，补事件交错测试 | 异步 error 返回 Result，退出/回收有界，无未捕获异常 |
| C | 修 N3/N4 两个公开入口 | 普通验证先构建；shell 不忽略目标和参数 |
| D | N5 分类取证与定向复测 | 业务错误与清理错误分开，锁归因有证据或保留未知 |
| E | 当前提交全量验证及新候选 | 同一 buildId 串联全部证据，不以单元通过代替 |

每项小步提交，保留原修复，不扩展换肤新功能。若实际执行时 HEAD 已变化，先对比本报告基线和源码 hash，再决定哪些问题仍成立。

### 本轮复测命令（PowerShell）

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm.cmd run lint
if ($LASTEXITCODE -ne 0) { throw 'lint failed' }
node tools/r5-run-suite.cjs run tests/unit --pool=forks --maxWorkers=1 --no-file-parallelism --strict-completeness
if ($LASTEXITCODE -ne 0) { throw 'strict unit check failed' }
node tools/audit.cjs
if ($LASTEXITCODE -ne 0) { throw 'audit failed' }
```

内存缺陷复现：

```powershell
node handoff/review-2026-09-16/reproduce-runtime.cjs 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
```

该脚本退出 0 表示“成功复现当前缺陷”，不是发布通过。修复后应将其场景转为正式测试的正确行为断言，不能为了保留复现脚本 exit 0 而保留错误。

集成与完整发布属于后续实施验证，本轮未执行；需先按上述方案确认构建产物和审批条件，不能直接在旧 out 上反复跑测试。

## 6. 交付与限制

- `evidence/runtime-probes.json`：内存状态机复现、源码 hash。
- `evidence/unit.log`、`unit-result.json`：本轮 212 项严格测试原始输出。
- `evidence/historical-integration.txt`、`historical-full-test.txt`：9/15 历史失败日志副本，勿标为本轮测试。
- `reproduce-runtime.cjs`：当前源码内存转译复现脚本，无真实 spawn 或 ASAR 写入。
- `task_plan.md`、`findings.md`、`progress.md`：按证据分级的审查记录。

这些含本机路径的材料仅供内部 handoff，不应加入面向用户的发布包。报告未证明所有代码无其他问题，也没有把模拟进程结果冒充真实 Electron 测试。
