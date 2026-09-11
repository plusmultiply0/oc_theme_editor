# OpenCode Theme Switcher 审查与修复交接

日期：2026-09-11。被审项目：`D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher`。

本轮仅审查，没有修改被审项目、背景图片、OpenCode 安装或备份。运行了无窗口 Electron 只读诊断、Node 只读识别、合成图片的内存配色诊断。没有运行 apply/precheck/restore；precheck 也未运行，因为它包含写探针。没有重跑项目全套测试，没有完成 GUI 视觉验收。

## 结论

现状是尚未通过桌面端端到端验收的原型。截图中的目标识别失败可稳定复现；预览可读性、预览/输出一致性、旧主题迁移及原版备份判定也有明确缺陷。不能只解除按钮禁用就继续发布。

## R1 高优先级：Electron 将 ASAR 当目录，发现逻辑误判没有目标

定位：`src/core/patch/discover.ts:182`、`:302`；`src/core/patch/asar.ts:7`、`:45`。

实测同一份用户安装：

- 普通 Node 调用当前 out 中的 inspectRoot：版本 1.18.29，supported。
- Electron 36.9.5 普通 fs.statSync：isFile=false，isDirectory=true，size=0。
- 同一 Electron 的 original-fs.statSync：isFile=true，size=150584833。
- Electron 调用同一 inspectRoot：TARGET_NOT_FOUND，「该目录没有可识别的应用归档」。

因果链：Electron 包装 fs → app.asar 视为虚拟目录 → isFile 失败 → inspectRoot 判定没有归档 → discoverTargets 静默跳过 TARGET_NOT_FOUND → UI 提示没有已验证目标并禁用应用。这与软件版本不支持不是一回事。

修复：抽象物理归档 I/O 层，在 Electron 中采用 original-fs，在 Node 测试环境使用标准 fs；发现、stat、hash、备份、复制、替换与恢复一致走物理 I/O。排查 @electron/asar 内部 I/O 在 Electron 下的行为，必要时隔离到只负责物理归档的工作进程。不要全局长期设置 process.noAsar，避免破坏工具自身归档模块加载；不要通过移除 isFile 检查或放开支持白名单绕过。

验收：同一 fixture 在 Node、真实 Electron 主进程和打包版都识别一致；Electron fixture 中完整测试备份、应用与恢复，先不碰用户安装。

证据：本目录 electron-readonly-result.json；探针源码 electron-readonly-probe.cjs。
官方行为依据：https://www.electronjs.org/docs/latest/tutorial/asar-archives

## R2 高优先级：已修改安装被标为原版

定位：`src/core/patch/apply.ts:163`、`src/core/patch/backup.ts:154`、`:172`；`src/renderer/components/RestorePanel.tsx:59`。

alreadyPatched 只检查本工具的 oc-theme-custom.css；没有该文件就通过 pristine = !alreadyPatched 标记原版。但原型早已使用 snow-theme.css。只读检查当前 original 备份确认 pristine=true，同时备份 HTML 仍包含 snow-theme.css 链接。因此「恢复原版」实际上会恢复旧定制状态，不是出厂界面。

修复：把「首次接管快照」「上一主题」「已验证原版」明确区分；原版须由可信来源/固定版本指纹或有证据的原始备份证明，不能靠某个标记不存在推断。对现有元数据做有备份的迁移，把此类记录降级为未验证快照，保留原文件和恢复快照能力，禁用误导性的原版入口；不要自动重装或用下载资源覆盖当前安装。

验收：原型雪景/粉彩、其他工具补丁、未知变更、已知原版、已由本工具修改五类 fixture；只有有原版证据时允许「恢复原版」。修复前不要依赖当前按钮得到出厂状态。

## R3 高优先级：旧主题与新主题同时加载

定位：`src/core/patch/stage.ts`；`src/core/theme/css.ts:99`。

实际安装 HTML 同时引用官方主 CSS、snow-theme.css、oc-theme-custom.css。旧 snow-theme.css 实际是粉彩黑字主题，html/body/#root 上有大量 !important 的背景、文本、图标变量；新生成的普通 :root 变量无法仅凭后加载就覆盖它们，且 #root 级变量会遮蔽根部继承。因此新主题会与旧主题混用。

修复：新增已知旧主题迁移预检。对确认来源及指纹的旧注入，在保存完整当前快照并获准后，在 staged HTML 中撤下旧主题链接、只保留一个活动主题层；原文件可留在归档供恢复，不能盲删未知资源。未知第三方主题默认拒绝或提示冲突，不自动覆盖。补齐该精确版本的基础正文/侧栏/图标 token 映射。不要继续叠加更多 !important。

另一个映射问题：css.ts 定义 --ts-status-* / --ts-diff-*，但未见输出 CSS 将它们绑定到应用使用的实际 token/选择器，预览中的相应配色不等于真实应用已经生效。所有映射都需真实 DOM 验证；按钮不能不分 primary/ghost/destructive/disabled 就全部染成同一个主色。

验收：旧粉彩→新深色→新浅色→恢复接管快照；检查真实 computed styles/截图，不以归档读取成功代替视觉通过。

## R4 高优先级：可读性报告没有检查实际显示状态

定位：`src/renderer/styles.css:368`、`:382`；`src/renderer/components/Preview.tsx:28`；`src/core/theme/report.ts:54`；`src/core/theme/generate.ts:210`。

设置项是普通导航，却被 `.mock-item.muted { opacity: .6 }` 额外淡化。侧栏底色使用 panelOpacity - .06，报告却按 panelOpacity 算；报告还只使用图片代表色而非显示区域最坏背景，且所有条目仅检查 default 状态。

内存合成复现（并非测量用户截图）：32×32 纯色 #30343b，dark，遮罩 .35，面板 .86。报告 passed=true，次要文字 5.02:1；按预览 .6 文字不透明度和侧栏底色算，设置文字仅约 2.78:1。同一主题的 pressed 按钮标签约 3.54:1，也未被报告发现。

修复：普通导航不加 disabled opacity；为次要文字定义可读 token，只有真正 disabled 的状态豁免。取色与可读性分离：取色可用缩略图聚类，可读性必须用实际图像合成模型/保守保护层计算。报告覆盖侧栏、正文、输入、菜单、选中项、按钮 default/hover/pressed/focus 与链接，包含所有 alpha。将单点结果标为估算，不称「实际底色/全部达到目标」。

验收：上述合成案例必须修正或准确判失败；另测黑白棋盘、明暗交界、透明图、面板 0/.5/1、不同窗口裁剪位置。正文与正常大小按钮文字目标 4.5:1，重要非文本焦点/边界目标 3:1；这些是本计划工程目标，不等于完整合规认证。

## R5 高优先级：预览、输出、参数生效范围不一致

定位：`src/core/theme/css.ts:50`、`:60`、`:62`、`:136`；`src/renderer/components/Preview.tsx:25`；`src/renderer/App.tsx:85`、`:428`、`:457`。

- 预览用 RGBA 半透明面板，输出 panelColorOver 返回 HEX 实底，导致透明度变成改色而不是透出图片。
- 「减少透明度」只进 React 预览状态，没有进入 ThemeSpec/生成/应用/报告；用户勾选后应用不会带上这一设置。
- 模糊分支把遮罩设为 #root 的背景，图片在其 ::before 上方绘制；不像未模糊分支将遮罩直接叠在图片上，遮罩效果不一致。
- 预览对话层还会再次叠加面板，报告采用的单层合成不能表示所有场景。
- backgroundPosition 的 contain 被输出为 background-position: contain，但 size 始终 cover；目前 UI 未暴露该参数，也应在共享 schema 中修正或限制。

修复：建立统一的主题层级描述（图片→图片遮罩→区域面板→文字），由预览、对比度计算和 adapter 输出共用。把减少透明度作为实际主题参数或明确标成「仅预览辅助」，首选前者。模糊只作用图片层，遮罩单独在其上。暂不支持的参数从 schema 移除，不假装支持。

验收：同一主题参数的预览和实际目标按组件逐项对比；面板 0/.5/1、blur 0/10、减少透明度开/关均有测试。共用 token 是必要条件，不是视觉一致的充分条件。

## R6 中优先级：目标检测失败后用户无恢复路径

定位：`src/renderer/App.tsx:117`、`:135`、`:513`；`src/main/ipc.ts:84`；`src/main/services/target-service.ts:12`。

当前只在挂载时发现目标，没有手动选择安装目录的主进程对话框/IPC，没有目标切换控件和重新扫描按钮。后端 extraRoots 仅为构造参数，用户无法使用；错误却建议手动选择。底部 ready 状态仍说「可直接应用」，与禁用原因冲突。

修复：增加「重新检测」「选择安装目录」及多候选选择；通过主进程目录对话框登记 targetId，不放开任意路径写入 IPC。显示具体未发现/读取失败/版本未验证/主题冲突原因，不合并成一句模糊提示；就绪文案由目标与对比度共同决定。保留安全禁用。

验收：初次无安装→手动选择；未知版本；多个安装；扫描异常→重试；目标升级后的刷新与应用预检。

## R7 高优先级：启动恢复扫描未接到实际启动流程

定位：`src/core/patch/recovery.ts:30`；`src/main/index.ts:46`。

scanPending 有函数、有测试，但在 src 中未发现主进程/服务的调用点。恢复检测不会仅因模块存在而执行；可能出现测试证明扫描函数可用、实际启动却跳过待恢复事务的情况。

修复：启动或首次取得实例锁时扫描本工具已登记事务，核对当前目标与备份，向 UI 输出明确的待恢复状态；needs_recovery 时阻止该实例继续 apply。对状态不明不自动覆盖，恢复动作需要明示确认。

验收：在 fixture 中提交阶段终止进程，启动全新 Electron 进程后看到恢复提示；不是同进程直接调用 scanPending 的单元式验证。

## R8 中优先级：零 E2E 和未完成真实闭环无法作为发布验收

定位：`package.json` test:e2e、`tests/e2e/README.md`、`docs/acceptance.md:23`、`:136`。

E2E 无测试但 --pass-with-no-tests 返回 0；文档诚实标了未实现，这是好的记录，但不等于功能已过。真实验收主要是 Node CLI 的一次应用，后续画面、换主题、恢复尚未完成；Node 不会暴露本次 Electron fs 语义 bug。

修复：发布门禁对零用例失败；接入实际 Electron 主进程/窗口测试，stdout 不回传不能作为没有办法验证的结论，可用受控测试驱动、日志文件和页面自动化。测试先用合成安装，打包版再做同样闭环。记录与执行代码的 build/version 对应，更新仍显示 pending 的 handoff 阶段。

## 推荐修复顺序与派发

1. 系统 agent：R1 物理归档 I/O + 真实 Electron fixture 测试。
2. 系统 agent：R2/R3/R7 原版证据、旧主题迁移、启动恢复接线；未经用户再次授权不在真实安装应用。
3. 主题 agent：R4/R5 统一层模型与状态对比度，复用本报告合成案例。
4. UI agent：R6 与普通导航淡化修复；不以启用按钮绕过后端预检。
5. QA：R8 打包 GUI 闭环；确认所有 P1 修复，再申请真实安装测试。

每项提交源码位置、实际测试命令/退出码、失败用例修复前后结果、剩余限制。不要把本轮「建议」写成「已经修复」。
