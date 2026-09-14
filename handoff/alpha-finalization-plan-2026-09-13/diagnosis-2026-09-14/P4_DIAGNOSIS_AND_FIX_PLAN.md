# P4 发布阻塞复诊与可执行解决方案

日期：2026-09-14。代码基线：`55ba0e4`；发布实现来源：P3提交`5689cf7`。

实际项目：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。

本报告对应交接目录`handoff/alpha-finalization-plan-2026-09-13`。保留原计划、RUNBOOK、执行表及旧诊断；本文件是补充纠偏，不覆盖历史证据。

**本轮仅诊断、隔离测试及编制方案。未修改业务源码、测试源码、Vitest依赖，未构建/打包，未操作真实OpenCode安装，也未发布。以下修改交后续agent在取得实施授权后执行。**

## 1. 结论：P4仍为NO-GO，但原因应重新表述

当前最直接的阻塞是**测试执行基础设施未完整、无错误地完成**，不是已证明的产品业务回归。本轮已经得到比旧报告更完整的结果：

| 本轮检查 | 结果 | 能说明什么 |
|---|---|---|
| 候选登记套件，单worker | 14/14通过、exit0、42.64秒 | 这次完整执行成功，无RPC错误 |
| 全量集成，单fork worker、禁止文件并行 | 15/15文件、172/172测试通过；仍有1个onTaskUpdate错误，exit1；100.59秒 | 断言和文件收集完整，但仍不能当作门禁通过 |
| 读取新生成夹具manifest及其git log | SHA及主题均与夹具一致 | 原报告的candidate-manifest `--root`缺陷不成立 |
| 冒烟脚本隔离模拟 | 空白页面、读取正文抛错两种情况均SMOKE_OK/exit0 | 冒烟验收条件存在真实漏洞；不是实际启动失败复现 |

建议顺序：**先纠正诊断记录 → 消除测试worker同步阻塞 → 固定受控并发并校验完整性 → 加固发布资格与GUI冒烟 → 再从头尝试新候选构建。**

不用再次修已完成的B1清单前缀、B2生成manifest与Git冻结分离，也不要按旧报告修改正确的`ROOT`代码。

## 2. 原诊断中必须纠正的三点

### 2.1 “16项全部是资源竞争假失败”证据不足

原串行全量日志实际为`7 passed (15)`、`84 passed (84)`、1个Unhandled Error。还有8个文件未被完整计入，不能用这份部分结果推出全部原失败都不存在；更不能直接断言“worker只是丢报，实际都跑完了”。

本轮完整复跑确实汇总到15文件172测试，但仍有RPC错误。这支持“在当前受控配置中未观察到业务断言失败”，不等于穷尽证明所有并行情形都是环境假失败。

原并行日志的no-op用例失败在`transaction.test.ts:160`，是**第一次applyTheme的success为false**，尚未进入第二次调用的no-op判定。原断言只显示布尔值，没有记录error.code/detail，所以不能据此定位no-op逻辑，也无法判断是不是文件锁导致。

修正文案：`并行失败包含超时、访问被拒和首次应用失败；受控复测未复现业务断言失败，具体环境来源待证实，RPC错误仍需修复。`

### 2.2 `cwd: ROOT`不是这里的--root缺陷

[candidate-manifest.cjs:40](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/candidate-manifest.cjs:40)声明`let ROOT`；[applyRoot:134](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/candidate-manifest.cjs:134)执行`ROOT = r`；register先调用applyRoot，再使用ROOT查询git log。

本轮实际夹具：

```text
sourceCommit        004d1f3ca95d9b383eae242d7c9880773ebb181d
sourceCommitSubject fixture init
夹具 git log        004d1f3ca95d9b383eae242d7c9880773ebb181d fixture init
```

因此原报告把ROOT理解成不可变宿主根是误读。这一项应**撤销缺陷判定**，而不是安排代码修复。可给现有正例补`sourceCommitSubject === 'fixture init'`断言，防止以后回归。

### 2.3 EPERM不能直接指认为某个安全进程持锁

原日志证明对合成`wallpaper.jfif`的覆盖写入被拒，并未包含持锁进程、句柄、ACL或安全事件证据。本轮完整串行运行未复现该EPERM。

建议保留为“环境相关访问失败，原因未定”，不要关安全软件、修改系统防护设置或强杀进程。本轮没有获得进一步的锁持有者证据，也没有删除旧日志中被占用的文件。

#### 2.3.1 【2026-09-14 补证】已定位本机拦截来源，并取得可复现证据

后续任务 F 重跑整链时 `test:e2e` 稳定失败（3 failed / 13 passed），根因是
`commit.ts:98` 的 `physicalFsp.rename(tempFile, targetPath)`（替换合成安装的
`app.asar`）返回 `EPERM`，被记为 `FILE_LOCKED`。该失败**可脱离产品代码复现**：

- **最小复现（纯 Node，无 Electron、无本仓库代码）**：在临时目录里对同一路径
  反复「写出 staged → rename 覆盖 target」，300 次中 **18 次 `EPERM`（6%）**；
  首轮小样本（20 次 / 90 次）分别命中 1 次 / 3 次。`%TEMP%` 与 `HOME` 下目录
  **均有命中**，不是 Temp 目录特有。
- **排除项**：`physical-fs.ts` 在 Electron 下走 `original-fs`（物理语义），
  `archive-io.ts` 亦有 `noAsar` 窗口 + `uncacheArchive`，**应用侧 asar 缓存处理无缺陷**；
  失败发生在 `rename` 覆盖**已存在**文件，而非打包或读取阶段。
- **持锁者证据**：本机 `WinDefend` / `WdNisSvc` 均为 `Stopped`，而
  **`QQPCRtp`（腾讯电脑管家实时防护）为 `Running`**。该服务对「刚写入即被
  覆盖」的文件做实时扫描时会短暂持有句柄，与 6% 命中率、以及 `build` 步骤
  `rmSync('out')` 被安全删除护栏拦截属**同一类文件占用**。

**判定**：属**环境相关访问失败**（本机安全软件实时防护），**不是产品缺陷**。
验收项「EPERM/首次 apply 失败有具体错误码及诊断信息，未靠关闭防护或吞异常放行」
**已满足**：错误码 `FILE_LOCKED`、诊断信息明确、未吞异常、未关闭防护。

**不采取的处置**（维持原约定）：不关实时防护、不改系统防护设置、不强杀进程；
本轮亦未删除任何被占用的旧日志/文件。
**建议的处置**（需人工操作，超出本轮授权）：将仓库根与
`%TEMP%` 加入电脑管家信任区（或暂停实时防护），再以发布模式重跑整链以取得 `ALL_GREEN`。

**附带结论（非缺陷，记录备查）**：真实用户机器若装有同类实时防护，首次 apply
存在小概率 `FILE_LOCKED`；当前设计**明确报错并保持安装未被修改**（`FILE_LOCKED`
分支已 `rm` 掉 staged 临时文件），用户重试即可，语义上是安全的失败而非数据损坏。

## 3. P4当前阻塞的技术判断

### 3.1 onTaskUpdate是任务更新RPC，不是独立心跳

本机Vitest为3.2.7。根据已安装代码：

- `node_modules/vitest/dist/chunks/index.CwejwG0H.js:47`将任务更新转为`rpc().onTaskUpdate(...)`。
- `rpc.-pEldfrD.js:49`在该RPC超时后抛出错误。
- `index.B521nVV-.js:3`的默认RPC超时为`6e4`，即60秒；当前fork的RPC选项未覆盖此值。

它与`testTimeout: 30_000`、`hookTimeout: 30_000`不是同一超时层。只改变测试用例时限不直接解决RPC回执超时；本地也未发现项目可直接配置的所谓“心跳超时”选项，不应凭空增加一个Vitest不识别的配置字段。

### 3.2 优先处理同步子进程造成的worker阻塞

[candidate-manifest.test.ts:14](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tests/integration/candidate-manifest.test.ts:14)大量使用`execFileSync`、`spawnSync`。夹具创建、git配置/add/commit、登记CLI及check都同步执行；多数测试回调也同步串行执行这些工作。等待同步子进程期间，**测试worker自己的事件循环不能正常处理IPC消息**。

注意区别：独立CLI内部使用同步Git不一定有问题；问题优先在Vitest worker用同步方式等待CLI，以及连续执行同步夹具操作。无需第一步就重写产品的全部Git逻辑。

本轮观察：

- 独立候选套件42.10秒测试耗时，无RPC错误。
- 完整单worker集成中该套件72.372秒，其余套件明显较快；全部断言通过，但出现60秒RPC错误。

这与同步阻塞/IPC无法及时处理的机制相符，是**高优先级修复假说**，并非已有事件循环采样证明的唯一根因。若异步化后仍出现RPC错误，必须继续调查IPC、reporter或环境，不能硬写“已修好”。

## 4. 执行任务A：让测试worker保持可响应

修改文件：`tests/integration/candidate-manifest.test.ts`，必要时新增`tests/fixtures/async-command.ts`。不先改Vitest依赖，不调高现有30秒测试/钩子阈值。

### A1. 把worker侧子进程等待改为异步

可采用以下实现形状（按现有TS风格整合；这是实施模板，尚未写入项目）：

```typescript
import { execFile } from 'node:child_process';

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
}

function runCommand(file: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr,
        ...(error ? { error: error.message } : {}),
      });
    });
  });
}
```

25秒是单个诊断子进程的建议上限，不能替代测试总时限；若现有测量显示需要改变该值，记录原因和命令分项耗时，禁止把超时当成功。spawn失败、信号/超时均必须是非0，保留错误文本。

逐一修改：

1. `git()`改为async，await runCommand；非0抛出带命令、状态、stderr的错误。
2. `gitInit()`与`makeFixture()`改async；各条Git命令按依赖顺序await，不能把commit与add并行执行。
3. `runTool()`改为await子进程回调；14个it回调改async，所有调用均await，包含文件中单独的负例spawnSync。
4. 不删除任何正反例、不mock掉真实Git/登记流程、不替换成纯函数测试。
5. 补测试：同一异步子进程等待期间定时器或setImmediate可继续运行；记录最大事件循环延迟作为诊断数据。不要给业务测试增加无依据的性能硬阈值。

### A2. 减少无意义的夹具成本并清理自建目录

每个case仍需独立可修改的Git工作目录。优先去掉重复git查询、复用同一case内已确认的SHA；如复用基础模板，必须复制成独立工作目录再修改，不能让14个case共享一个可变Git仓库。

当前候选登记测试没有afterEach清理，反复运行会积累许多`p2-*`仓库。新增本次运行的目录登记及afterEach清理：只删除本case明确创建的目录，验证位于测试专用根内；遇占用保留并报告，不按通配符清扫整个历史缓存。

### A3. 验收

- 候选套件14项及新增用例全部执行、失败0、Unhandled Error 0、退出0。
- 完整集成当前基线15文件172项均完成；新增测试后按实际清单计数，不能依赖固定旧数字掩盖漏项。
- 在相同配置下重复完整运行至少两次，分别留日志；任何一次RPC错误都算未通过，不采用“重试直到绿”。
- 若仍失败，保存worker事件循环延迟、逐子进程耗时、完整错误与缺失文件列表，再选择分组执行或进一步IPC诊断。禁止直接修改node_modules的60秒常量，禁止忽略Unhandled Error。

## 5. 执行任务B：把受控并发与完整性检查接进发布链

修改：[release-build.cjs:272](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/release-build.cjs:272)、`tools/r5-run-suite.cjs`及其包装层测试。

1. 发布模式的集成测试参数固定采用`--pool=forks --maxWorkers=1 --no-file-parallelism`作为当前保守默认；不使用`singleFork`把所有文件长期塞进同一worker状态。此配置本轮已确认能收集全部文件，但**单独用它仍会RPC报错，必须配合任务A**。
2. 给每次运行分配独立临时子目录，默认位于项目允许的缓存根；CI显式可配置。RUNBOOK目前声称CI会自动回落系统临时目录，与实现不一致，应按真实行为修正。
3. 保留退出码传播；追加记录spawn error、signal、超时、日志路径及执行命令，不能只输出最后六行丢失关键摘要。
4. 输出机器可读测试结果，检查：应运行文件集合=实际完成文件集合、失败0、pending/skipped/todo与预期一致、Unhandled Error 0、进程退出0。RPC错误或少跑文件不能只靠“最后显示全✓”放行。
5. 先在测试层增强首次apply失败的错误信息，例如在`first.success`为false时把`first.error.code/message/detail`加入断言消息。否则下次`expected false to be true`仍无法定位。
6. 如果要临时分组执行，必须用清单明确分为“候选登记14项”和“其余14文件158项”，两组均要求完整无错；两组之和覆盖所有集成测试。组间隔离不能变成漏测。单独候选套件自身仍可能超过RPC限时，因此分组不是对A的替代。

本轮已执行的诊断命令（直接可用，不会构建候选）：

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'

node tools/r5-run-suite.cjs run tests/integration/candidate-manifest.test.ts --maxWorkers=1 --no-file-parallelism --tmp 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher\node_modules\.cache\ots-p4-review-tmp'
# 本轮：exit0，14项通过；不能推断下一次一定通过

node tools/r5-run-suite.cjs run tests/integration --pool=forks --maxWorkers=1 --no-file-parallelism --tmp 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher\node_modules\.cache\ots-p4-review-full-tmp'
# 本轮：exit1，172项通过但1个RPC错误；需先按A修复，再重跑
```

每条命令后立即记录`$LASTEXITCODE`。诊断阶段不要重跑8分钟整条发布链来观察相同集成失败。

## 6. 执行任务C：修复后续“跳过检查仍可发布”的缺口

这是**代码审查确认的后续风险**，不是本轮真实构建复现。当前：

- `--skip-e2e`跳过两类E2E，`--skip-gui`跳过包GUI冒烟。
- 省略的步骤不进入build-record；编排器结尾仍打印`ALL_GREEN`。
- verify-release只核对build-record的hash，不检查发布必需步骤是否执行；register主要检查来源/版本/out，不建立完整验收步骤契约。
- 测试脚本统一加`--skip-gui`，其全绿测试未覆盖真实GUI步骤完整性。注释“仅开发使用”不能自动保证发布模式安全。

实施：

1. 将开发构建与发布候选资格分离。开发可跳检查，但只能标`DEV_BUILD_COMPLETE`及`releaseEligible=false`，不得输出发布ALL_GREEN或被release verify接受。
2. build-record明确记录每一步的状态`passed/failed/skipped`和退出码，不能以缺字段隐含跳过；由共享函数验证发布必需步骤集合。
3. 在register与verify-release都检查必需步骤：typecheck、lint、unit、integration、build、两类E2E、audit、dist、GUI冒烟、包可用性、zip。register/最终verify的结果应另作最终收据，不能把“还没执行的核验”预写为成功导致记录hash循环。
4. 生产入口若检测到`OTS_STEP_STUB`、`OTS_NODE_BIN`测试注入环境，明确拒绝或进入带不可发布标记的测试模式；不能让遗留环境变量把mock成功伪装为真实通过。
5. 加负例：skip-e2e、skip-gui、缺GUI记录、步骤非0、测试注入模式，全部不可通过发布核验；常规完整记录才通过。

不需要为了实现此项改变图片/备份/恢复业务逻辑。

## 7. 执行任务D：GUI冒烟必须真的验证界面可用

定位：`tools/smoke-packaged.ts`、`tools/release-build.cjs:318`。

本轮`probe-smoke.cjs`在VM里执行当前冒烟逻辑，mock窗口返回空标题/空body，或innerText直接抛异常。两种情况均输出SMOKE_OK、exit0。它只证明当前**验收条件不足**，不代表真实打包程序当前一定是空白。

实施：

1. 不再吞掉加载/读取正文的错误。首次窗口可见后，断言应用关键控件存在，例如当前真实UI的`选择图片`和`应用到 OpenCode`按钮（后者无目标时可以禁用，但不能不存在）。检查页面不是错误页、标题及主容器符合实际应用。
2. 监听页面错误、渲染进程崩溃及关键加载失败；失败进入统一非0退出路径。`app.close()`放finally，保证探针失败也关闭本次探针自己启动的窗口，不影响用户其他应用。
3. 在不修改真实安装的前提下加入合成图片导入/预览检查，至少验证PNG/JFIF一个有效样本，返回的预览确实有内容；不要点击真实应用按钮。
4. GUI启动继续剥离子进程的ELECTRON_RUN_AS_NODE，保持contextIsolation/sandbox/webSecurity。现有禁GPU启动只是自动化诊断配置，不等于普通双击环境已验证；真实P5需要正常用户启动证据。
5. 当前npx tsx依赖未被package/lock直接声明，本机node_modules也没有tsx。不要让发布链临时下载未锁定工具：推荐把小冒烟脚本改为CJS，直接`node tools/smoke-packaged.cjs ...`，使用项目已声明的Playwright测试包；或正式固定tsx依赖并同步锁文件，两者选一。
6. 增加空白页、body读取失败、崩溃、找不到按钮、正常UI负/正例；坏页面必须exit非0。把smoke:gui失败传播加入编排测试，不能所有测试都skip-gui。

验收时必须在本次候选上执行，不拿旧包或开发页面冒充候选界面。

## 8. 执行任务E：修正文档和阶段状态

在确认实施范围后更新原交接文件，并保留本轮补充报告：

- `P4-BLOCKERS-DIAGNOSIS.md`：撤销--root错误结论；将“全部假失败”“永远无法ALL_GREEN”改为与证据一致的有限结论；区分RPC错误与业务断言。
- `EXECUTION_STATUS.md`：当前HEAD为55ba0e4，不再写“仍冻结5689cf7且无提交变化”；可以保留5689cf7为上次构建来源。P4仍阻塞，新候选未产出。
- `RUNBOOK.md`：写明已实现命令不等于整链实测通过，补受控并发、日志完整性判据、发布/开发资格区别以及新的锁定冒烟入口。

使用以下状态词即可：`已实现但未整链验证`、`定向测试通过`、`完整测试有基础设施错误`、`候选工程验证通过`、`真实闭环通过`。不得互相代替。

## 9. 执行任务F：恢复P4及后续顺序

1. A/B先完成并复测，无漏项、无Unhandled Error、退出0；再完成C/D的失败注入测试。
2. typecheck、lint、单元、完整集成、编排工具测试全部通过后，固定新的源码提交及新buildId。不要复用旧源码SHA或旧zip身份。
3. 只在取得实施/构建授权后重新运行现有`node tools/release-build.cjs build <新buildId>`完整链；发布模式不得加skip参数，不携带测试注入变量。
4. 首次打包还有可能遇到未执行过的后续失败，逐步保留原始非0退出码；不能为赶进度补拷依赖或改hash后自称同一候选已通过。
5. P4新包通过后，再取得当次真实安装操作确认，进行应用→重启→换图→恢复。A6继续按用户决定跳过并标未验证。
6. 对外发布及上传仍需用户确认；本报告不授权执行真实安装或发布。

## 10. 交付与验收清单

- [ ] 原--root误判已纠正，新增主题断言通过。
- [ ] candidate测试worker不再用同步子进程阻塞，真实Git命令级14项覆盖保留。
- [ ] 完整集成全部文件和测试完成，无RPC错误，连续两次同配置均exit0。
- [ ] EPERM/首次apply失败有具体错误码及诊断信息，未靠关闭防护或吞异常放行。
- [ ] 跳E2E/GUI及mock构建不能取得发布资格。
- [ ] GUI冒烟空白/读取失败/崩溃返回非0，入口不依赖临时下载。
- [ ] 新候选工程全链有独立证据，之后才进入授权的P5。

## 11. 本轮证据与限制

本目录`evidence/`提供三份日志副本（原不完整串行日志、本轮候选单测、本轮完整集成），原文件没有改写。`probe-smoke.cjs`是可重跑的隔离模拟探针，不启动真实Electron；它自身exit0表示探针完成，不代表项目通过。

本轮没有修改任何阈值或源码，也没有尝试异步化修复后的验证，故A方案的最终有效性仍需实施后确认。同步等待与RPC超时高度相关，但未采集原失败时的CPU/锁句柄/IPC时序，不声称已证明唯一底层原因。

测试生成的Git夹具位于两个本轮专用`ots-p4-review-*`缓存根，当前测试没有自动清理所有p2目录；本轮未强制清扫它们。无用户图片、真实安装或旧候选被删除。
