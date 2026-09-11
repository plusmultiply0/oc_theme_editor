# OpenCode 换肤后无法启动：原因、恢复和修复方案

取证日期：2026-09-11。实际项目根目录：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。

**本目录只交付诊断和恢复工具，尚未执行恢复，也未修改项目源码或 OpenCode 安装。** 先恢复使用，再修打包器；不要继续换肤，不要清空备份，不要先卸载/清理用户配置。

## 一、明确结论

不是图片大小或 CSS 让主进程崩溃，而是安装归档中的 **`node_modules/jsonfile/index.js` 已经成为另一版本文件的截断片段**。

实测该条目 2014 字节、103 行，结尾停在 `catch (err) {` 内部；只解析、不执行的 `vm.Script` 直接返回 `SyntaxError: Unexpected end of input`，与用户截图对应。主入口 `out/main/index.js` 在三个归档中 hash 一致，错误发生在加载依赖阶段，不是主入口本身被修改。

### 时间线与可恢复性

| 状态 | SHA256 前缀 | jsonfile 检查 | 处理建议 |
|---|---|---|---|
| 10:15 本地时间的首次操作前快照，文件名含 `02-15-40-576Z` | `1c53ca247269…` | 2014 字节、89 行，语法通过 | 本次推荐的恢复候选：旧定制状态，不是出厂原版 |
| 19:10 本地时间的最近操作前快照，文件名含 `11-10-09-850Z` | `aeab66d4a268…` | 已截断，语法失败 | **不能用于解决本次启动错误** |
| 当前安装（19:10 操作后） | `eea58d3ab237…` | 同一坏脚本，语法失败 | 保留取证后恢复较早快照 |

最近一次操作 ID：`op-20260911T110935948Z-k8dfu2`，记录状态为 applied。文件名的 Z 时间为 UTC，不要与 Windows 显示的北京时间混淆。

关键区别：最新一次换肤相对其前置备份只改变了三个主题资源；坏依赖在之前的 10:15 操作产物里已经存在。这次继续打包沿用了坏输入，重新计算了坏内容的完整性 hash，因此当前归档「自校验通过」不代表内容正确。

## 二、现在如何恢复

### 1. 先关闭应用

手动关闭截图里的错误窗口、OpenCode 和换肤助手。保存其他正在进行的工作。脚本不会强制结束进程，也不会替用户启动应用。

### 2. 先执行只读检查

在 PowerShell 中运行：

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher\handoff\startup-incident-2026-09-11'
.\Recover-OpenCode.ps1
```

默认不写文件。它检查当前 app.asar、恢复快照、OpenCode.exe 的固定 hash，并报告进程状态。若任何 hash 不符，说明取证后状态变化，**停止，不要改脚本里的 hash 来强行放行**。

本轮已验证脚本语法，并实际运行默认只读模式：三个 hash 通过，进程检查发现换肤助手尚未关闭。没有运行 -Apply，所以不声称恢复写入或恢复后的启动已测试通过。

### 3. 由用户明确决定后执行恢复

```powershell
.\Recover-OpenCode.ps1 -Apply
```

脚本还会要求确认。它会：

1. 再次确认进程退出、hash 未变化、空间充足。
2. 将已验证快照复制到安装 resources 目录中的唯一临时文件并校验。
3. 使用同目录 `System.IO.File.Replace` 替换 app.asar，同时把故障归档保存为 `app.asar.failed-<随机ID>.bak`。
4. 验证恢复后的 hash 与被保留故障包的 hash。

它**不修改** OpenCode.exe、app.asar.unpacked、聊天记录、API 配置、账号数据、用户图片以及现有换肤事务记录。不自动删除故障包，不执行重打包。`-Apply -WhatIf` 可查看意图但不执行替换。

脚本仅用于本次、此机器、此版本的状态，不能作为通用恢复器发布。遇到权限/执行策略拦截，停止并通过正常授权解决，不关闭安全保护。若提示文件占用，检查两款应用是否真的关闭，不要改成强制覆盖。

### 4. 恢复后人工确认

手动打开 OpenCode，确认不再弹主进程语法错误、聊天/配置仍在，再测试一个终端窗口。预期恢复为首次接管前的旧定制主题，不保留本次新背景。

恢复后暂时不要用当前换肤助手再次应用主题。此次是应急外部恢复，没有篡改过去 applied 事务；执行 agent 应另记恢复事件与实际新 hash，在修复后的工具里重新检测，不用旧 staged 操作继续提交。

若恢复后仍有错误，保留新的完整报错和故障包，不立即回退到较新的坏备份。继续检查 unpacked 文件/原生模块，或在另获授权后使用同渠道、同版本安装包修复应用文件，仍不要清理用户数据。

### 恢复候选的验证边界

- 选定快照完整 hash 匹配首次操作 beforeHash。
- 全部 packed 条目符合其头部完整性 hash；jsonfile 语法检查通过。
- 47 个 unpacked 条目中的 `OpenConsole.exe`，当前外部实体与较早快照头部记录有一处既存 hash 差异；该实体的修改时间为 2026-09-05，早于本次换肤，且不由本恢复脚本改动。**不能据此宣称整套安装已完全验证**；它不是本次 jsonfile 语法错误的解释，恢复后仍需验收终端。
- 本轮未启动真实 OpenCode，不能保证恢复后的 GUI/终端已验证通过。

## 三、精确技术根因：流式打包的 cwd 污染与错误去重

涉及当前已安装 `@electron/asar 4.3.0` 的这些实现：

- `node_modules/@electron/asar/lib/asar.js` 的 `createPackageFromStreams`：把逻辑归档路径交给 `Filesystem.insertFile`。
- `node_modules/@electron/asar/lib/filesystem.js` 的小文件快路径：对这个路径直接 `fs.readFileSync(p)`，相对于打包器进程的 cwd 读取，成功后不使用传入 stream 的内容计算 hash。
- 同文件的 `storeFileEntry`：按上述 hash 去重；两个内容本应不同的输入被误判为重复，共享 offset。

换肤助手 cwd 是开发项目，里面恰好也有同路径 `node_modules`，但与 OpenCode 归档内的依赖版本不一定相同。hash 来自开发项目，size/数据流却来自被打包文件，结果混用两套来源。

### 实际归档证据

较新备份 `aeab66…` 中以下条目被写为同一个 offset `53281426`，同一个 integrity hash，但 size 不同：

| 路径 | size |
|---|---|
| `node_modules/electron-window-state/node_modules/jsonfile/index.js` | 2838 |
| `node_modules/jsonfile/index.js` | 2014 |

因此第二个入口读取的是第一份 2838 字节脚本的前 2014 字节，恰好截在第 103 行。当前包继承了这一坏内容；同时另一非主题文件 `node_modules/semver/range.bnf` 也与较早快照不同。

### 已做隔离复现

`repro-stream-cwd.cjs` 构造两个流：a.js 应为 AAA，b.js 应为 BBB；cwd 中两个同名占位文件内容相同。实际输出中两者都指向 offset 0，b.js 被读取成 AAA。结果 `bugReproduced=true`，见 `stream-cwd-evidence.json`。

复现只在本目录生成一个极小 fixture 归档，不写用户安装。首次调试时绝对包目录 require 失败，已改为 createRequire 解析 package exports；不要把这个已解决的加载错误混淆为产品根因。

## 四、为什么工具显示成功

`src/core/patch/stage.ts` 在打包前比较的是**解包目录**，重打包后主要检查条目名与 unpacked 集合，并未验证每个输出文件与原始输入的字节一致。

`src/core/patch/commit.ts` 检查的是最终文件是否等于 staged 文件；若 staged 本来就损坏，照样可以 applied。后续版本还会为损坏输入重新生成正确的 hash，消除旧的内部 hash 不一致表象，不能凭「当前错误数为零」宣称修好了。

上一轮 fixture 使用简单的 console.log(1)，没有包含重复依赖路径、不同版本/长度、开发 cwd 同名文件场景，所以没触发本缺陷。

另一个独立缺陷：`src/core/patch/archive-io.ts` 的 insideWindow 在 fn 返回 Promise 后立即 finally 恢复 process.noAsar，异步期间不受保护；这是必须修的风险，**不是已证明导致本次 jsonfile 截断的直接原因**。

## 五、执行 agent 的修复任务

### F0：冻结坏版本

- 暂停用当前构建进行真实应用。保留现有安装、备份、事务、lock 和日志证据。
- 本轮恢复脚本须经用户明确同意执行，不能因看到本报告就擅自覆盖安装。
- 不复用较新坏备份，不从坏归档继续生成所谓已修复主题。

### F1：修复打包内容来源

优先方案：将打包隔离到专门的 Node 工作进程，所有输入使用可追踪的绝对物理路径；保证 hash、size、最终写入来自同一份字节。工作进程 cwd 设为对应解包根目录或无同名文件的隔离目录，并通过测试证明逻辑路径不会读取开发项目副本。

依赖方案：使用已验证修复的实现，或通过可版本化 patch 令 createPackageFromStreams 的完整性计算始终使用其 streamGenerator。必须锁定依赖、记录来源与 hash；不能只手改 node_modules 后声称可复现，也不要未经验证随机降级版本。

不要把主进程临时 process.chdir 当长期修复，它会影响并发任务和其他路径解析；同样不要在运行本工具归档模块的进程里长时间切换全局 noAsar。隔离工作进程能减少这两类全局状态影响。

### F2：增加提交前不可变文件校验（硬门禁）

1. 原始归档先验：头部/条目边界、完整性字段、packed/unpacked/link 状态；任何非主题输入异常拒绝继续。
2. 为原始归档所有非白名单条目建立 hash/size/元数据基线，不能只给已经解包且可能读错的结果做基线。
3. 重打包后用独立读取器检查**每一条**：非白名单内容完全一致、允许条目等于预期新内容、无新增非法条目、无缺失、unpacked 与链接语义保留。
4. 对相同 offset 的条目验证内容和长度关系，任何混用来源/异常共享都拒绝。
5. 校验失败不能进入 committing，不写安装；错误信息列出具体路径。
6. 哈希是内容身份而不是有效性证明。JS 解析和隔离启动冒烟可作附加检查，ESM/CJS 要按各自语义解析，不能用 CJS 包装器把正常 ESM 的 import 误判为损坏。

### F3：补齐回归测试

- 两个实际流内容不同、cwd 同名文件相同：不得错误去重（本目录 fixture）。
- 实际两个相同内容文件仍可安全去重，写出内容和 size 正确。
- 同名 jsonfile 依赖的两个版本，长度 2838 / 2014，回包后各自完整。
- 在仓库根、干净临时 cwd、真实 Electron、便携包目录下运行，结果一致。
- 故意修改一个非主题 JS；stage 必须拒绝，target hash 不变。
- 输入本来已坏（本次较新备份形态）；不能重算 hash 后当健康包放行。
- 异步 noAsar 测试跨越 await，并发异常后状态正确；仅测调用后开关为 false 不够。
- 备份列表不仅按时间排序，要有已知健康/未验证/已知故障标记；恢复不得默认选已知故障快照。

### F4：重新验收后再开放应用

先在合成安装和获准的资源副本上完成全部测试；再提交构建指纹、不可变条目报告、回归结果给用户。取得新的真实测试授权后才可应用，并由用户确认能启动、窗口正确、终端正常、恢复可用。

## 六、交付清单与复跑

- `Recover-OpenCode.ps1`：默认只读，显式 -Apply 才写入。只锁本次目标及候选。
- `archive-evidence.json`：当前包与两份备份的 hash/条目比较。
- `stream-cwd-evidence.json`：独立错误去重复现结果。
- `inspect-archives.cjs`：只读诊断，除本目录证据文件外不写入。
- `repro-stream-cwd.cjs`、`fixture-cwd/`：隔离复现，只写本目录的 fixture 归档/证据。
- `task_plan.md`、`findings.md`、`progress.md`：交接记录。

诊断脚本复跑需要 Node；恢复脚本本身不依赖 Node、不调用当前有缺陷的打包器。所有路径都是当前机器事故专用，不是通用发布脚本。恢复之后若再运行归档比较脚本，结果会随实际状态更新，原证据应先另存。
