# 工作记录

2026-09-12：使用planning-with-files技能分离计划、证据与执行状态。

- 完整读取技能并运行session-catchup，无需要恢复的输出。
- 核对项目路径、当前提交、package以及JFIF实现记录。
- 本轮只生成计划文件；没有修改业务源码、依赖、版本、安装或发布任何内容。
- RELEASE_ALPHA_PLAN.md包含A0–A8、测试矩阵、构建命令、GO/NO-GO和实施agent交接指令。

后续agent请在此追加每项执行结果，禁止把计划中的预期结果当作已通过。

## A0 固定基线与验收模板（2026-09-12，wb 执行）

现场（开工时实测）：

| 项 | 值 |
|---|---|
| 起点提交 | `8e6bd04`（tag `v0.1.0`） |
| 未提交改动 | 仅本计划目录未跟踪；源码无未提交改动 |
| package | version `0.1.0`、`private: true`、`build.directories.output` = `release7` |
| 既有 release 目录 | `release` ~ `release7`（全部过期；`release7` 曾为候选） |
| 候选版本名 | 待 A4 确认未占用后定（建议 `0.1.0-alpha.1`） |

产出：

- `handoff/alpha-release-evidence/`（私有证据目录）：只把 `README.md` 与
  `.gitignore` 入库，其余原始日志/截图/探针输出全部本地保留；
  摘要写进验收文档，不把本机路径带进仓库。
- `docs/alpha-acceptance.md`：按 A0 要求给出「候选版本/提交/包 hash/平台/执行人/时间/
  步骤/期望/实际/结论/证据」的表，初始**全部标「待执行」**，不预填成功。
- 明确 A5（真实安装）、A6（干净环境）、A8（GO/NO-GO）在授权前保持待执行；
  当前结论按计划口径记为 **NO-GO**（缺真机与干净环境证据）。

测试机器与 OpenCode 版本信息待填（不为了匹配白名单自行降级 OpenCode）。

## A3 核验可信度与 HTML 边界（2026-09-12，wb 执行）

新增 `src/core/theme/image-probe.ts`：把「文件头识别」与「完整解码」分成两件事，
解码走 `sharp(buf).raw().toBuffer()`（metadata 只读头部，不算解码）；
SVG 在这里也拒绝（本机 sharp 自带 SVG 解码器，只看解码成功会把矢量图判成可用背景）。

`tools/verify-real-install.cjs`：
- 图片检查拆成「文件头可识别」「完整解码成功」「不是多帧动图」；
  新增 `--expect-image-format`、`--expect-image-size`；失败即非 0 退出。
- 明确输出「实际格式 X（条目名后缀不代表内容）」——适配器固定写 .jpg，
  内容可能是 PNG/WebP，不能靠后缀推断。
- deep 模式把脚本解析写成「解析成功 N；跳过 X、不支持 Y（这两类未验证，不计入成功）」。

HTML 门禁（`verifyStagedHtml`）改为真实结构解析：
先按等长抹掉注释（伪标签不参与）、解析 `<link>` 属性（单双引号 / 无引号 / 大小写 /
多余空白）、要求本工具链接恰好一个且**完整落在 `<head>`…`</head>` 区间内**。
新增正反例 13 项：注释伪 link、单引号重复、大小写、无引号、去 ./、head 之前、
body 里、缺开头 head、标记冲突等。

### 过程中抓到的真实缺陷（已修）

`injectLink` 清除上一次注入时按「整行」删除：`lastIndexOf('\n', marker)` 找不到前导换行时
`lineStart` 退化为 0，于是**把文档开头到标记之间的内容整段删掉**。
真实安装的 `</head>` 自成一行，所以一直没暴露；单行/压缩过的 HTML 会被静默损坏，
而旧测试只数 link 数量，正好把它盖住。现在只精确定位并删除上一次注入的 `<link>` + 标记，
其余一个字符不动；新增「单行 / 多行 HTML 各连续注入三次」回归。

### 测试与门禁

| 命令 | 结果 |
|---|---|
| `npm run typecheck` / `npm run lint` | 0 / 0 |
| `npm run test:unit` + `test:integration` | 273 项通过（21 文件） |
| `npm run test:e2e` | 见 A4 记录 |
| 新增用例 | `tests/unit/image-probe.test.ts`（8）、`tests/integration/verify-real-install.test.ts`（4）、`stage-idempotence` 扩到 20 |

真机只读核验（当前安装）：背景 jpeg 1000×714、pages=1，HTML 链接唯一，
CSS 为 html:root + stronger rgba + 外壳规则。**未写入真实安装**。

## A4 全量回归与候选包冻结（2026-09-12，wb 执行）

版本确认为 **`0.1.0-alpha.1`**（`v0.1.0-alpha.1` 未被占用；package.json 与
package-lock.json 同步，`private: true` 保留 —— 发布桌面程序无需解除 npm 私有标记）。
输出目录改用**产品名 + 版本**：`candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1/win-unpacked`，
不再让用户理解 release7/release8；未覆盖任何被占用的旧目录。

门禁链（`bash tools/release-gate.sh`，任一步非 0 即停）：

| 步骤 | 退出码 | 结果 | 耗时 |
|---|---|---|---|
| typecheck | 0 | 通过 | 12s |
| lint | 0 | 通过 | 11s |
| test:unit | 0 | **135 项（9 文件）** | 12s |
| test:integration | 0 | **138 项（12 文件）** | 27s |
| build | 0 | 通过 | 25s |
| test:e2e | 0 | 16 项 | 42s |
| test:e2e:electron | 0 | 35 项 | 12s |
| audit | 0 | FAIL 0 / WARN 0 | 8s |
| dist | 0 | 候选包产出 | — |
| verify:package | 0 | 28 项 0 失败（965 条目） | 8s |

新增 `tools/release-gate.sh`：把整条链固化下来。原因写进脚本头 —— 
`npm run verify` 不含 `test:e2e:electron` / `audit` / `dist` / `verify:package`，
发布验收不能只跑 verify 就宣称全绿。

包内抽查（在 asar 内逐项读取确认，不是看目录名）：
- `out/main/services/image-store.js` 含 `readCapped` / `contentHash` / `IMAGE_CONTENT_MISMATCH`；
- `out/main/services/operation-service.js` **不含** `record.imagePath`、含 `contentHash`；
- `out/shared/image-formats.js` 含 `jfif` 与 `'jpe'`；
- `out/core/theme/image-probe.js` 含 `headerFormat` / `decoded`。

候选指纹（A5/A6 必须测同一份）：

| 文件 | 大小 | SHA256 |
|---|---|---|
| zip（整 win-unpacked，82 条目，完整性校验通过） | 131 MB | `f41354a398c732a0e58cf84231cd77e4b14aafcd4d32f578c59b4959e1d9b08a` |
| OpenCodeThemeSwitcher.exe | 193.3 MB | `99c02d6796bc2df00d7b16f8135ae9052b11bfb08384ee502b5044961756f46f` |
| resources/app.asar | 17.7 MB | `3381173d21ac8f45039a42ade17a76611dde3a949d040a5524b713e9f5f4ac6f` |

校验和清单：`candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.sha256.txt`（本地，随包分发）。
包与哈希已冻结；源码或包有任何改动，本表作废并需重跑门禁。

### 仍未执行（需授权 / 需外部环境）

- **A5 真实安装闭环**：需 jc 授权后才能动真实 OpenCode。当前只做只读核验
  （背景 jpeg 1000×714、HTML 链接唯一、CSS 标记齐备）。注意：真机归档已不是
  今天上午接触过的那个（背景 4.9MB 壁纸 → 现在 84KB 的 jpeg），执行 A5 前要重新记录现场。
- **A6 干净环境**：需要一台非开发环境机器或全新 VM。
- **A7/A8**：公开发布与 GO/NO-GO 由 jc 决定；当前按计划口径为 **NO-GO**（缺 A5/A6 证据）。

## A7 发布材料整理与公开范围检查（2026-09-12，wb 整理；最终确认留给 jc）

**只做检查与清单**：没有删除任何文件、没有重写 Git 历史、没有推送远端、没有上传 zip。

产出：
- `docs/release-notes-0.1.0-alpha.1.md`：面向使用者的发布说明 —— 非官方 / Alpha / 未签名声明、
  兼容范围表（只声称 Windows x64 + OpenCode 1.18.29 + 静态 PNG/JPEG/WebP）、
  五步使用（含「完全退出」与重启确认）、恢复三入口的各自含义（明确不承诺出厂）、
  已知限制（含 .jpg 命名技术债与未做真机视觉走查）、反馈模板。
- `handoff/alpha-release-plan-2026-09-12/publish-scope.md`：公开范围与脱敏清单。

检查结论（实测，不是印象）：
- **二进制包可以对外发**：包内私有路径与凭证 0 命中；归档不含 src/tests/handoff/docs。
- **源码仓库目前不宜直接公开**：`git grep` 命中 **10 个跟踪文件**含本机绝对路径
  （8 个在 `handoff/`、3 个在 `tools/`）；另有 5 张诊断截图；49 个提交的作者邮箱为个人邮箱。
  未发现私人壁纸、凭证、聊天内容或用户目录清单；旧构建目录未入库。
- 元信息缺口：`package.json` 声明 MIT 但**没有 LICENSE 文件**；author / repository 未设置。

明确不做（需 jc 授权）：删除私人证据、从历史移除 handoff、重写历史、推送远端、
公开仓库、上传 zip、对外发文、购买签名。

A8 当前结论仍为 **NO-GO**（A5/A6 无证据；演示素材未拍摄；LICENSE 缺口待定）。

## 候选包重封：A4 之后发现并修复三个打包缺陷（2026-09-13，wb 执行）

起因：APNG 修复提交后按计划重跑门禁重封候选包，`npm run dist` **三次都在同一位置挂死**
（Electron 运行时解包完成、复制完 shell 后无限等待，CPU 0、无网络、DEBUG 日志无新行）。
顺着查下去，发现挂死只是表象，真正的坏消息是 **A4 冻结那个包本身跑不起来**。

### 根因链

1. 某个外部进程长期占用 `win-unpacked/resources/app.asar`（改名/删除均被拒）。
2. electron-builder 收尾要「清旧输出目录 → 把 .tmp 改名顶上」，
   删掉了未加锁的 `app.asar.unpacked` 与大量 `locales/*.pak`，
   随后卡在加锁的 `app.asar` 上 → 静默等待 → 三次挂死 → 被杀后留下删一半的产物。

### 三个缺陷（都是「只查结构与清单」查不出来的）

| # | 缺陷 | 发现方式 | 修复 |
|---|---|---|---|
| 1 | `app.asar.unpacked` 目录整体缺失：`@img/sharp-win32-x64` 的 9 个文件在归档头标为 unpacked，磁盘上没有 → 运行时 `require('sharp')` 失败 | `ELECTRON_RUN_AS_NODE=1` 在包内 require sharp（报 "Could not load the sharp module"）；`@electron/asar` 提取时精确报出缺哪 9 个文件 | 从本机 `node_modules` 补回原生模块，重封时带 `unpack` 规则 |
| 2 | 运行期依赖 `@img/colour` 根本没进包 | 补完 #1 后复测报 `Cannot find module '@img/colour'` | 补入并重封 |
| 3 | 39 个 `locales/*.pak` 被删（16/55） | 与 `node_modules/electron/dist` 逐文件比对 | 补齐缺失的 40 个文件（含 zh-CN） |

重封方式：从 A4 归档提取 → 换入本次构建的 `out/`（含 APNG 修复）→ 补齐依赖 →
用 `@electron/asar` 带 unpack 规则重新封包 → 覆盖进候选目录。exe 未动（哈希不变）。

### 一个差点导致误判的环境陷阱

本机 shell **全局带 `ELECTRON_RUN_AS_NODE=1`**：从这里启动任何 Electron 应用都会退化成
Node 模式 —— 不建窗口、无脚本时静默退出 0、未知参数报 "bad option"。
我一度据此判定「打包 exe 坏了」，还用最小 hello 应用复现过（同样被污染）。
清掉该变量后打包应用正常启动。已写进 `tools/smoke-packaged.ts` 的注释与实现。

### 新增/加固的工具

- `tools/smoke-packaged.ts`：用 Playwright 启动打包 exe 冒烟（显式剥离 ELECTRON_RUN_AS_NODE）。
  本机沙箱下 Playwright 附着报 "Target crashed"（渲染进程），视觉验收仍留 A5。
- `tools/verify-package.cjs` 补两项：**unpacked 标记的文件必须真的存在于磁盘**、
  **包内 sharp 必须能加载并产出 PNG**。校验项 28 → **30**。

### 重新冻结的指纹（A5/A6 必须用这一份）

| 文件 | 大小 | SHA256 |
|---|---|---|
| zip（131 MB，84 条目，完整性 OK，含 zh-CN.pak 与 11 个 unpacked 条目） | 131 MB | `9212617177fa9bb7c8f46b5bd313f7c76484f26e2c646d5e9e9de598c7e81c6c` |
| OpenCodeThemeSwitcher.exe（未变） | 193.3 MB | `99c02d6796bc2df00d7b16f8135ae9052b11bfb08384ee502b5044961756f46f` |
| resources/app.asar | 17.0 MB | `7ca56cc52318ce49193fe32100e195a4885aaac7681660846a180daab4efdce8` |

本地目录名为 `win-unpacked.new`（旧 `win-unpacked` 里被占用的 app.asar 无法删除），**分发以 zip 为准**。

### 仍未执行（需授权 / 需外部环境）

- **A5**：真实 OpenCode 上的应用 / 换图 / 恢复闭环 + 视觉走查（真机验收，需 jc 授权）。
- **A6**：干净非开发环境验证（需另一台机器或新 VM）。
- **A7 剩余**：演示素材未拍摄；`LICENSE` 文件缺失（声明 MIT 却无文件）待 jc 定。
- **A8**：当前结论仍为 **NO-GO**（缺 A5/A6 证据）。
