# Alpha 发布收尾实现方案（供执行 agent 使用）

日期：2026-09-13。检查基线：`eed1f45`。目标版本当前为`0.1.0-alpha.1`。

实际项目：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。用户书写的`OpenCode\_Theme\_Switcher`嵌套目录不存在；所有任务在实际项目执行，不另建同名空项目。

## 0. 任务边界及完成定义

这是实现方案，**不是已完成记录或发布授权**。本轮只写本文档。

后续执行者应修通发布工具、生成包含最新修复的新候选、完成必要验证；不新增主题功能，不扩大图片格式范围，不重构已验证的ASAR备份/替换/恢复安全机制。

阶段权限：

- 取得实施本方案的授权后，可修改相关代码和测试、执行合成目标测试、创建全新构建产物；保护现有未提交改动和旧候选。
- 修改真实OpenCode安装前，必须取得当次确认，并等用户保存工作、完全退出应用；不继承历史授权，不擅自强杀进程。
- 推送仓库、创建公开Release、上传zip、打标签及公开含个人路径的材料，按实际操作另行取得授权。本方案不代替发布确认。
- A6干净机器验证已经由用户决定跳过：登记未验证风险即可，不重复要求准备VM，不把跳过写成通过。

完成分两层：

1. **工程完成**：下面P0–P4验收通过，新候选真正包含修复，来源/内容/zip一致，包内依赖可运行。
2. **允许建议Alpha发布**：P5真实闭环通过，P6材料与风险声明就绪，无启动/恢复阻断；最后由用户确认发布对象及渠道。

## 1. 已知现状与证据

上轮实测（不是本轮重跑）：typecheck、lint退出0；25文件、323项单元/集成测试全部通过。独立日志：

[suite-2026-09-13T14-09-54-150Z-7319.log](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/node_modules/.cache/ots-test-logs/suite-2026-09-13T14-09-54-150Z-7319.log)

但发布核验仍exit1，7项中2失败。当前登记为`candidate-manifest/1`，源提交`871703d`、buildId=`manual-repack-20260912`，zip hash=`9212617177fa9bb7c8f46b5bd313f7c76484f26e2c646d5e9e9de598c7e81c6c`。它不含最近两轮修复，禁止用新说明把旧zip冒充新候选。

新确认的两个阻断：

- **B1 路径命名错误**：磁盘清单以`out`目录为基准，产生`main/...`；归档清单和必需模块列表使用`out/main/...`。本机各50个文件比较成缺50、多50，三个必需图片模块全被判缺失。单测传夹具上层目录，没覆盖真实调用。
- **B2 登记与源码冻结互相冲突**：根目录manifest已被Git跟踪。登记写入后会被判工作树不干净；提交它又使HEAD变化，与登记sourceCommit不相等。只改commit字段会再次改脏文件，不能作为解决方式。

另需防止回退：新版release-gate用verify-release替换了verify-package，但产物身份/清单一致性不等于包内sharp和运行时依赖可用。新流程必须保留两类检查。

## 2. 固定的设计决策

### 2.1 统一清单键为项目逻辑路径

所有磁盘清单、manifest、ASAR清单、必需模块列表统一采用`out/...`正斜杠路径。`outManifestOfDir(outDir)`的参数固定是**out目录本身**，返回键显式加一次`out/`；不得靠调用者偶然传父目录实现对齐。

### 2.2 生成的manifest与源码分离

推荐采用以下结构，`<buildId>`运行时生成，包含时间、源码短SHA和随机后缀；禁止只用日期，也禁止覆盖已有目录：

```text
<项目>/candidate-<buildId>/
  win-unpacked/                 实际候选程序目录
  candidate-manifest.json        本次只写一次的身份登记
  build-record.json              本次构建来源、输入、工具版本、退出码
  evidence/                     本次日志和验收摘要，不随程序整目录打包
<项目>/candidate-<buildId>.zip    仅从win-unpacked内容生成
<项目>/candidate-<buildId>.sha256.txt
```

新manifest放在已有`candidate-*/`忽略范围内，**不参与源码提交**。根目录已跟踪的旧manifest保留为历史记录，不覆盖、不删除、不通过它自动定位新发布候选。更新其用途说明；新发布命令必须显式接受`--manifest`，旧身份核验可继续走历史入口。

manifest不放入被压缩的程序目录，否则zip hash登记易产生自引用循环。manifest、校验和可以作为独立发布附件；目录、zip hash、构建记录必须可互相追溯。

源码冻结仍严格保留：构建输入有未提交改动、新增未跟踪源码、Git状态读取失败均拒绝；不能整体忽略工作树变化。验收证据和生成目录按明确路径分离，不把它们伪装成源码修改。

### 2.3 只构建一次，再校验冻结产物

采用以下顺序，不能登记后又调用会重建的dist：

`冻结源码 → 类型/lint/单元/集成 → 干净构建 → GUI/运行期测试 → 打包到唯一目录 → 包结构/依赖核验 → 生成zip → 登记 → 发布身份核验 → 同包真实闭环`

新增独立的“仅校验既有候选”入口，不执行build/dist，供真实闭环后再次核验。构建链中任何一步失败立即停止，保留原始非0退出码及日志，不续跑到ALL_GREEN。

## 3. 任务分解

### P0：开工基线与保护措施

1. 读取Git状态、当前HEAD、本方案及最近两轮审查；如基线已变化，先核对差异，不机械重复已完成修复。
2. 记录工作树改动归属、当前候选身份；不使用`git reset --hard`、批量还原或强制删除旧候选。
3. 使用新的交接进度记录`EXECUTION_STATUS.md`；每步填命令、退出码、证据、提交/来源，未执行保持未执行。
4. 对涉及构建的覆盖范围先确认：现有`build:main`会清理out，它是构建输出但可能仍用于旧候选取证。需要保留时先做明确范围的可恢复归档，不操作真实安装。

完成标志：基线明确、未提交改动已保护、旧zip及manifest hash留存。

### P1：修复B1——清单规范及真实调用测试

主要位置：

- [verify-release.cjs](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/verify-release.cjs:132)
- [candidate-manifest.cjs](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/candidate-manifest.cjs:110)
- [verify-release.test.ts](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tests/unit/verify-release.test.ts:198)

实施要求：

1. `outManifestOfDir(outDir)`为每个相对路径添加一次`out/`前缀；传入参数已是out目录，不能再搜索`outDir/out`。
2. ASAR键及REQUIRED_MODULES保持相同规范；明确拒绝重复键、越界键及空清单。路径分隔符统一为`/`。
3. 更新调用处与注释，避免一处加前缀、一处又加导致`out/out/`。
4. 测试必须创建`fixture/out/main/...`，实际调用`outManifestOfDir(fixture/out)`，再与同一文件内容构造的ASAR比较；不能只比较手写的manifest对象。
5. 覆盖正例：完整清单相同，三个图片模块均存在；负例：缺文件、多文件、单字节变化、中文/空格路径、不同平台分隔符。

验收：正例的missing/extra/changed全部为空；仅改ImageStore时只报告对应文件内容变化，不再出现整批缺/多。

### P2：修复B2——候选登记、构建来源与源码冻结

修改范围：上面的两份候选工具、[release-gate.sh](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/release-gate.sh)、相关单测、[.gitignore](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/.gitignore)用途注释。

实施要求：

1. 按2.2节将新manifest定位到每次构建的产物目录。register增加显式`--manifest`参数，已存在目标默认拒绝覆盖；所有核验工具使用同一参数，不偷偷回落根目录旧manifest。
2. 使用唯一buildId，绑定源码提交、锁文件hash、版本、完整out清单、exe/asar/zip hash、打包方式及构建记录hash。注册前必须检查构建记录确实属于本次输入，不接受“旧out存在就代表刚构建”。
3. 构建前后均检查冻结状态。Git查询失败必须返回错误，不能用空字符串当干净状态；新增未跟踪的src或构建脚本应被阻止，而不是统一忽略`??`。
4. 源码commit应在全部工具修改及静态文档修改完成后固定；生成manifest和运行日志不改变它。测试/打包中若源码变化，废弃该次候选身份，重新开始，不伪改登记SHA。
5. 核验时实际比较锁文件hash、package版本与登记，不能只记录不用；同时检查buildId、manifest路径、候选路径和zip所属关系。
6. 若将来要把发布结果提交到仓库，使用独立发布摘要，注明sourceCommit；不要再要求“记录这份发布摘要的提交必须等于构建源码提交”。当前Alpha可保持构建checkout不变，结果先落生成目录。

必须增加**命令级集成测试**：在独立小型Git夹具中执行“初始化源码并提交 → 生成合成产物 → 注册到忽略的产物目录 → 验证”。Git仍干净、HEAD未变、验证成功；这是B2核心正例，不能用单独调用纯函数代替。

负例：源码改脏、未跟踪源码、Git不可用、错误锁文件、旧buildId、错误候选目录、空/过期构建记录，全部失败且不生成成功登记。

### P3：串通发布全链，保留包可用性门禁

主要位置：[release-gate.sh](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/release-gate.sh)、[verify-package.cjs](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/verify-package.cjs)、[r5-run-suite.cjs](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/r5-run-suite.cjs)、[test-release-gate.cjs](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/tools/test-release-gate.cjs)。

实施要求：

1. 推荐新增一个统一发布编排入口；具体文件名由执行者决定并记录。把现有shell门禁改成它的薄入口或明确分成构建/验证两种模式，避免出现两条顺序不一致的链。
2. 将D盘项目专用临时目录策略接入实际单元/集成步骤，而不是仍直接调用不带策略的`npm run test:integration`；保持CI可配置，不硬编码个人路径，不关闭安全软件。
3. build、打包各执行一次。electron-builder输出明确覆盖为本次唯一目录，不能只给verify传新目录而dist仍写旧目录。manifest必须在打包、zip完成后生成；结束后不再构建。
4. 保留现有ASAR结构、入口、unpacked实体、依赖完整性、隐私扫描、包内sharp真实出图等检查。可以重构成共享校验函数，但不以`--no-identity`作为发布通过捷径。
5. verify-release负责来源/内容/zip绑定，verify-package负责结构/依赖可用性，两个职责都必须通过。调用名称分别显示，避免把身份核验日志标为包可启动。
6. 对zip做实际读取/解压完整性验证，不只信中央目录声明的CRC；逐文件比较候选内容，检查缺/多/重复/越界条目，禁止解压越出专用目录。不要把manifest或旧zip误打进新zip。
7. 测试日志写每个runId自己的目录，不能覆盖共享旧日志。mock测试清除继承的绑定变量，再按场景注入，覆盖成功、每步失败、缺绑定及重复运行。
8. 为打包启动保留运行环境差异：包内依赖探针可用Electron的Node模式；真正GUI冒烟必须移除子进程环境中的`ELECTRON_RUN_AS_NODE`，不改系统全局变量，不关闭Chromium sandbox。

验收：任何类型/lint/测试/构建/打包/原生依赖/登记/zip核验失败都阻止成功；完整成功链执行一次后不需手改路径、补文件、改manifest才变绿。

### P4：冻结并生成新的Alpha候选

前置：P1–P3正反例通过，相关代码已完成，并在允许提交的工作流中固定源码提交。不新增产品功能。

1. 先跑typecheck、lint、全量单元/集成以及发布工具命令级测试。基线323项仅供回归参考；本方案新增测试后数量应上升，记录实际数量，禁止修改断言或减少收集范围凑通过。
2. 选择未使用的buildId和全新输出目录，按P3一条完整链运行；记录Node/Electron/打包器版本、锁文件hash与每步退出码。
3. 同版本号如尚未对外发布，可保留`0.1.0-alpha.1`并通过buildId区分；如用户确认已有公开同版本，改用新预发布版本，同步package和lock，不能覆盖已公开同名资产。
4. 包内抽查图片修复模块的实际内容与本次out完全一致；不得只搜函数名证明全部修复已入包。
5. 完成当前机打包GUI冒烟：启动、选图/JFIF导入、取色、预览、关闭重开。此处不修改真实OpenCode安装。
6. 生成校验和、候选身份及运行日志。旧候选保留并明确“历史/禁止作为最新分发”，不强删被占用文件。
7. 发布包明确附项目许可及必要第三方说明。当前包顶层白名单不允许LICENSE，若调整打包范围要同步收窄更新白名单，或把许可放便携目录随zip发布；不要为加一个LICENSE把整个docs/handoff打进去。

验收：生成候选目录、zip、manifest、构建记录及校验和；只读再核验通过；GUI可启动，来源可追溯。完成到此仅称“候选工程验证通过”。

### P5：新候选的真实应用/恢复闭环（授权关口）

先向用户说明目标OpenCode路径/版本、将修改的归档、健康备份和恢复方案，请用户保存工作并完全退出。未确认时停止此阶段，不能凭方案或旧授权继续写入。

获得确认后，只使用P4同一份候选，按下表执行；每步绑定buildId与归档hash，应用后重启再观察。

| 顺序 | 操作 | 必须核验 |
|---|---|---|
| 1 | 记录应用前状态和健康备份 | 原始归档hash、目标版本、备份健康、恢复入口可用 |
| 2 | 应用JFIF图片A | 资源hash正确；OpenCode启动；背景、侧栏、输入、菜单、终端与代码区可读 |
| 3 | 换透明PNG B、静态WebP C | 每次都匹配新图；不累积HTML/CSS注入；会话功能仍可用 |
| 4 | 再次应用同一C及同参数 | no-op，不改归档、不新增替换事务 |
| 5 | 深浅主题及常用125%/150%缩放 | 选择态/按钮/正文对比度可用，背景不遮挡操作 |
| 6 | 恢复上一主题 | 对应归档hash、启动和界面正常 |
| 7 | 恢复首次接管快照 | 回到接管时状态；无出厂证据不称“恢复出厂原版” |

不把“资源写入成功”当“真实窗口验收通过”。失败就停，先按已验证健康快照恢复；无健康可恢复证据则请求用户方向，不从网上换旧版安装绕过问题。最终状态需记录，并与用户期望一致。

### P6：发布材料及GO/NO-GO

1. 更新[alpha-acceptance.md](D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/docs/alpha-acceptance.md)对应记录，区分历史源码测试、新包工程验证和P5真实闭环；不预填成功。
2. 生成与新候选一致的版本说明、zip校验和、兼容范围、恢复说明、错误反馈模板。说明非官方、Alpha、未签名、需退出重启；不引导关闭安全软件。
3. A6标为“用户决定跳过/未验证”，平台能力声明不超出实测范围。演示素材不是必要阻断，可后补；启动与恢复证据不能后补冒充已验证。
4. 公开前处理既有隐私清单：用户名、个人路径、截图和历史邮箱分别由用户确认公开范围；本机取证文件不默认上传。
5. 结果写入候选证据目录，保持已冻结源码checkout不变。若需要提交最终验收文档，使用独立发布记录流程，不改变候选sourceCommit解释。
6. 用户确认发布目标/渠道/版本后，才进行外部上传和Release操作。没有发布权限时交付文件与结论，不自动发布。

## 4. 总体验收矩阵

| 用例 | 预期 |
|---|---|
| 真实参数outManifestOfDir(ROOT/out)与同内容ASAR | 清单完全一致，三个必需模块存在 |
| 只改ImageStore，其他入口不改 | 对应内容变化被识别，旧候选被拒 |
| 小型Git夹具真实注册→核验 | 无manifest自制造的dirty/HEAD矛盾 |
| 源码改脏或新增未跟踪构建输入 | 构建前拒绝，不产生可发布登记 |
| Git不可用、锁文件不同、buildId/目录不匹配 | 明确失败，不回退默认历史候选 |
| dist失败、包内sharp缺依赖、zip损坏 | 原因可定位，外层非0，无成功结论 |
| 连续两次候选构建 | 输出/日志/manifest互不覆盖，旧候选保留 |
| 重新运行“仅验证候选” | 不调用build/dist，不改变任何产物hash |
| 当前新包GUI启动、图片导入预览 | 正常，包含JFIF/JPE既有支持 |
| 新包真实应用→重启→换图→恢复 | 成功且证据绑定同buildId，失败不得GO |

## 5. 命令与执行方式

目前可用的静态检查与测试命令如下。每条结束立即记录`$LASTEXITCODE`，不以最后一条命令的成功掩盖前面的失败：

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
npm.cmd run typecheck
npm.cmd run lint
node tools/r5-run-suite.cjs run --maxWorkers=2
node tools/test-release-gate.cjs
```

新增`--manifest`、统一编排入口及“仅验证候选”入口是**待实现接口**，现有代码尚未支持。执行者在P2/P3完成后，必须在本目录补一份`RUNBOOK.md`，给出实际可运行的完整命令；不要把伪命令当作现有脚本执行。

RUNBOOK至少包含：代码测试、构建并登记新候选、只读核验指定manifest、包内依赖检查、GUI启动环境处理、真实验收授权关口、失败日志位置。Windows的shell入口应明确使用已安装Git Bash或PowerShell，不依赖PATH中的WSL bash；不使用会弹前台窗口的后台启动方式。

## 6. 工作拆分与交付要求

- P1可单独实现并提交；P2涉及两份候选工具及格式契约，由同一负责人统一。
- P3依赖P1/P2接口，避免多个agent同时修改verify-release或manifest格式。
- P4必须等待P1–P3验收结束；P5必须等待新候选和用户确认；P6依赖真实结果。
- 建议提交主题：清单路径统一 → 生成登记与源码冻结分离 → 发布链一次构建及双重校验 → 候选验证证据。不要执行全仓库`git add .`把私人素材带入提交。
- 每阶段更新`EXECUTION_STATUS.md`。最终交付：代码/测试差异、实际RUNBOOK、源码提交及buildId、manifest/zip/校验和、失败注入与正例日志、真实闭环证据、已知限制和GO/NO-GO结论。

最终原则：**不再扩功能，但也不能把“源码测试通过”替代“准备分发的那份包能安全应用和恢复”。**
