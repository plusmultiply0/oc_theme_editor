# 2026-09-17 复审：问题与可执行解决方案

源码基线：`8b3b8f88f91df20ed2438388bd7270b9b7532e69`；对比上一轮 `85f6707`。

实际项目目录：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。消息中的 `OpenCode\_Theme\_Switcher` 嵌套路径不存在，沿用实际项目，不另建第二份项目。

## 一、结论：发布链已通过，剩余工作应收敛

**相较上一轮，已有实质改善。最新候选的正式只读发布核验通过，不应继续说“卡在 ZIP 校验”。** 本次未发现已证实会让当前 OpenCode 安装损坏的新业务缺陷。但当前发布文档指向旧包，默认启动验证覆盖仍有缺口，不能直接把“门禁绿”理解为对外验收全部完成。

建议：先解决下面 F1 的交付指引错配和 F2/F3 的冒烟覆盖，再完成经授权的真实窗口走查；满足后可进入限定版本、小范围 Alpha。F4 属于校验器健壮性改进，当前候选并未被证明损坏，不能仅因人工构造的畸形 ZIP 就宣称正常用户不可用。

本次仅审查、静态检查、隔离复现和写报告。未修业务代码、未重打包、未启动 GUI、未写真实安装、未上传或发布。

## 二、本次验证与已修复项

| 检查 | 本次结果 | 边界 |
|---|---|---|
| `tsc --noEmit -p tsconfig.json` | 退出 0 | 类型检查 |
| `eslint .` | 退出 0 | 静态检查 |
| ZIP/worker/smoke/encoding 四个单元文件 | **80/80 通过，0 skip** | 见 unit.summary.json；不是完整测试套件 |
| 当前候选发布级只读核验 | **18 项，0 失败，RELEASE_GREEN** | 包含资格与回执绑定；未重跑历史构建步骤 |
| 上轮关键反例回归 | 按修复后预期工作 | 见 reproduction-results.json |

已确认不再重复报错的项目：Windows 反斜杠目录正确识别；损坏 DEFLATE 被拒绝；混合分隔符重复文件被拒绝；worker 成功消息后 exit1、kill 抛错均返回失败。R6 已改为等待目标路径出现，Playwright 首参回归也已有修复。R5 显式 no-sandbox 已从 Windows 正式冒烟参数中移除，但下面的覆盖问题仍应收尾。

通过本次核验的候选身份：

- buildId：`20260916114818-8b3b8f8-f4e1c6`
- manifest：`candidate-20260916114818-8b3b8f8-f4e1c6/candidate-manifest.json`（schema/3）
- ZIP：`candidate-20260916114818-8b3b8f8-f4e1c6.zip`
- ZIP SHA256：`1df4c69765ee91e92b8bde46a2bb331aa45c63f3de0376423be83caef070c739`
- build-record 中 12 项必检均 passed；releaseEligible=true；已有 release-receipt/1。

以上候选是本轮检查对象，不代表本次已获发布授权。

## 三、问题、修复步骤、验收条件

### F1 / P1：面向使用者的“当前候选”仍指向旧手工重封包

定位：`docs/release-checklist.md:6–24`、`docs/alpha-acceptance.md:19–24`；README 已知限制链接到这两处。

事实：交付清单明确要求分发 `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.zip`，SHA 为 `921261...`；验收页标识还是提交 `871703...`、buildId `manual-repack-20260912`、schema/1。它们不是刚通过核验的 `8b3b8f8` 新包。旧测试数量和旧命令也仍以“当前”呈现。

影响：人按照 README 的交付路径会拿错包，把最新源码修复和验证结论错误套给旧二进制。旧包的 manifest 作为历史记录本身没错，错的是仍被选为当前分发入口。

执行方案：

1. 将旧候选章节移到带日期/commit/buildId 的历史区，显式标注“不作为本次发布候选”。不篡改旧 manifest、hash、receipt。
2. 当前入口从选定新候选 manifest 生成或核对 buildId、源码提交、ZIP 相对路径及 SHA256，不能只按相同版本号挑包。
3. 为新候选新建验收行；只迁移有证据且适用的结果，不把旧 A5/A6 的状态预填为新候选成功。README 保持唯一当前入口。
4. 更新当前发布命令说明。旧历史命令保留历史标签；使用仓库现有 release-build/release-gate 的显式 buildId/manifest/candidate 参数，禁止回落根目录旧 manifest。

验收：从 README 出发能唯一找到所选 buildId，文档 ZIP/hash 与 manifest 和磁盘核验一致；旧包不能出现在“当前请分发”段落；新候选没有证据的真机项目仍为待执行。若后续修工具后重建，则用新 buildId 替换当前入口，不强行固定为本报告候选。

### F2 / P2：冒烟禁用 GPU 后仍被描述为默认启动验收

定位：`tools/smoke-packaged.cjs:61–85,168–179,208`。

事实：DEFAULT_ARGS 包含 `--disable-gpu`、`--disable-gpu-compositing`、`--disable-software-rasterizer`、`--disable-dev-shm-usage`。资格函数只排除 no-sandbox/in-process-gpu，仍将这组参数认定为可发布。脚本注释及退出码说明却称默认配置/双击等价。

影响：禁 GPU 可能掩盖默认渲染路径问题。这不等于当前应用确实有 GPU 故障，而是目前这条绿色证据不能证明未加这些参数时也正常。

执行方案：正式产品启动冒烟默认不加 GPU workaround（应用自有 args 为空）；如确需保留兼容诊断，将其作为单独模式并明确不替代正常启动验收。记录实际进程参数、exe 身份、平台和运行时 webPreferences，而不只打印调用前的数组。若正常环境不可用，标注“未验证”，不要降级后刷绿。

验收：正常配置独立通过；GPU 诊断通过不能覆盖正常配置失败。测试应断言传给 launch 的正式参数配置，不只测试资格纯函数。

**撤销一个中途疑点：** 本机 playwright-core 1.63.0 的 `lib/coreBundle.js:44248–44250` 只在 Linux 分支默认追加 no-sandbox。Windows 不命中该逻辑，因此不能据此说本候选仍关闭沙箱。官方文档虽写 chromiumSandbox 默认 false，但必须结合平台实现判断。若工具未来迁移 Linux，可显式设置 `chromiumSandbox:true`；这不是当前 Windows 缺陷的证据。参考：[Playwright Electron launch](https://playwright.dev/docs/api/class-electron#electron-launch-option-chromium-sandbox)。

### F3 / P2：冒烟错误监听启动偏晚，且界面读取不在同一就绪状态

定位：`tools/smoke-packaged.cjs:119–149,208–210`。

事实：先完成 `electron.launch()`、`firstWindow()`，再进入 observe 注册 console/pageerror/crash；此前已发出的事件不会重放。observe 又先取 body 文本，再读取标题/按钮，缺少明确的应用就绪边界。

本轮复现：假页面在 observe 之前发出 pageerror，随后 DOM 满足控件条件，judge 返回空问题；在 observe 之后发出的同类错误能被识别。说明存在监听窗口缺口。**这是事件级模拟，不是本轮真实 GUI 已发生启动异常的证据。** body 先于异步渲染取样的风险为静态观察，未单独用真实页面重放。

执行方案：

1. 在受控测试启动入口、首次 renderer 脚本执行前建立错误记录通道；可在主进程创建 webContents 时注册诊断监听/首屏失败事件，或采用已验证能在页面脚本前注入的自动化机制。仅把 observe 中注册位置上移一行并不能保证覆盖启动过程。
2. 等待明确的 UI 就绪条件（标题、主控件、业务初始化状态），使用有界自动重试；就绪后一次收集界面快照。
3. 错误记录持续到验证结束/关闭确认；发现启动错误或崩溃必须失败。若无法覆盖初始阶段，报告诚实说明缺口，并补正常人工启动验收。
4. 监听只注册一次，负例自检复用同一个记录器，避免多次 observe 累积监听。

验收：新增“初始化早期抛错但仍渲染部分 UI”必须失败；正常延迟渲染通过；始终不就绪超时失败；晚到错误失败。不能靠固定 sleep 或重跑至绿解决。

### F4 / P2：ZIP 结构边界与隐式目录冲突检查尚不完整

定位：`tools/verify-release.cjs:458–499,526–541,565–576`。

已修复的内容解压/hash 校验有效，但共享解析器还会漏掉下列构造输入：

| 本轮夹具 | 当前返回 | 证据边界 |
|---|---|---|
| 最后一条中央目录声明 commentLen=65535，实际无注释 | deep 和目录比较都无问题 | 中央目录变长区域没有完整边界校验 |
| flags bit3=1、本地大小/CRC 零占位，但没有 data descriptor | 两检查都无问题 | 跳过本地字段比对后未核对描述符结构 |
| 文件 `a` 与文件 `A/file.txt` | deep 无问题 | 隐式父目录冲突使用区分大小写的集合 |

最后一条只证明 deep 校验缺口，不代表 Windows 目录比较或整个发布门禁能通过；Windows 普通目录无法同时合法保存这两个文件。当前真实候选已通过只读校验，没有证据表明包含这些畸形结构。这里没有解压写磁盘，不能夸大成已证实的任意文件写入漏洞。

执行方案：

1. 验证 EOCD 的磁盘/条目计数/中央目录长度与范围；拒绝不支持的分卷/ZIP64。每条 name/extra/comment 变长字段都必须完整落在中央目录范围内，遍历结束位置与声明一致。
2. bit3 开启时验证 descriptor 的存在、范围、CRC、压缩/解压大小，兼容有/无签名的合法形式；本地零占位合法，不要倒退成逐字比较所有本地字段。
3. 显式路径、隐式父目录统一使用 Windows 冲突 key，检测文件和父目录的大小写别名冲突；校验目录条目时也不直接略过异常元信息。
4. 新用例直接调用生产 parseZip/deepVerifyZip/checkZipMatchesDir。保留合法 Compress-Archive ZIP、显式/隐式目录、空普通文件、store/DEFLATE 正例。

验收：上述坏输入被拒绝；当前正常候选或同构合法夹具仍通过。不要重写整个门禁架构，不要为测试故意破坏真实候选 ZIP。

## 四、仍需人工确认的验收项（不当作已复现代码 bug）

README 与 alpha-acceptance 仍明确真实窗口走查未完成。本轮没有取得新候选对应的 OpenCode 完整应用→重启→视觉检查→恢复证据。

在单独授权后，针对当前受支持版本、所选 buildId，记录安装/目标版本和相关 hash，走：

1. 正常启动换肤助手，不带 GPU/沙箱 workaround。
2. 导入 JPEG/JFIF、PNG、WebP；记录预览、格式识别与应用状态。
3. 用户确认后应用，完全退出并重启 OpenCode；检查会话、侧栏、代码、输入、菜单以及滚动时背景。
4. 恢复健康快照并再次重启，核对恢复结果；无出厂指纹不宣称恢复出厂原版。

不默认安装旧版本、不写真实安装、不关闭防护来完成本轮检查。若用户选择先做内测，应在分发说明中列明未完成的环境/视觉项，不能宣传全部完成。

## 五、给下一位 agent 的最小实施顺序

1. 核对 HEAD、工作树、候选身份；先解决 F1 文档入口错配，保留旧证据。
2. 修 F2/F3（同一次冒烟工具改动），为参数和启动错误时序补自动测试；正常安全配置下验收。
3. 单独修 F4 ZIP 边界并加回归，不动应用业务层。
4. 运行 typecheck、lint、相关单元与既有完整测试。冻结修复提交后经正式 release:build 生成新候选/receipt，不回写旧记录。不把旧候选的 green 复制给新构建。
5. 更新唯一当前候选入口、按授权补人工验收，最后由用户决定分发范围及是否公开。公开仓库/上传包不包含在本次请求中。

## 六、复现与核验命令

在项目根目录：

```powershell
node .\handoff\review-2026-09-17\reproduce.cjs
node .\handoff\review-2026-09-17\checks.cjs 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher' unit
node .\handoff\review-2026-09-17\checks.cjs 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher' verify
```

reproduce 复用仓库中上轮的夹具生成器，仅在自身目录新增唯一 fixtures-*，不解压、不启动 GUI/worker。checks 的 verify 显式绑定本报告候选，仅做读取；unit 有 120 秒超时。checks 进程完成不等于检查通过，要看生成的 summary.status、测试计数与原始日志；后续若 HEAD/候选变化，应更新核验目标而不是绕过绑定。

主要证据：`unit.summary.json`、`unit.stdout.log`、`verify.summary.json`、`verify.stdout.log`、`reproduction-results.json`、`validation.md`。报告定位以本次基线为准。规划文件保留过程中的更正，最终结论以本文件为准。
