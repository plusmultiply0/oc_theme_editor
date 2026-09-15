# OpenCode Theme Switcher 复审与可执行修复方案

日期：2026-09-14。基线：`41316f1029c50e245791920e2d33244211c5504a`。

实际仓库：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。
用户消息中的嵌套路径 `D:\zjcfile\weblearn\vibecoding\OpenCode\_Theme\_Switcher` 本机不存在；本报告交付实际仓库的 `handoff/review-2026-09-14-r2/`，不创建第二份项目。

## 1. 结论与范围

**仍不建议宣布 Alpha 发布验证完成。** 当前不是“只剩环境放行后重跑”：存在两个 P1 发布流程/规则问题、两个 P2 测试可信度问题，以及一个 P2 诊断文档问题。

本轮执行的是代码与交接材料复审、隔离回归复现和定向测试；没有修业务代码，没有构建/打包，没有改真实 OpenCode 安装，没有关闭防护、清空旧产物或绕过删除护栏。没有重做用户已明确跳过的新机器验证要求。

重点复查上轮 A–F 的实际实现、发布链及图片入口。不能把此次检查当作全部代码不存在其他缺陷的保证。

| 编号 | 等级 | 问题 | 证据强度 |
|---|---|---|---|
| R1 | P1 | 发布记录依赖尚未发生的登记/核验，正常链无法取得发布资格 | 当前函数的内存夹具复现 + 调用顺序 |
| R2 | P1 | 被审记录可以自行缩减必检步骤，跳过检查仍可能被判合格 | 当前共享校验函数直接复现；现有单测竟将此设为正例 |
| R3 | P2 | 测试完整性检查没有验证真正完成的文件集合 | 当前检查函数与包装层均复现误接收 |
| R4 | P2 | 集成测试前只检查入口文件存在，可能使用旧/残缺 worker | 当前前置函数在缺 worker 的内存夹具中跳过编译 |
| R5 | P2 | 文件锁归因证据不足，执行建议混淆环境错误与安全护栏 | 交接文档与源码核对；未独立重跑文件锁实验 |

## 2. 本轮验证结果

| 检查 | 结果 | 限定 |
|---|---|---|
| `npm.cmd run typecheck` | exit 0 | 类型检查 |
| `npm.cmd run lint` | exit 0 | 静态规范 |
| 发布资格/测试包装层/GUI 冒烟判定单测 | 3 文件、31 项通过，exit 0，Unhandled Error 0 | 不含真实 exe 启动；不能证明完整发布链 |
| 图片格式/真实解码/动图策略单测 | 3 文件、34 项通过，exit 0，Unhandled Error 0 | 使用内存图片与仓库夹具，不含真实安装应用 |
| `node tools/audit.cjs` | exit 0，FAIL 0、WARN 0 | 仓库自定义审计，不是 npm 漏洞扫描，也不是新候选认证 |
| `reproduce-review.cjs` | exit 0，确认 R1–R4 当前缺陷 | 退出 0 表示成功复现缺陷，不代表产品通过 |
| 完整集成/E2E/打包/真实安装闭环 | 本轮未执行 | 不把历史结果冒充本次结果 |

两次定向测试的原始日志随本报告放在 `evidence/`：

- `release-unit.log`：release-eligibility 12、run-suite-wrapper 10、smoke-packaged 9。
- `image-unit.log`：image-formats 14、image-probe 9、image-animated 11。
- `reproduction-results.json`：当前源码函数的隔离复现输出。里面打印的模拟日志路径只存在于内存，不是实际磁盘测试日志。

此前已有进展应保留：异步测试命令、集成受控并发、每次独立临时目录、GUI 冒烟标题/关键按钮/空白页/错误断言，以及去掉未声明的 tsx 调用。`.jfif/.jpe` 已进入统一 JPEG 别名定义，本轮相关测试通过；没有证据需要再次重做格式支持。动画 WebP/APNG 当前拒绝策略的单测也通过。

## 3. 逐项定位与修复要求

### R1 · P1：发布生命周期自引用，后置回写也救不了

定位：`tools/release-build.cjs:167`、`:178`、`:188`、`:447`、`:449`、`:459`、`:473`、`:501`；`tools/verify-release.cjs:468`；`tools/candidate-manifest.cjs:288`。

真实调用顺序是：

```text
测试/构建/打包/zip
  → writeBuildRecord（steps 此时不含 register、verify:release）
  → register（把该记录的 hash 写进 manifest）
  → verify:release（却要求记录中的全部必需步骤已经 passed）
  → finalizeStepStatuses（只有前一步成功才执行）
```

`missingRequiredSteps` 必然含最后两项，`releaseEligible=false`。校验器读取后明确拒绝。因此即使前置环境问题全解决，当前实现走到最终核验仍会失败。这里通过当前写记录函数与当前资格函数复现，不是运行真实打包得出的结果。

额外问题：写记录的 `map` 只能把“已有”的末两项标 pending，不能创建尚不存在的项。即使强制调用 finalize，也不补缺项、不更新 releaseEligible，复现仍为 false。假如只补 pending 项再后置改 passed，又会改变已被 manifest 绑定的记录 hash——此项在单独的假设修补夹具中验证，不是声称当前流程已经发生了该 hash 改写。

**修复方案：将构建事实与完成回执分离，移除自我依赖。**

1. 定义版本化的不可变 `build-record/2`：只记录登记前真实完成的构建/测试/打包事实、sourceCommit、锁文件/out hash、必检策略版本、显式失败/跳过状态和注入标志。
2. 登记 manifest 绑定该记录。登记后不再改该文件，不预填任何未来成功。
3. 拆出“核验产物、来源和前置证据”的 core 校验层：检查 manifest/record/zip/asar/依赖/测试事实，但不要求自己的完成回执已存在。此层成功不等于最终发布资格。
4. 仅当 register 与 core 校验真实退出 0，才写独立 `release-receipt/1`，记录它们的成功、buildId、sourceCommit、manifestHash、buildRecordHash；不把 receipt hash 反向塞入 manifest，避免再形成环。
5. 对外 `release:verify` 只读校验事实、产物和 receipt 的绑定，并重新执行必要的内容核验；缺 receipt、绑定错误、注入环境、跳过必检均不得给发布绿色结果。回执是本地流程证据，不宣称它等于外部数字签名。
6. 构建入口完成上述终检后才输出 ALL_GREEN。删除旧 finalize 回写路径；开发构建如保留 skip 开关，只能输出开发完成，不能取得发布资格。

**回归验收：**

- 使用极小合成候选，真实调用 record writer → register → core verify → receipt writer → 最终 verify；不允许把 register/verify 都 stub 为 0 来验证这条生命周期。
- 正例真实通过；任一前置步骤失败、跳过或注入必须拒绝。
- 登记和 core verify 的失败分别阻断 receipt 写入。
- 连续执行两次只读 verify 都通过，record/manifest/zip/asar hash 完全不变。
- 篡改 record、receipt 绑定、替换其他 buildId 的 manifest 均失败。

### R2 · P1：记录能自己定义更宽松的审查规则

定位：`tools/release-eligibility.cjs:47`；`tests/unit/release-eligibility.test.ts:121`。

当前 `releaseRequiredSteps` 非空时直接替代内置集合。因此下面这份没有 lint、任何测试、GUI 或包验证的记录会返回 `ok=true`：

```js
{
  releaseEligible: true,
  releaseRequiredSteps: ['build'],
  steps: [{ step: 'build', status: 'passed', exit: 0 }]
}
```

这不是声称正常编排器目前会自动生成此缩减记录，也不是外部攻击已发生；是资格校验信任边界错误，其他写记录入口或后续改动可以导致误放行。现有单测还明确要求该行为通过，所以只追求“旧单测全绿”不会修复它。

**修复方案：**

1. 与 R1 一起定义可信的版本化策略，由代码按已知 policyVersion 选择最低必检集合；未知版本拒绝。
2. 记录中的额外要求只能增加，不能删减最低要求；更简单的初版做法是要求声明集合与可信集合完全一致。
3. 不信任记录自报的 releaseEligible；从可信策略和实际证据重新计算。保留该字段时核对其与计算结果一致。
4. 校验记录 schema、步骤对象、唯一名称、合法状态、数字退出码；拒绝重复步骤，避免 Map 的后项覆盖前项。
5. 把“记录自带要求以其为准”的旧正例改成明确拒绝的负例，并覆盖空集合、少一步、未知版本、重复失败/成功项、畸形 steps。

**验收：** build-only、typecheck-only 记录都失败；每一项必须步骤单独删除均失败；真实齐全记录通过。schema 的变更必须同步编排器、登记、核验、测试、RUNBOOK，不能只修一个函数。

### R3 · P2：完整性检查比较分母，没有检查完成集合

定位：`tools/r5-run-suite.cjs:41`、`:104`、`:112`、`:183`、`:237`；`tools/release-build.cjs:367` 附近的套件调用。

已复现三个错误接收：

| 输入摘要 | 当前结果 | 应有结果 |
|---|---|---|
| `Test Files 7 passed (15)`，expectedFiles=15 | 接收 | 8 文件未完成，应拒绝 |
| `Tests 1 passed / 9 skipped (10)`，默认调用 | 接收 | 发布策略禁止未批准 skip 时拒绝 |
| `Test Files 1 failed (1)`、`Tests 0 passed (0)` | 接收 | 文件失败/收集失败应拒绝 |

第三例与前两例在包装层的退出 0 使用的是合成子进程返回值。真实 Vitest 通常会为文件失败返回非 0，现有包装层仍传播该非 0；本结论是补充完整性防线存在漏洞，不是说真实失败一定会被吞掉。

此外，CLI 没有给 `runSuite` 传 completeness 参数，发布入口因而没启用预期文件数/no-skip；只读末 40 行文本、把 stdout 与 stderr 拼接后找最后摘要，也不能证明身份一致的完整文件集合。

**修复方案：**

1. 在当前锁定 Vitest 版本下实现机器可读结果适配；先从本地安装的类型定义/实现确认 reporter 字段，不凭新版网上示例猜字段。
2. 运行前通过相同配置与过滤条件收集预期测试文件列表，规范路径并保存；运行后比较实际完成文件集合，不能只比较数量，更不能比较括号里的计划总数。
3. 检查文件与测试状态、收集失败、Unhandled Error、进程信号/超时/退出码；skip/todo 默认拒绝，确需豁免则按具体测试标识列出有理由的 allowlist。
4. 显式接入发布入口。机器结果缺失、解析失败、结果属于其他 runId，必须失败关闭。
5. 文本摘要只供人阅读；保存原始 stdout、stderr 和机器结果，校验报告绑定同一 runId。
6. 最小过渡修复可先补 filesFailed/filesPassed/总数一致性并接通参数，但不可据此宣称已实现“完成集合相等”。

**验收：** 本节三个负例全部拒绝；再补数量相同但文件名不同、worker 未完成、空结果、stderr 很长、嵌入伪摘要、非允许 skip、非零退出和 timeout；正例必须保持可通过。

### R4 · P2：prepare:out 对旧产物/残缺产物没有防护

定位：`tools/release-build.cjs:277`、`:285`、`:373`、`:384`；`src/core/patch/pack.ts:63`；`tests/integration/electron-runtime.test.ts:122`。

现有补建修好了“完全没有 out 时不能跑集成”，但 `out/main/index.js` 一旦存在就跳过。pack-worker 可以缺失，也可以是旧源码编译的版本。集成测试从源码调用 pack 时会落到 out 中的 worker；之后才执行干净 build，所以测试与最终打包可能不是同一份 worker。

内存夹具只放 main/index.js、不放 pack-worker.js，调用当前 ensureIntegrationPrereq 得到“已存在，跳过”，编译调用为 0。没有故意破坏磁盘 out，也没有断言用户当前 out 一定是旧的。

**推荐修复：调整顺序，让同一份新构建产物接受集成和运行期测试，再直接打包。**

1. 类型/lint/单元完成后，执行一次有保护的构建；构建成功后记录 out 完整清单及输入指纹。
2. 对这份 out 执行集成 → E2E → 打包，不在集成通过后再重建 worker。
3. 打包前对 out 清单复核，测试期间输出被更改则拒绝；不得仅凭 main/index.js 存在判断可用。
4. 如必须保留前置 node 编译，至少检查全部必需模块和源码/lock/tsconfig/编译器输入指纹；不匹配重新生成。优先避免这条更复杂的缓存协议。
5. 单次正常构建的清理遇到安全审批护栏时停下走平台审批，不手工清空大目录，也不靠换会话重置计数。

**验收：** 干净环境成功；入口存在但 worker 缺失时能补建或明确失败；修改 worker 源码后用到新 worker；构建失败不跑集成；集成与打包 out hash 一致。新增用例应覆盖缓存存在分支，而非只用步骤 stub 证明调用顺序。

### R5 · P2：环境诊断过度确定，处置建议应纠偏

定位：`handoff/alpha-finalization-plan-2026-09-13/EXECUTION_STATUS.md:87` 起；其 `diagnosis-2026-09-14/P4_DIAGNOSIS_AND_FIX_PLAN.md:58` 起；`src/core/patch/commit.ts:98`。

文档登记纯 Node rename 实验 300 次中 18 次 EPERM。这支持“脱离产品代码也能出现访问失败”，但本轮未重跑该实验。其所谓持锁者证据实际是某防护服务 Running、其他服务 Stopped；没有给出失败时目标文件的进程句柄/跟踪事件，所以不足以确认锁来自指定服务。

还把 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 与 rename EPERM 称作同类占用：前者是明确的删除策略审批拦截，后者是文件操作失败，不能混为同一根因。现有代码将 EPERM/EBUSY/EACCES 一律显示 FILE_LOCKED，EACCES 也可能是权限问题，因此界面错误标签本身不是持锁证据。

**修复方案：**

1. 将状态改成：“环境相关访问失败，具体持锁者/权限原因待证实；删除审批护栏是独立阻塞；同时存在本报告 R1–R4 的代码问题。”保留旧实验事实，不抹掉失败日志。
2. 保存具体目标路径、时间、原始 code/errno/syscall、stage、前后 hash；区分权限拒绝、共享冲突、策略审批三种诊断类别。不依据服务状态断言来源。
3. 如需确定持锁者，由有权限的操作者取得针对该文件的句柄或文件系统事件证据，并与失败时间对应；普通读取拿不到则保持未知，不强杀进程。
4. 删除“换新会话使删除计数归零继续跑”的执行建议；删除把整个仓库和整个临时目录加入信任区/暂停实时防护的默认建议。不能为让测试变绿规避安全控制。
5. 需要批量清理时，核对准确生成目录及可恢复性，走环境提供的明确审批；未获审批则停止该步骤。文件访问失败优先在保持防护的条件下收集证据、正常退出用户确认可关闭的应用、稍后重试有限次数；不自动强杀或修改全局设置。
6. 如后续选择在产品加入瞬时冲突重试，需单独实现有限次数/退避/总超时/取消，并复核 target hash。不得重试权限/策略错误，不得以先删 target 再 rename 的方式换取成功；失败仍保留明确恢复语义。

**验收：** 文档不再把“猜测安全软件”写成已证实持锁者，不把删除护栏写成文件锁；没有关闭防护或重置护栏的前提；失败与成功状态忠实记录，不把“环境待解决”推导为“其余代码已无缺陷”。

## 4. 交给其他 agent 的执行顺序

1. **基线保护**：核对本报告 SHA 与当前 HEAD 差异；保留所有用户改动与历史候选。新证据用新目录，不覆写旧验收。发现源码变化先重新定位，不盲按旧行号修改。
2. **先做 R1+R2**：一起设计非自引用契约；同步记录/登记/核验/编排/单测/文档。一个可独立验收的提交，不为保留错误旧测试而放宽规则。
3. **做 R3**：完成机器结果、集合比较与发布入口接线；一个独立提交，保留新负例原始结果。
4. **做 R4**：修正构建/测试顺序或证明缓存完整性；一个独立提交，验证测试与打包产物同源。
5. **做 R5**：改执行记录与运行手册中的过度结论/不安全处置；不执行系统级动作。与代码完成状态分别登记。
6. **先低成本验证再完整链**：typecheck/lint → 新增定向回归 → 全量单元/集成 → 无跳步完整发布。若环境审批/锁仍阻塞就记录停止点，不能用 stub/删除检查补绿色结果。
7. **最终发布判断**：必须同一源码、同一 buildId 的测试/候选/zip/回执绑定，真实 GUI 正例通过且空白页负例被拒，只读复核 hash 不变。真实安装 apply→restart→restore 仍按原计划等待用户当次授权；不自行操作。已跳过的干净机器验证如保留缺口，在发布说明披露，不擅自扩任务。

### 可直接使用的低风险复核命令（PowerShell）

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
git status --short
git rev-parse HEAD
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm.cmd run lint
if ($LASTEXITCODE -ne 0) { throw 'lint failed' }
node tools/r5-run-suite.cjs run tests/unit/release-eligibility.test.ts tests/unit/run-suite-wrapper.test.ts tests/unit/smoke-packaged.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
if ($LASTEXITCODE -ne 0) { throw 'release unit tests failed' }
node tools/r5-run-suite.cjs run tests/unit/image-formats.test.ts tests/unit/image-probe.test.ts tests/unit/image-animated.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
if ($LASTEXITCODE -ne 0) { throw 'image unit tests failed' }
```

修复后补充实际新增的生命周期/完整性回归文件；不能只运行上述旧用例就宣布修复完成。

当前缺陷复现（无真实构建、无删除、无应用启动）：

```powershell
node handoff/review-2026-09-14-r2/reproduce-review.cjs 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
```

该脚本断言的是“当前错误行为存在”，修复后理应不再原样成功；应将相同场景改写为正式测试中的正确行为断言。它不能替代真实发布验证。

### 完整构建命令（仅在前述修复与安全审批条件满足后，由实施者执行）

```powershell
# 不设置 OTS_STEP_STUB/OTS_NODE_BIN，不加 skip 参数；buildId 自动生成。
npm.cmd run release:build -- --strict
if ($LASTEXITCODE -ne 0) { throw 'release build failed; preserve evidence and stop' }
# 将下面值替换为上一步真实输出的 buildId；verify 必须保持只读。
npm.cmd run release:verify -- '<实际 buildId>'
if ($LASTEXITCODE -ne 0) { throw 'read-only release verification failed' }
```

本报告没有执行这些构建命令。遇到删除审批提示必须走审批，不更改环境标志或计数；遇到文件失败保存证据，不覆盖/清空旧候选强行重跑。

## 5. 完成标准

- [ ] R1 非自引用生命周期的真实调用正例通过，hash 在登记后及重复核验中不变。
- [ ] R2 缩减策略、畸形与重复步骤均拒绝，齐全可信记录通过。
- [ ] R3 实际完成文件集合等于预期，无未批准 skip/todo、无失败/Unhandled Error。
- [ ] R4 集成验证的 worker 与最终打包 worker 同源，缺失/陈旧分支已覆盖。
- [ ] R5 归因有证据层级，保留安全控制，无未经授权系统处置。
- [ ] 同一新候选真实完整链通过；当前 65 项定向单测不能替代这一项。
- [ ] 按授权完成真实安装闭环，或清楚保留其未验证状态，不夸大发布结论。

本轮仅新增审查报告、复现辅助脚本、证据与规划记录；没有修改项目业务代码。
