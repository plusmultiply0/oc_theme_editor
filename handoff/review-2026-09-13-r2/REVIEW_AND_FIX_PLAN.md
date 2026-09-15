# OpenCode Theme Switcher 第二轮复审：问题与执行方案

审查日期：2026-09-13。源码基线：`48dea8e`，版本：`0.1.0-alpha.1`。

实际项目目录为 `D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。用户消息中的 `OpenCode\_Theme\_Switcher` 嵌套路径不存在。本报告与前次交接一致，放在实际项目的 `handoff/review-2026-09-13-r2/`，不另建空项目。

范围：复查上轮 R1–R6 的修复及关联调用链，执行类型检查、lint、单元/合成安装集成测试、包校验与隔离故障复现。**本轮未修业务代码、未执行构建/打包、未改真实 OpenCode 安装、未发布。**以下执行方案交给后续 agent 实施。

## 一、结论

有问题，现状不宜作为“最新修复已完成”的初版直接分发。

- 新增诊断文件使类型检查和 lint 确定失败，是当前发布门禁阻断项。
- 在用缓存误删已修掉普通场景，但仍有可稳定复现的清理/导入竞态。
- 当前候选明确不含最新图片修复；默认包校验仍然全过，发布链未可靠绑定本次构建。
- 缩略图损坏处理与两处测试脚本还有缺陷。
- 好消息：使用 D 盘专用测试临时目录时，**23 个文件、295 项单元/集成测试全部通过**；`.jfif/.jpe` 支持及合成安装格式轮换闭环已通过，不是当前主要障碍。

本报告列 **6 项**：3 项 P1、3 项 P2。P1 应在下一候选冻结前修完；测试全过不覆盖本文新构造的边界场景。

| 编号 | 优先级 | 问题 | 证据性质 |
|---|---|---|---|
| S1 | P1 | 新诊断测试破坏 typecheck/lint | 命令执行，两次一致 |
| S2 | P1 | 清理引用快照过期，误删清理开始后新导入图片 | 当前源码确定性并发复现 |
| S3 | P1 | 旧候选与本次构建脱节，包校验覆盖不足 | 实际37项通过 + 归档内容读取 + 调用链检查 |
| S4 | P2 | PNG 文件头被误当作健康缩略图 | 当前源码截断样本复现 |
| S5 | P2 | 全量测试包装脚本吞掉失败退出码 | 真实脚本注入子进程失败复现 |
| S6 | P2 | 门禁测试本身覆盖共享历史日志 | 明确代码写入路径；为保护证据未执行原脚本 |

## 二、上轮修复复核

| 上轮编号 | 本轮判断 |
|---|---|
| R1 dist 失败仍 ALL_GREEN | **原缺陷已修复**。隔离执行真实脚本，mock dist=17，整体退出17，输出STOPPED，无ALL_GREEN。不要再次按旧缺陷返工。 |
| R2 默认核对旧坏目录 | 默认现在指向manifest登记的`.new`，不再指向旧坏目录；但“登记候选”不等于“本次构建”，见S3。 |
| R3 缩略图误删/预览回退 | 普通清理和缺失回退测试通过；清理开始后新登记的记录未进入快照，见S2；损坏PNG漏检见S4。 |
| R4 读图资源限额 | 已补副本受限读取、短读循环、像素分配前校验，相关8项测试通过。本轮不复用旧的“整读64KiB才拒绝”结论。 |
| R5 FILE_LOCKED测试失败 | D盘隔离临时目录复测295/295通过；C盘隔离临时目录仍受占用影响，不能泛化为“只要离开系统TEMP就好”。包装脚本另有S5。 |
| R6 验收记录 | 已明确旧候选不含修复、A6用户跳过及当前NO-GO。方向正确；A4历史通过不应被解读为当前HEAD的门禁通过。 |

## 三、逐项问题与修复任务

### S1 / P1：新增诊断文件使基础门禁失败

定位：[r5-apply-diagnosis.test.ts:39](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tests/diagnose/r5-apply-diagnosis.test.ts:39)、[同文件:198](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tests/diagnose/r5-apply-diagnosis.test.ts:198)。

实测：

```text
npm run typecheck -> exit 2
39:21 TS6133 pngBytes 未使用
41:1  TS6133 ADAPTER 未使用
198:7 TS2698 Spread types may only be created from object types

npm run lint -> exit 1
39:21 pngBytes 未使用
41:10 ADAPTER 未使用
```

原因：`EVIDENCE`被声明为`Record<string, unknown>`，因此`EVIDENCE.applyLoop`是unknown，不能直接展开。对象末尾的类型断言不能让前面的非法展开合法。Vitest默认不收集`tests/diagnose`，但tsconfig包括整个tests，eslint也会检查它，所以295项通过与这里失败可以同时发生。

执行方案：

1. 删除未使用的`pngBytes`与`ADAPTER`导入。
2. 给诊断数据定义明确接口，或把`applyLoop`保存在局部有类型对象中，展开局部对象，再赋给EVIDENCE；不要用any、关闭strict、扩大eslint忽略范围来掩盖错误。
3. 诊断脚本可以独立运行，但保留静态检查，避免取证代码损坏日常开发门禁。
4. 重新执行typecheck/lint并单独记录退出码；二者均为0后才能继续冻结候选。

验收：错误全部消失；`tsconfig.json`与lint规则没有被弱化；295项回归保持通过。

### S2 / P1：清理开始后导入的新图片仍会被误删

定位：[image-store.ts:363](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/src/main/services/image-store.ts:363)，[启动清理:137](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/src/main/index.ts:137)，[现有并发测试:102](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tests/integration/thumbnail-retention.test.ts:102)。

原因：`keepContentIds`、`keepThumbIds`及路径集合只在清理开始时生成一次。之后`await fs.readdir()`让出执行权；新导入可以在此期间登记并写完文件。恢复清理时，目录列表包含新文件，但旧保留集合不含它，于是按孤儿删除。所谓“先登记再写文件”的保证只覆盖**早于快照登记**的记录。

确定性复现顺序：

1. 开始`cleanOrphanCaches([])`，让它完成保留集合快照。
2. 在content目录的`readdir`处暂停。
3. 导入一张本轮生成的小PNG，等待副本和缩略图全部写完。
4. 放行`readdir`及清理。

结果：导入返回成功；随后清理删除2个文件，副本及缩略图均不存在；`readBytes`返回`IMAGE_CONTENT_MISMATCH`。

这是受控调度证明的有效交错，不代表每次启动都会发生。启动清理当前是后台任务，窗口同时创建，使该交错具有业务入口。现有`Promise.all`测试没有固定调度，很容易刚好在B图片落盘前列完目录而漏过。

执行方案：

1. 对清理与图片导入/物化建立互斥或生命周期屏障，保证清理不能对正在新增的文件使用旧引用判断。启动就绪前不开放相关IPC也可作为第一道屏障。
2. 即使使用启动屏障，也把ImageStore自身的并发约束写清，避免未来增加定时清理时再次触发。若选择逐文件实时引用校验，应证明校验到删除之间的交错安全，而不只在函数入口重建集合。
3. 新增带deferred/barrier的确定性测试，固定上述顺序；不靠sleep或重复跑概率测试。
4. 同测反向顺序、正常孤儿删除、在用副本/缩略图保留及失败导入；不采用“永不清理”的规避方式。

验收：上述交错下导入和之后的readBytes/preview均成功，文件存在；真正的孤儿仍能删除；启动清理异常不允许绕过恢复安全流程。

### S3 / P1：当前候选不含修复，门禁仍可能核对旧构建

定位：[candidate-manifest.json](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/candidate-manifest.json)、[release-gate.sh:54](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/release-gate.sh:54)、[verify-package.cjs:315](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/verify-package.cjs:315)。

实际身份：

```text
HEAD:          48dea8e
candidate源:   871703da2bd775a2af1a9eb464b813a57e6fb8ae
buildId:       manual-repack-20260912
候选目录:      candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1/win-unpacked.new
app.asar hash: 7ca56cc52318ce49193fe32100e195a4885aaac7681660846a180daab4efdce8
zip hash:      9212617177fa9bb7c8f46b5bd313f7c76484f26e2c646d5e9e9de598c7e81c6c
默认包校验:    exit 0，37项，0失败
```

归档读取确认：当前源码有`keepContentIds`和`readThumbnail`，候选中的ImageStore均没有。验收文档已诚实披露这个差异；本项不是指控文档隐瞒，而是说明工具没有拦住差异。

缺口有三层：

1. `dist`按package输出目录构建`win-unpacked`，门禁默认verify却读manifest里的`win-unpacked.new`。`GATE_CANDIDATE_DIR`是可选的，未强制生成本次候选登记，也未将本次dist产物传下去。
2. 校验只把包内`out/main/index.js`、`out/preload/index.js`、`out/core/patch/stage.js`与本地out比较；本次实际修改的ImageStore、generate、image-probe不在比较集合。且本地out本身也可能是旧的，因此不能证明与HEAD源码一致。
3. zip hash与登记相符只证明该zip未改变；分别核对asar/zip两个hash，并不能自动证明zip内部就是所检目录。当前zip并未发现配错，但这条关系缺少自动检查。

执行方案：

1. 将“旧候选身份核验”和“本次发布门禁”分开命名与输出。旧包身份正确可以成功，但不得据此宣布当前源码已通过发布验收。
2. 发布构建使用唯一buildId和新的输出目录；禁止默认回落到历史manifest。保留旧目录用于取证，不要为解决占用而强删。
3. 构建前冻结准确源码提交及相关工作树状态。构建后登记实际来源提交、锁文件hash、完整产物清单；不要仅把manifest的sourceCommit改成HEAD而不重建。
4. 对本次生成的完整`out/**`及必要运行元数据做文件列表和hash核对，至少必须覆盖图片修复模块；列表缺文件、多文件也应报告。旧out不能充当当前源码的唯一证据。
5. 从同一候选目录生成zip，检查zip内exe、asar、unpacked文件与清单一致，再登记zip hash。分发验收禁止使用`--no-identity`。
6. 门禁全链都显式绑定这份新登记；显式目标与manifest不一致时失败关闭，不允许自动重登记来掩盖不一致。
7. 重新运行新候选的包内原生模块检查、启动冒烟及授权后的真实应用/恢复验收。不能沿用旧zip的截图与A4记录证明新候选。

验收负例：只改ImageStore然后构建，旧候选必须被发布门禁拒绝；本次dist产物与manifest目录不同必须拒绝；zip内部混入旧asar必须拒绝。正例：同一来源、目录、文件清单、zip的全链核验通过。

注意：本轮没有实际重跑dist；“dist成功后仍核对旧包”是基于脚本目标解析的确认缺口，未冒充一次真实打包全链实测。

### S4 / P2：损坏PNG缩略图会被当作成功预览

定位：[image-store.ts:313](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/src/main/services/image-store.ts:313)。

原因：`readThumbnail`只限制文件体积并检查PNG magic bytes。文件头保留但像素已损坏的缩略图仍会直接转成data URL；不会走健康私有副本重建。

复现：导入健康PNG，把**本轮测试自己的缩略图**截成16字节；`previewDataUrl.success=true`，返回的图片无法解码，缩略图仍16字节；`readBytes`确认私有副本健康。

执行方案：

1. 返回缓存前验证其完整性。可保存并核对自己生成的缩略图hash；没有可信hash时做受限完整解码，而不是仅metadata或magic检查。
2. 对缩略图采用更小的尺寸/像素上限（依据生成的320×320边界），保留现有2MiB读取上限，拒绝多帧等非预期派生数据。
3. 校验失败统一进入现有健康副本回退，重建成功后再返回成功。重建落盘优先使用临时文件+替换，降低崩溃留下半张PNG的概率。
4. 新增截断但保留文件头、头/metadata有效而像素坏、尺寸异常、普通缺失及副本损坏测试。确认返回的data URL真实可解码。

验收：16字节样本能回退恢复；私有副本不变；健康缓存仍可快速预览；副本也坏时明确失败，不把坏data URL作为成功结果。

### S5 / P2：推荐的全量测试包装脚本会吞掉失败

定位：[r5-run-suite.cjs:11](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/r5-run-suite.cjs:11)、[同文件:23](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/r5-run-suite.cjs:23)。

原因：脚本打印`r.status`、写日志，却不设置自己的`process.exitCode`。正常启动但测试失败时，外层仍自然退出0；超时/被信号终止的status=null也未处理。

复现：执行真实包装脚本，mock子进程返回23，并拦截其固定证据写入。输出`exit=23 signal=none`，外层实际退出0。**未运行实际失败测试来污染历史日志。**

执行方案：

1. 保留日志后明确传播退出码，例如：`process.exitCode = r.error || r.signal || r.status === null ? 1 : r.status`。不要只打印退出码。
2. 以本次runId命名日志，先创建证据目录，避免覆盖原先的`r5-full-suite.log`；日志失败也不能吞掉子进程失败。
3. 把D盘临时目录策略整合为明确的测试入口/选项，接入发布链；不要只写在诊断记录里让使用者自己猜。路径可配置，不硬编码个人盘符；CI保持可移植。
4. 为成功0、普通失败23、spawn错误、超时/信号终止补包装层测试；测试只用stub或小子进程，不触碰真实安装。

验收：`node tools/r5-run-suite.cjs`外层退出码与测试结果一致，失败永不返回0；新运行不覆盖旧证据。

### S6 / P2：门禁测试为了验证“不覆盖日志”，先覆盖了旧日志

定位：[test-release-gate.cjs:48](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/test-release-gate.cjs:48)。

直接写入代码为：`echo OLD-EVIDENCE > /tmp/a4-gate.txt`。它在每个场景开始时都会覆盖共享旧日志；后续`SENTINEL_INTACT`只能证明刚写的哨兵没变，不能证明原有审查记录被保留。

此外，`ls /tmp/a4-gate-*.txt`只要找到任意历史日志就通过，不能证明**本次运行**创建了独立日志。原始测试因此未在本轮直接执行。

执行方案：

1. 给release-gate增加可注入的日志目录，测试传每个场景独立的临时目录；生产默认目录也应有清晰归属。
2. 哨兵放在该场景临时目录，不写共享`/tmp/a4-gate.txt`。不要采用“先备份共享日志再恢复”替代隔离，因为中断及并发仍可能损失记录。
3. 比较本次运行前后文件集合，验证恰好新增预期runId日志、内容含本次步骤与退出码；不能用全局通配符命中历史文件充数。
4. 固定/清理测试环境中的`GATE_CANDIDATE_DIR`，对显式目录分支也做stub测试，避免继承开发者环境后误走真实命令。

验收：预先存在的共享旧日志完全未访问/修改；全绿与逐步骤失败传播均通过；并发两次运行的证据互不覆盖。

## 四、建议执行顺序与交付物

每一步完成后独立提交相关代码和测试；不要顺手重写无关恢复逻辑、忽略安全检查或改真实安装。

1. **先修S1**：恢复typecheck/lint；输出两条命令的独立退出码。
2. **修S2、S4**：补确定性边界用例，修ImageStore并发与缓存完整性；跑图片相关定向测试及295项全量回归。
3. **修S5、S6**：包装层失败传播和日志隔离；补失败注入测试，将安全临时目录入口接入门禁。
4. **修S3**：产物绑定、清单/zip一致性、门禁负例；代码完成后先冻结源码，再生成全新候选。不要沿用现有zip名称/身份冒充已含修复。
5. **更新验收**：按“源码提交 + buildId + 目标目录 + exe/asar/zip hash + 命令退出码”整理本次证据；历史结果保留但明确日期/来源。
6. **真实闭环另行取得用户确认**：用户保存并退出OpenCode后，才从本次候选做JFIF→PNG→WebP→重复应用→恢复与重启可用性检查。本报告不视为这项写入授权。

A6已被用户决定跳过：继续记录未验证风险并收窄平台声明，不重复要求准备VM，也不能填为通过。发布决定仍需用户确认；目前仅适合内部修复验证。

### 当前可安全复核的命令

在PowerShell中：

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
npm.cmd run typecheck
# 单独记录 $LASTEXITCODE
npm.cmd run lint
# 单独记录 $LASTEXITCODE
node tools/verify-package.cjs
# 此命令目前仅证明登记旧候选的现有检查通过，不代表HEAD修复入包
```

本轮通过的测试调用（运行测试会生成/清理自己的合成fixture）：

```powershell
$env:TEMP = 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher\node_modules\.cache\ots-review-r2-tmp'
$env:TMP = $env:TEMP
node node_modules/vitest/vitest.mjs run --maxWorkers=2
```

在专用终端执行上述临时目录设置，不更改系统全局环境变量；后续正常入口应由S5统一管理。本轮用该目录23文件/295项通过。不要关闭安全软件或强杀占用进程来“制造通过”。

附带的`reproduce-current.cjs`可用Node执行，并可把项目绝对路径作为首个参数。它在内存中转译当前TypeScript，仅创建自己脚本旁边的新`isolated-*`合成目录，不改业务源码或真实安装。当前复现输出是**缺陷证据**，脚本exit0表示探针跑完，不表示产品通过；修复验收应把这些场景转成正式断言测试。

## 五、本轮验证记录与边界

| 检查 | 结果 | 解释 |
|---|---|---|
| typecheck | exit2，3条错误；复跑相同 | S1确认 |
| lint | exit1，2条错误；复跑相同 | S1确认 |
| 默认verify:package | exit0，37项全过 | 旧登记候选，不是最新源码发布证明 |
| D盘专用临时目录单元/集成 | exit0，23文件295通过，16.48秒 | 包括合成安装格式轮换及Electron运行期集成，不等于真实用户安装视觉验收 |
| C盘审查专用临时目录同套测试 | exit1，64失败231通过 | 多处FILE_LOCKED/EPERM/EBUSY；D盘重跑全过，不把64项全定为业务缺陷 |
| 清理/导入交错探针 | 导入成功后副本及缩略图被删 | S2确认 |
| 截断缩略图探针 | 预览成功，但返回图无法解码 | S4确认 |
| 测试包装脚本故障注入 | 子进程23，外层0 | S5确认 |
| dist故障注入 | 整体17，无ALL_GREEN | 上轮R1已修复 |
| 构建、打包、GUI E2E、真实安装写入/恢复 | 未执行 | 本轮为诊断，不破坏现有构建或用户环境 |

证据文件：本目录`evidence/reproductions.json`（探针完整结果）、`evidence/validation-summary.md`（命令摘要），以及可重跑探针源码。这里没有把截断的测试输出伪装成完整原始日志。

C盘测试中部分合成归档因占用导致测试自己的清理失败，留在本轮本地审查临时目录，未强制删除；没有删除任何用户图片、项目源码或真实安装。Git审查结束时业务文件未变化。
