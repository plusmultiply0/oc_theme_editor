# Alpha 验收记录

依据 `handoff/alpha-release-plan-2026-09-12/RELEASE_ALPHA_PLAN.md`。

**规则**：每项必须能定位到「候选版本 + 提交 + 包 hash + 平台 + 执行人 + 时间」。
初始状态一律 `待执行`，**不得预填成功**；未执行就是未执行。
A5（真实安装）、A6（干净环境）、A8（GO/NO-GO）需要用户授权，授权前保持 `待执行`。

原始日志、截图与探针输出放在 `handoff/alpha-release-evidence/`（私有，不入库），
本文件只写摘要。

---

## 0. 候选标识

### 0.1 当前候选

| 项 | 值 |
|---|---|
| 候选版本 | **`0.1.0-alpha.3`**（package.json / package-lock.json 已同步；`private: true` 保留） |
| buildId | **`20260921124125-bd8c2d5-0c200b`** |
| 提交（来源） | `bd8c2d50802aceab189b41ded457101e0ed9ff28`「chore(release): alpha.3 发布准备——版本号 0.1.0-alpha.3 + 发布说明草案」 |
| 候选身份登记 | `candidate-20260921124125-bd8c2d5-0c200b/candidate-manifest.json`（schema `candidate-manifest/3`，`packMethod: electron-builder`，`reproducibleBuild: true`） |
| 完成回执 | `candidate-20260921124125-bd8c2d5-0c200b/release-receipt.json`（schema `release-receipt/1`，绑定同一 buildId 与源码提交） |
| 包目录 | `candidate-20260921124125-bd8c2d5-0c200b/win-unpacked` |
| 平台 | Windows x64（仅开发机；未在 Windows 11 上实测）。**构建执行方式**：本轮由 agent 会话运行 `npm run release:build` 全链通过（含 `test:e2e:electron` 3.7s 与 `smoke:gui` 26.4s 空参数）——§8.1「agent 会话 smoke 必崩」按 2026-09-21 实况修订为**会话环境相关**，见第 5.0 节 |
| 目标 | OpenCode Desktop 1.18.29（白名单完整验证）；非白名单版本自本轮起可经结构验证通道应用（真机 1.18.31 实测结构兼容） |
| 签名 | 未签名（如实声明） |
| zip / exe / app.asar SHA256 | 见 `docs/release-checklist.md` 第 1 节的机器可核对块（**不在本文件重复抄写**） |

哈希**只在一处维护**：`docs/release-checklist.md` 的候选块由
`tools/doc-candidate-entry.cjs` 从 manifest 加磁盘实算生成并可机器核对。
本文件重复抄写会重演「重封后只更新一处」的漂移，因此只登记身份、不抄哈希。

### 0.2 历史候选（保留，不作为当前候选）

`manual-repack-20260912`（源 `871703da2bd775a2af1a9eb464b813a57e6fb8ae`，
schema `candidate-manifest/1`，手工重封，**不可重复构建**）早于 R1–R6 / S1–S6
全部源码修复。其 manifest、hash、receipt 原样保留、未改写，
身份细节与哈希见 `docs/release-checklist.md` 第 2.1 节。

**本文件第 5 节以下的 A4/A7 等既有结论，均属该历史候选**；
它们不能当作 0.1 节新候选的成功证据。

追加（2026-09-19）：`20260916114818-8b3b8f8-f4e1c6`（源 `8b3b8f8`）为**已发布的
`v0.1.0-alpha.1` 候选**（tag + 私有仓库 Release，见第 9.4 节），自 0.1.0-alpha.2
候选登记后不再是当前候选；其 manifest、build-record、receipt 与哈希原样保留。
本文件第 5–9 节中凡引用该 buildId 的记录均为历史事实，不随本轮改写。

追加（2026-09-21）：`20260919055321-f8bb4fb-e00e50`（源 `f8bb4fb`）为**已发布的
`v0.1.0-alpha.2` 候选**（tag + 私有仓库 Release，见第 9.5 节），自 0.1.0-alpha.3
候选登记后不再是当前候选；其 manifest、build-record、receipt 与哈希原样保留。
第 5.0（原文）与 9.5 节的记录为历史事实，不随本轮改写。

## 1. 基线（A0）

| 项 | 值 | 状态 |
|---|---|---|
| 起点提交 | `8e6bd04`（tag `v0.1.0`） | 已记录 |
| 开工时未提交改动 | 仅本计划目录未跟踪；无源码未提交改动 | 已记录 |
| package 版本 / private / 输出目录 | `0.1.0` / `true` / `release7` | 已记录 |
| 既有 release 目录 | `release` ~ `release7`（全部过期，仅 `release7` 曾作候选） | 已记录 |
| 测试机器 | 待填（Windows 版本、架构、是否有第三方安全软件） | 待执行 |
| OpenCode 版本 | 待填（**不为了匹配白名单而自行降级**） | 待执行 |

## 2. A1 文档与 UI 一致性

**2026-09-18 本机人工核对完成，十项全部通过**。逐项核对方式与结果见
`handoff/alpha-release-evidence/a1a2-manual-20260918.md`（私有不入库，下称「A1/A2 核对文件」）。

| 验收项 | 期望 | 实际 | 结论 | 证据 |
|---|---|---|---|---|
| 恢复入口命名 | README 与界面一致：上一主题 / 首次接管快照 / 有出厂指纹证据时的原版 | RestorePanel 三入口与 README §恢复逐条一致，e2e 有断言锁定 | **通过** | A1/A2 核对文件 #1 |
| 无「首次接管=出厂样子」表述 | 全文检索无此说法 | 全库 grep 无冒充表述，均为「不承诺出厂」 | **通过** | #2 |
| 卸载/撤销说明 | 明确「先恢复适用且健康的快照；无出厂证据不承诺回到出厂」 | README:151-152 措辞符合 | **通过** | #3 |
| 磁盘空间文案 | 与 `precheck.requiredBytes`（归档×4 + 64MiB）一致 | 代码即 ×4+64MiB，UI 动态显示同值，无写死过期数字 | **通过** | #4 |
| 支持范围文案 | 与 `src/shared/image-formats.ts` 派生一致（含 .jfif/.jpe） | 一致；**修正一处**：README:50「最大 20 MB」→「20 MiB」（与代码及同文件限制节统一） | **通过（含修正）** | #5 |
| 发布清单时效 | 只有一套当前候选结果，旧构建移入标注日期的历史区 | checklist §1/§2 结构符合；F1 机器核对 `DOC_ENTRY_OK` 当日复跑 | **通过** | #6 |
| 无绝对保证措辞 | 无「其余什么都不用准备」「重启一定生效」类表述 | 仅技术语境的「保证」，无用户侧绝对承诺 | **通过** | #7 |
| 阶段区分 | 明确区分模拟预览 / 资源已写入 / 真实窗口验收通过 | README「三种看到效果」表逐项定义清晰 | **通过** | #8 |
| 未签名如实说明 | 不引导关闭安全软件，不把拦截一概称为误报 | README:183-184 如实声明且明示不要关防护 | **通过** | #9 |
| 失败反馈指引 | 版本、错误码、操作时间、脱敏日志；不默认收集图片/聊天/完整路径 | README 与 release-notes 反馈五项 + 日志仅路径与哈希 | **通过** | #10 |

## 3. A2 图片内容固定

**2026-09-18 本机人工核对完成**：行为探针在合成运行根（`%TEMP%\a2probe-*`）走真实
ImageStore 编译产物，**不触碰真机安装与真实运行数据目录**，11/11 断言通过；
逐项见 A1/A2 核对文件（私有不入库）。

| 验收项 | 期望 | 实际 | 结论 | 证据 |
|---|---|---|---|---|
| 导入后替换源图 | 使用已确认私有副本；预览与应用一致 | 副本落 `content/<imageId>.jpg`，哈希==源图 | **通过** | A1/A2 核对文件 A2#1 |
| 导入后删除源图 | 不影响已确认副本，仍可应用 | 删源后 `readBytes` 成功且哈希一致 | **通过** | A2#2 |
| 私有副本被篡改/丢失 | 拒绝应用，提示重新导入，安装 hash 不变 | 篡改 1 字节即 `IMAGE_CONTENT_MISMATCH` 拒绝 | **通过** | A2#3 |
| 应用前校验 | 用同一份 Buffer 核对 hash/体积/格式后直接写入，不二次读文件 | stage 只经 `readBytes(imageId)`；编译产物无 `record.imagePath/sourcePath` 读取；apply 前 staged==current 复核 | **通过** | A2#4 |
| 老准备记录无 contentHash | 失效并要求重新准备 | 构造无 contentHash 记录被拒，指向重新准备 | **通过** | A2#5 |
| 动画图片 | 明确拒绝（本轮不做首帧静态化） | APNG 与动画 WebP 均 `IMAGE_ANIMATED` 拒绝 | **通过** | A2#6 |
| 解码限制一致 | thumbnail / preview / 分析使用同一体积/像素/超时限制 | 三路径统一 `readCapped + probeImageBytes` 受限机制；数值按用途分级（20 MiB/40 MP vs 缩略图 2 MiB/1 MP）为 R4/S4 有意设计——「同一限制」按「同一受限机制」核 | **通过（机制一致，数值分级为有意）** | A2#7 |
| 失败导入清理 | 只清自己产生的副本，不递归删用户目录 | 失败后用户对照文件仍在、无多余副本 | **通过** | A2#8 |

## 4. A3 核验可信度与 HTML 边界

| 验收项 | 期望 | 实际 | 结论 | 证据 |
|---|---|---|---|---|
| 文件头识别与完整解码分开 | 两个独立检查项，名称如实 | 已拆成「文件头可识别」「完整解码成功」两项 | **通过** | `tools/verify-real-install.cjs` 输出 |
| 归档内图片完整解码 | 校验实际格式/尺寸/帧数/内容 hash | 真机当前背景：jpeg 1000×714，pages=1，哈希可核对 | **通过**（合成归档 + 真机只读） | tests/integration/verify-real-install.test.ts；详见下节证据 |
| 损坏样本退出码非 0 | 截断、错尺寸、hash 不符都失败 | 残图（只剩文件头）、期望哈希不符、期望尺寸不符三种都返回非 0 | **通过** | tests/unit/image-probe.test.ts（8 项）、tests/integration/verify-real-install.test.ts（4 项） |
| 资源项名称不靠 .jpg 推断 | 由适配器与图片元信息取得 | 脚本按解码器报告的实际格式输出，并显式提示「条目名后缀不代表内容」 | **通过** | 脚本输出「实际格式 jpeg」 |
| 脚本解析计数如实 | 成功/跳过/不支持分开报，不混算 | deep 模式下输出「解析成功 N；跳过 X、不支持 Y（这两类**未验证**，不计入成功）」 | **通过** | 脚本输出 |
| HTML 门禁正反例 | head 前/后 link、注释伪标签、单双引号、大小写、重复 link | 13 项正反例全部符合预期（含注释伪标签、单双引号、大小写、无引号、head 前/后、缺开头 head、标记冲突） | **通过** | `tests/integration/stage-idempotence.test.ts` 20 项 |
| 未削弱既有安全校验 | ASAR 非白名单字节、offset/完整性、unpacked、备份健康、原子替换不变 | 未改动这些门禁；相关用例全部保持通过（archive-verify / pack-integrity / transaction / main-recovery / main-services） | **通过** | 全量单元+集成 273 项 |

### A3 证据摘要（2026-09-12）

- 新增 `src/core/theme/image-probe.ts`：把「文件头识别」与「完整解码」彻底分开，
  解码用 `sharp(...).raw().toBuffer()`（metadata 成功不算解码）；
  SVG 在此也明确拒绝 —— 本机 sharp 自带 SVG 解码器，只看「解码成功」会把矢量图放进白名单。
- `tools/verify-real-install.cjs` 改为：条目名不再用来推断格式；
  新增 `--expect-image-format` / `--expect-image-size`；多帧判失败；
  deep 模式把「跳过 / 不支持」显式标注为**未验证**。
- **过程中抓到并修掉一个真实缺陷**：`injectLink` 清除上次注入时按「整行」删除，
  当注入行没有前导换行时会**把文档开头到标记之间的内容全部删掉**。
  真实安装的 `</head>` 自成一行所以没暴露，单行 HTML 会静默损坏；
  旧测试只数 link 数量，因此一直没发现。现在只精确定位并删除上一次注入的
  `<link>` + 标记，并用「单行 / 多行 HTML 各连续注入三次」回归锁住。

## 5. A4 全量回归与候选冻结

### 5.0 当前候选（`0.1.0-alpha.3`，buildId `20260921124125-bd8c2d5-0c200b`）

构建于 2026-09-21，由 **agent 会话**运行 `npm run release:build` 一次跑满，无拦停轮。
完整链 12 项全部 `passed`（取自该候选 `build-record.json`）：

| 步骤 | 退出码 | 耗时 |
|---|---|---|
| `typecheck` | 0 | 8.1s |
| `lint` | 0 | 6.6s |
| `test:unit` | 0 | 9.6s |
| `build` | 0 | 8.9s |
| `test:integration` | 0 | 60.9s |
| `test:e2e` | 0 | 35.3s |
| `test:e2e:electron` | 0 | 3.7s |
| `audit` | 0 | 1.3s |
| `dist` | 0 | 61.8s |
| `smoke:gui` | 0 | 26.4s（空参数默认配置，与双击等价） |
| `verify-package` | 0 | 1.5s |
| `zip` | 0 | — |

（具体测试数量以同轮次独立运行为准：unit 335 / integration 183 / e2e 16；
链内日志未整存，按本文档口径不抄写。）

登记后核验：`verify:release` core 16 项 0 失败 → 发布级终检 **18 项 0 失败，
`RELEASE_GREEN`，`publishable=true`**，末行 `ALL_GREEN buildId=20260921124125-bd8c2d5-0c200b`。
侧车 `candidate-20260921124125-bd8c2d5-0c200b.zip.sha256.txt` 已于登记后、分发前生成（exe/asar/zip 三行）。

**G1/§8.1 再次修订（重要，2026-09-21）**：本轮 `test:e2e:electron` 与 `smoke:gui`
在 agent 会话真实通过（耗时与 alpha.2 桌面轮同量级），说明前轮「agent 会话 smoke 必崩
（`0x80000003`）」是**当时会话环境现象**，不是恒定约束；此后不再预设 agent 会话不可跑
Electron 步骤，以每次链运行的真实退出码为准。
「真机 GUI 视觉观察归 jc」的职责划分不变（机器退出码证明不了观感）。

本轮相对 alpha.2 的源码增量：P2 占位符修复（`bee960b`）+ 两通道放行模型
structural-compat S1–S5（`a9e4f53`..`8e8cc5b`），详见 `docs/compatibility.md` 2026-09-21 节。

> 以下 5.0a / 5.1 / 5.2 小节为**历史记录**，原文保留不改写。

### 5.0a 历史候选（`0.1.0-alpha.2`，buildId `20260919055321-f8bb4fb-e00e50`）

构建于 2026-09-19，由 jc 在**桌面 cmd 会话**手动运行 `npm run release:build`。
完整链 12 项全部 `passed`（取自该候选 `build-record.json`）：

| 步骤 | 退出码 | 耗时 |
|---|---|---|
| `typecheck` | 0 | 6.9s |
| `lint` | 0 | 7.1s |
| `test:unit` | 0 | 7.3s（18/18 文件、321/321 用例） |
| `build` | 0 | 9.4s |
| `test:integration` | 0 | 65.1s（15/15 文件、179/179 用例） |
| `test:e2e` | 0 | 39.2s（16 项） |
| `test:e2e:electron` | 0 | 4.6s（38/38） |
| `audit` | 0 | 1.3s（FAIL 0 / WARN 0） |
| `dist` | 0 | 34.4s |
| `smoke:gui` | 0 | 21.1s（**空参数默认配置 `SMOKE_OK`**，与双击等价） |
| `verify-package` | 0 | 1.9s（30 项 0 失败） |
| `zip` | 0 | — |

登记后核验：`verify:release` core 16 项 0 失败 → 发布级终检 **18 项 0 失败，
`RELEASE_GREEN`，`publishable=true`**，末行 `ALL_GREEN buildId=20260919055321-f8bb4fb-e00e50`。
侧车 `candidate-20260919055321-f8bb4fb-e00e50.zip.sha256.txt` 已于登记后、分发前生成（exe/asar/zip 三行）。

**过程偏差登记（本轮拦停两次，均如实）**：
1. 第 1 轮停在 `test:unit`：编码自检的构建目录豁免正则漏配 `release-dev`（G4 改名后遗留），
   误扫 Chromium 官方 `LICENSES.chromium.html`（其本身含非 UTF-8 字节，非仓库文本问题）。
   修复 `7eff0b6`（豁免正则），仓库自身文本全绿。
2. 第 2 轮停在 `verify-package`：A2-1 决定把 `LICENSE` 打进包，但归档顶层白名单未同步。
   修复 `f8bb4fb`（白名单 + 文案），即本候选来源提交。
3. 拦停候选的磁盘现场：第 1 轮 buildId `20260919054303-6154fc0-ebedb9` 停在 `dist`
   之前，**未生成候选目录**；第 2 轮 `candidate-20260919054633-7eff0b6-7b9983/`
   在盘。两者均未登记、不可发布、不应被引用；删除待锁释放后人工执行。

**G1 结论修订（重要）**：`smoke:gui` 空参数在本机**桌面会话**真实通过 → 「本机不可验证」
的范围收窄为「**agent 自动化会话**不可验证」；详见 `docs/acceptance.md` §8 追加。

> 以下 5.1 / 5.2 小节为**历史记录**（分别属 `20260916114818-8b3b8f8-f4e1c6`
> 与 `manual-repack-20260912`），原文保留不改写。

### 5.1 当前候选（buildId `20260916114818-8b3b8f8-f4e1c6`）

证据为**该候选自己的** `build-record.json`（`build-record/2`），
12 项必检全部 `passed`、`releaseEligible=true`、`missingRequiredSteps` 为空：

| 步骤 | 退出码 | 耗时 |
|---|---|---|
| `typecheck` | 0 | 5.5s |
| `lint` | 0 | 5.5s |
| `test:unit` | 0 | 6.2s |
| `build` | 0 | 7.1s |
| `test:integration` | 0 | 130.4s |
| `test:e2e` | 0 | 37.7s |
| `test:e2e:electron` | 0 | 5.0s |
| `audit` | 0 | 14.3s |
| `dist` | 0 | 127.2s |
| `smoke:gui` | 0 | 26.1s |
| `verify-package` | 0 | 1.6s |
| `zip` | 0 | 0s |

另有 2026-09-17 独立复审的**只读**发布核验，绑定同一 buildId
（`handoff/review-2026-09-17/verify.summary.json`，`status: 0`）：
`verify:release --require-release-eligibility` **18 项 0 失败，`RELEASE_GREEN`**。
该次核验未重跑构建步骤，也未改动任何产物。

> **`smoke:gui` 一条的语义提醒**：上表该条由**整改前**的冒烟工具跑出
> （默认带 GPU workaround），只证明「关掉 GPU 相关子进程后能起窗口」。
> 整改后默认参数为空（与双击等价），已对同一候选独立复测通过，
> 但**未**回写 build-record。详见
> `handoff/review-2026-09-17/evidence/f2-f3-smoke.md` 与
> `docs/release-checklist.md` 第 3 节。

**未执行**：本候选的真实安装闭环（A5）与干净环境验证（A6）——见第 6、7 节，
状态仍为「待执行 / 用户决定跳过」，**没有把它们预填成新候选的成功**。

### 5.2 历史候选（`manual-repack-20260912`）——以下第 5 节其余内容与 R/S 小节均为历史记录

> 本小节及其后「A4 之后发现并修复的三个打包缺陷」「R1–R5」「S1–S6」记载的是
> **历史候选**（zip `92126171…`，源 `871703d`）的时间线，其中的
> 「当前候选不包含这些修复」在 5.1 候选上已不再成立——新候选包含 R/S 全部修复。
> 保留原文以维持过程可追溯。

| 命令 | 退出码 | 测试数 | 结论 | 证据 |
|---|---|---|---|---|
| `npm run typecheck` | 0 | — | **通过** | 12s |
| `npm run lint` | 0 | — | **通过** | 11s |
| `npm run test:unit` | 0 | 135 项（9 文件） | **通过** | 12s |
| `npm run test:integration` | 0 | 138 项（12 文件） | **通过** | 27s |
| `npm run build` | 0 | — | **通过** | 25s |
| `npm run test:e2e` | 0 | 16 项 | **通过** | 42s |
| `npm run test:e2e:electron` | 0 | 35 项 | **通过** | 12s |
| `npm run audit` | 0 | FAIL 0 / WARN 0 | **通过** | 8s |
| `npm run dist` | 0 | 产出 `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1/win-unpacked`（**其后因打包缺陷重封，见下节**） | **通过** | — |
| `npm run verify:package` | 0 | **30 项 0 失败**（967 条目；新增「unpacked 文件必须在盘上」「包内 sharp 可加载并出图」两项） | **通过** | — |

一条命令跑全链：`bash tools/release-gate.sh`（日志同时落 `/tmp/a4-gate.txt`）。
`npm run verify` 不含 `test:e2e:electron` / `audit` / `dist` / `verify:package`，
**不能只跑它**就宣称全部门禁通过。

包内抽查（A4，已在 asar 内逐项确认）：

| 项 | 结果 |
|---|---|
| ImageStore 副本流程 | `out/main/services/image-store.js` 含 `readCapped` / `contentHash` / `IMAGE_CONTENT_MISMATCH` |
| 应用阶段不再重读源路径 | `out/main/services/operation-service.js` 不含 `record.imagePath`，含 `contentHash` |
| 格式声明（jfif/jpe） | `out/shared/image-formats.js` 含 `jfif` 与 `'jpe'` |
| 图片解码核验模块 | `out/core/theme/image-probe.js` 含 `headerFormat` / `decoded` |

**风险与限制（如实记录）**：exe 与 app.asar 的哈希绑定本机这次构建；
A5/A6 必须测同一份 zip（`92126171…`）。源码或包若有任何改动，本节哈希作废、需重跑门禁。

### A4 之后发现并修复的三个打包缺陷（重封记录）

冻结后又发现 A4 那次打包的产物**本身跑不起来**，逐条定位与修复如下。
三条都属于「只查结构与清单查不出来」的类型，因此同时补进了 `verify:package`。

| # | 缺陷 | 怎么发现的 | 修复 |
|---|---|---|---|
| 1 | `app.asar.unpacked` 整个目录缺失：`@img/sharp-win32-x64` 的 9 个文件在归档头里标为 unpacked，磁盘上却没有，运行时 `require('sharp')` 直接失败 | 用 `ELECTRON_RUN_AS_NODE=1` 在包内 require sharp 复现；`@electron/asar` 提取时精确报「找不到这 9 个文件」 | 从本机 `node_modules` 补回原生模块，重封时带 `unpack` 规则 |
| 2 | 运行期依赖 `@img/colour` 根本没被打进包 | 补完 #1 后再测，报 `Cannot find module '@img/colour'` | 从本机 `node_modules` 补入并重封 |
| 3 | 39 个 `locales/*.pak` 被删（16/55，含 zh-CN 之外的多语言资源） | 与原始 Electron 运行时逐文件比对 | 从 `node_modules/electron/dist` 补齐缺失文件（40 个） |

成因：某次打包在「清理旧输出目录」时卡住（旧 `app.asar` 被外部进程占用、改名失败），
被中断后留下了删掉一半的产物；后续 electron-builder 也在同一位置反复挂死。
修复后的包：`verify:package` 30 项 0 失败，包内 sharp 能真的产出 PNG。

**环境提醒（避免重复误判）**：本机 shell 全局带 `ELECTRON_RUN_AS_NODE=1`，
从命令行启动任何 Electron 应用都会退化成 Node 模式——不建窗口、无脚本时静默退出 0，
看上去像「包坏了」。启动验证必须先清掉这个变量（见 `tools/smoke-packaged.ts`）。

### 2026-09-13 审查修复（R1–R5）：均发生在候选冻结之后，未改变当前候选包

2026-09-13 独立审查（基线 `40b2cfe`）确认 4 项代码问题与 2 类验收问题，
按计划逐项修复、独立提交。**当前候选（zip `92126171…`）不包含这些修复**；
如需让候选包含，必须重新构建/重封并重新登记 manifest、重跑门禁，历史哈希作废。

| 编号 | 内容 | 提交 |
|---|---|---|
| R1 | dist 失败接入 `run` 传播链，不再假 ALL_GREEN；日志独立构建 ID；verify 绑定本次候选 | `4006f88` |
| R2 | 单一候选 manifest（`candidate-manifest.json`）；包校验默认绑定登记候选，不回退旧目录；候选身份 37 项核对 | `a9150bc` |
| R3 | 在用缩略图不再被当孤儿删除；预览可从已校验副本回退重建；副本问题/解码失败错误码分离 | `6bf76bc` |
| R4 | 读图/解码全部入口纳入资源限额；受限读短读循环；超限在 raw 像素分配前拒绝（IMAGE_TOO_LARGE） | `28b80ce` |
| R5 | 应用闭环 FILE_LOCKED 假失败定位为**环境层干扰**：本机安全进程持久锁 %TEMP% 下新建 `*.asar`（.bin/.zip 与项目盘不受影响，见 `tests/diagnose/` 哨兵与 `tools/r5-*.cjs` 探针）。测试临时目录迁出 %TEMP%（`tests/fixtures/test-tmp.ts`） | `a83df6b` |

R5 完成后的测试范围（如实记录）：**全量单元+集成 295 项通过（23 文件，提交 `a83df6b` 源码）**。
这验证的是**当前源码**，不是 zip 内代码；审查前历史数字（273 项）对应当时源码，均已过期不重复使用。

### 2026-09-13 第二轮审查修复（S1–S6）：同样仅源码级，当前候选仍不含

同日第二轮独立审查（计划 `handoff/review-2026-09-13-r2/REVIEW_AND_FIX_PLAN.md`）确认 6 项，
逐项修复、独立提交。**当前候选（zip `92126171…`，源 `871703d`，`manual-repack-20260912`）依然不包含
这些修复**；且 S3 之后新登记（schema `candidate-manifest/2`）才允许通过发布门禁，旧登记在
`verify:release` 下失败关闭。包含修复必须：冻结源码 → `npm run build` → 全新候选目录 + 唯一 buildId →
`node tools/candidate-manifest.cjs register` 重新登记 → `GATE_CANDIDATE_DIR/GATE_BUILD_ID` 绑定跑
`bash tools/release-gate.sh`。禁止沿用现有 zip 名称/身份冒充已含修复。

| 编号 | 内容 | 提交 |
|---|---|---|
| S1 | 诊断文件三处类型错误修复，typecheck/lint 恢复退出 0 | `98021ab` |
| S2 | ImageStore 清理与导入竞态：删除判定时实时重建引用集合（同步 Map），确定性交错测试固定行为 | `c1bb98d` |
| S4 | 缩略图返回前受限完整解码（1024² 像素、单帧、APNG 拒绝），坏缓存必进回退重建；预览临时文件+rename 落盘 | `4aa9c62` |
| S5 | 测试包装脚本传播退出码（0/23/信号/spawn 错误），日志按 runId 隔离不覆盖 | `1933068` |
| S6 | 门禁日志目录可注入（GATE_LOG_DIR）且按 runId 隔离；哨兵不写共享 /tmp；显式候选分支与并发互不覆盖入测 | `e33fb48` |
| S3 | 发布门禁与旧候选核验**分离命名/输出**：`verify:release`（新 `tools/verify-release.cjs`）绑定唯一 buildId+候选目录+HEAD 冻结，登记 schema/2 记录锁文件 hash 与完整 out/** 冻结清单，包内 out 与清单逐文件一致（缺/多/差异都失败，至少覆盖 ImageStore/generate/image-probe），zip 与候选目录逐条目 CRC32 一致；门禁缺 `GATE_CANDIDATE_DIR/GATE_BUILD_ID` 绑定在构建前 exit 2，不回落默认候选；`verify:package` 定位为旧候选身份核验（输出明确不构成发布验收结论） | `2e17e2a` |

S3 完成后的测试范围（如实记录）：**全量单元+集成 323 项通过（25 文件，提交 `2e17e2a` 源码，
`node tools/r5-run-suite.cjs run` 退出 0）**；typecheck/lint 退出 0；门禁脚本层测试
`node tools/test-release-gate.cjs` 全过（含缺失绑定的失败关闭场景）。验证对象均为**当前源码与脚本**，
不是 zip 内代码。A8 维持 NO-GO：发布前必须完成全新候选的构建、登记、门禁与真实闭环（另需用户授权）。
测试运行的已知环境注意事项：需用 `tools/r5-run-suite.cjs`（注入项目盘 TEMP）跑，
否则本机安全进程会锁 %TEMP% 下的合成 asar 造成假失败；全量高并发下 D 盘冷缓存可能
出现个别超时抖动（单文件重跑即恢复），与 FILE_LOCKED 无关。

## 6. A5 真实 OpenCode 闭环（需用户授权）

**2026-09-18 轮：已授权并执行完毕，判定通过**。完整取证见
`handoff/alpha-release-evidence/a5-round-20260918.md`（私有不入库，留本机；下称「证据文件」；含一次过程偏差
「裸 restore」的如实登记 §1，与一处 P3 外观缺陷 §4.1）。写入经 `tools/live-cli.cjs`
（与 GUI 同一服务层，先例 09-12）；`git diff 8b3b8f8..HEAD -- src/` 为 0 行，服务层与
登记候选源码同源；候选 exe 自身的空参数 GUI 启动不由本轮证明（环境限制，见 `docs/acceptance.md` 第 8 节）。

| 步骤 | 期望 | 实际 | 结论 | 证据 |
|---|---|---|---|---|
| 用户保存工作并完全退出 OpenCode | 不擅自强杀进程 | 每轮 precheck 进程 idle，未强杀 | **通过** | 证据文件 §0/§3/§4 |
| 记录目标版本/路径/归档 hash/健康备份 | 与候选包 hash 一并记录 | 1.18.29 supported；previous×9+takeover×1（全 `pristine=false`）；逐操作前后指纹 | **通过** | §0/§3–§4.3 |
| 应用 JFIF 壁纸 A → 重启检查 | 背景、侧栏、正文、输入、菜单、Portal、终端、代码区 | `op-…l6vpqd`，14 项只读核验 0 失败，包内图片哈希==源文件；jc 整体回执通过 | **通过** | §3 |
| 换透明 PNG B、静态 WebP C | 每次重启核对效果与图片 hash | `op-…psblx4` / `op-…fuv9gu`，各自 14 项核验与哈希一致；jc 回执通过 | **通过** | §4/§4.1 |
| 同 C 重复应用 | no-op，不改写、不新增事务 | 复用同一操作 ID，前后指纹相同，备份数 3→3 | **通过** | §4.2 |
| 官方主题 / 深浅 / 新旧布局 / 缩放 125%·150% | 背景与可读性正常 | 并入 C 轮走查，jc 整体回执通过（未逐项回执，如实记录） | **通过（整体回执）** | §4.1 |
| 恢复上一主题 → 恢复首次接管快照 | 归档 hash、启动、背景、会话/终端可用 | previous→B 态；`restore original` 预期失败关闭；takeover→无主题干净态；启动检查 jc 回执「可行」；最终保持无主题（jc 决定） | **通过** | §4.3/§5 |
| 截图与 DOM 探针 | 脱敏，标注真实窗口而非夹具 | 部分：1 张真机截图（P3 外观缺陷取证，私有不入库）；逐区截图与真机 DOM 探针**未做**，肉眼验收以 jc 回执为准 | **部分完成** | §4.1、本表注 |

**2026-09-19 轮（alpha.2 候选 `20260919055321-f8bb4fb-e00e50`，A2-3 快速复验）：已授权并执行完毕，判定通过**。
取证**入库**于 `handoff/alpha2-release-evidence/a5-round-20260919.md`（附 T65 probe 完整 JSON
`t65-probe-20260919.json`）。要点：A/B/C→no-op 链与三步恢复演练全过（`restore original` 预期失败关闭
`BACKUP_MISSING`；takeover 恢复回首次接管指纹 `1c53ca24…`，与 09-18 轮同值）；
新增登记一处 **P2 输入框占位文字不可读**缺陷（官方 50% color-mix × `#585e63` → 有效对比度 2.07:1，
非 alpha.2 回归，修复立后续轮不进本候选）与两次过程偏差（会话外 alpha.1 目录包 apply、
裸 restore 重演被 FILE_LOCKED 兜住）；T65 限制如实登记为本机非干净环境（属已适配版本复测，非新适配首跑）。
最终停留无主题态，jc 整体回执「通过」（未逐项回执，如实记录）。

## 7. A6 干净环境验证（用户决定跳过）

**状态（2026-09-13 落账）**：用户决定跳过本轮 A6——没有非开发机器/全新 VM 可用，
不再重复安排必须准备新机器。**全部子项未验证，登记为已知风险**；平台声明相应收窄：
只验证过当前开发机（Windows x64），不得声称 Windows 10/11 干净环境可用。
风险表现：包在缺 Node/构建工具的干净环境、异常路径（权限/空间/占用）下的行为没有直接证据，
仅有包内 sharp 出图的 Node 模式检查作为间接信号。

| 项 | 期望 | 实际 | 结论 | 证据 |
|---|---|---|---|---|
| 非开发机器或全新 VM | 无 node_modules / 无手工 PATH / 无全局 Node 或 Python | 用户决定跳过 | **跳过（未验证，已知风险）** | — |
| 中文与空格路径解压 | 启动、选图、拖拽、取色、预览正常 | 用户决定跳过 | **跳过（未验证，已知风险）** | — |
| 同版本 OpenCode 闭环 | 应用→重启→换图→恢复 | 用户决定跳过 | **跳过（未验证，已知风险）** | — |
| 异常路径 | 运行中拒绝写入、空间不足、权限不足（用合成目标） | 用户决定跳过 | **跳过（未验证，已知风险）** | — |
| 用户数据位置 | 写到指定运行目录，不误写程序目录；重开后备份与恢复记录有效 | 用户决定跳过 | **跳过（未验证，已知风险）** | — |
| 平台声明 | 只有 10 或 11 有记录时不得声称两者都验证 | 仅开发机 Windows x64 有记录 | **声明收窄：只声称开发机验证** | 本节 |

## 8. A7 发布材料与公开范围检查

| 项 | 期望 | 实际 | 结论 | 证据 |
|---|---|---|---|---|
| 版本 zip + 校验和 + 已知限制 + 兼容范围 | 与候选一致 | zip 131 MB（**84 条目**，完整性 OK）+ `.sha256.txt` + `docs/release-notes-0.1.0-alpha.1.md` | **通过** | `docs/release-notes-0.1.0-alpha.1.md`；条目数与 `candidate-manifest.json` 一致 |
| 五步使用与恢复说明 + 反馈模板 | 新手可照做 | 已写入发布说明（五步含「完全退出」与重启确认；恢复三入口写清各自含义；反馈模板列 5 项） | **通过** | 同上 |
| 声明非官方/Alpha/未签名/需备份重启 | 如实 | 发布说明首屏即声明非官方与未签名；写明备份位置与「删工具目录 ≠ 撤销主题」 | **通过** | 同上 |
| 演示素材 | 只用已实测候选包与可公开素材 | **未拍摄**（`docs/demo-script.md` 只有分镜） | 待执行 | — |
| Git 跟踪文件与历史隐私检查 | 输出「建议排除/脱敏」清单，交用户确认 | 已输出：10 个跟踪文件含本机路径（集中在 handoff/ 与 3 个 tools 脚本）、5 张诊断截图、49 个提交为个人邮箱；**无私人壁纸、无凭证** | **通过（清单已出，处置待 jc 确认）** | `handoff/alpha-release-plan-2026-09-12/publish-scope.md` |
| 许可与依赖说明 | 完整 | 已补根目录 `LICENSE`（MIT，`Copyright (c) 2026 jc`）、`package.json` 补 author/license | **通过（源码仓库层面）** | 仓库 `LICENSE`。**注意**：`LICENSE`/author 是重封之后才补进源码的，**当前候选包内容不对应这两项改动**（包内是否含 LICENSE 文件未核验，不得对外声称包内附带该许可文本）；重封前需把此项差异一并纳入。**[落定 2026-09-18]** 包内 LICENSE 已核验为**缺失**：当前候选 asar 顶层仅 `package.json`/`out/**`/`node_modules/**`，且 `build.files`（`out/**`、`package.json`、`node_modules/**`）不含根 `LICENSE`——今后任何重建在不改该列表时同样不含。分发时以随附文本（仓库/发布页 LICENSE + zip 内 electron/chromium 自带许可）满足 MIT 要求，说明措辞**不得**称「包内附带」；下次重建候选时把 `LICENSE` 加入 `build.files`。 |

## 9. A8 GO/NO-GO

下表**逐项标注证据属于哪个候选**；历史候选的结论不自动继承给 5.1 的当前候选。

| 条件 | 结论 |
|---|---|
| A1 文档与 UI/恢复逻辑一致，无错误「原版」承诺 | **通过（2026-09-18 本机人工核对）**——十项全过，含一处单位修正（README 20 MB→20 MiB），见第 2 节 |
| A2 预览/应用绑定同一图像；异常不写安装；动画范围明确 | **通过（2026-09-18 本机人工核对）**——行为探针 11/11，见第 3 节 |
| A3 完整图片核验与 HTML 边界通过 | **通过（历史候选）**（见第 4 节）；当前候选的对应实现由 A4 自动化测试覆盖，但该人工核对**未在新候选上重做** |
| A4 门禁全绿、候选版本与 hash 固定 | **通过**——当前候选 12 项必检全过（见 5.1）；历史候选的 A4 见 5.2 |
| A5 真实安装闭环完成 | **通过（2026-09-18 轮，已授权）**——见第 6 节与 `handoff/alpha-release-evidence/a5-round-20260918.md`；**alpha.2 候选已复验通过（2026-09-19 轮，A2-3）**——见第 6 节追加块与 `handoff/alpha2-release-evidence/a5-round-20260919.md` |
| A6 干净环境验证 | **用户决定跳过——未验证，按已知风险处理** |
| A7 分发材料与公开范围检查完成 | **通过（历史候选）**（见第 8 节）；当前候选的包内 LICENSE 已核验**落定为缺失**（见第 8 节「[落定 2026-09-18]」），演示素材仍未拍摄，隐私处置清单待 jc 确认 |
| 无启动失败/归档损坏/恢复失败/静默写错图 | **通过（2026-09-18 轮）**——恢复演练后启动检查正常；逐操作 hash 复核与 14 项只读核验一致，无写错图（包内图片哈希==源文件）；遗留仅一处 P3 外观缺陷 |
| 用户明确批准发布目标、版本与内容 | **已批准（2026-09-18，jc 指令「批准发布」）**——发布物三件与已知限制口径见 9.3 |

**当前建议**：仍为 **NO-GO**。理由分三类，不要混为一谈：

1. **缺证据**：A5 未执行——没有当前候选对应的真实安装→重启→视觉检查→恢复证据；
   A6 已按用户决定跳过（平台声明收窄至开发机）。
2. **待修的已知问题**（见 `handoff/review-2026-09-17/REVIEW_AND_FIX_PLAN.md`）：
   F2/F3 冒烟配置与错误监听时序、F4 ZIP 结构边界。它们**不表示当前候选包本身有问题**
   （当前候选已通过只读发布核验），但表示现有绿色证据的覆盖面有缺口。
3. **历史结论不可继承**：A3/A7 的「通过」绑定历史候选，不能直接套给新候选。

仅可先做受控展示或内部测试，不得标注为稳定版。

### 9.1 更新（2026-09-18，复审 G1–G4 与 f4 修复落地后）

不改写上表与三类理由原文，只登记现状：

- **理由 2 已消除**：F1–F4（09-17 复审，提交 `8a3a358`/`0631dbd`/`b43dc44` 等）与
  G1–G4（09-18 复审，提交 `f52b244`/`30a0a2d`/`6a8c6b8`/`1905fc4`）全部修复并提交，
  验收记录见 `handoff/review-2026-09-18/REVIEW_AND_FIX_PLAN.md` 第七节。这些均为
  工具/编排/文档层修复；登记候选的产品二进制与源码同源（`git diff 8b3b8f8..HEAD -- src/` 为零）。
- **理由 3 收敛**：A3 的当前候选侧由 A4 全量自动化测试覆盖（人工核对不重做的定性不变）；
  A7 的「包内 LICENSE 未核验」已核验落定为缺失（见第 8 节），不再是不确定项。
- **理由 1 不变且成为唯一硬缺口**：A5 未执行——需要用户当次授权与参与
  （正常启动→导入→应用→重启→视觉检查→恢复），A6 仍按用户决定跳过、按已知风险处理。

**A8 结论不变：仍为 NO-GO**，缺口收敛为 A5 一项；A5 完成并通过前不刷 GO。
本次更新未执行任何新验证，也未改动任何候选产物。

### 9.2 更新（2026-09-18 晚，A5 执行完毕后）

- **A5 已通过**（本轮取证见第 6 节与证据文件），9.1 所述「唯一硬缺口」已补齐；
  「无启动失败/恢复失败/静默写错图」行同步落为通过。
- **A8 距 GO 只剩一项流程**：「用户明确批准发布目标、版本与内容」——这是 jc 的签核动作，
  不是证据缺口。wb 侧建议：可刷 GO。
- **A1/A2 已补做（2026-09-18 本机人工核对，jc 指令）**：十项 + 八项全部落定通过
  （第 2/3 节；A1 修正一处单位口径）。此前 9.1/9.2 所述「人工核对未做」的保留意见撤销。
- 本文件不擅自刷 GO：A8 全部证据条件已满足，结论为「**待用户签核**」，由 jc 明确批准后生效。

### 9.3 更新（2026-09-18 晚，用户签核后）——**A8 = GO**

- **签核**：jc 指令「批准发布」，发布目标、版本（`0.1.0-alpha.1`）与内容（当前候选
  `20260916114818-8b3b8f8-f4e1c6`）一并获准。上表「当前建议 NO-GO」原文保留为历史，
  自本段起 A8 结论为 **GO**。
- **发布物三件**（均已在磁盘核对，zip 与 `win-unpacked/` 内 exe/asar 哈希于 2026-09-18
  实算，与 `docs/release-checklist.md` 第 1 节权威块三行完全一致）：
  1. `candidate-20260916114818-8b3b8f8-f4e1c6.zip`（133,371,677 字节，
     SHA256 `1df4c697…070c739`）；
  2. `candidate-20260916114818-8b3b8f8-f4e1c6.zip.sha256.txt`（随附校验文件，见下条登记）；
  3. `docs/release-notes-0.1.0-alpha.1.md`。
- **过程偏差如实登记**：上述 `.sha256.txt` 此前**并不存在**——09-17 起的文档
  （release notes 反馈第 1 项、复审计划方案 A）引用了一个从未生成过的随附文件；
  zip 与 `candidate-*.txt` 均在 `.gitignore`（分发物不入库），manifest 亦无该字段。
  GO 落账时基于已实算且与权威块一致的哈希**补生成**，命名与历史包
  `*-archived-20260918.sha256.txt` 的格式一致。文档引用自本段起与实际磁盘一致。
- **GO 口径下的已知限制**（分发说明必须如实携带，不得因 GO 而抹掉）：
  未签名；包内无项目根 `LICENSE`（分发以仓库/发布页许可文本满足 MIT 要求，
  不得声称「包内附带」）；A6 干净环境未验证（平台声明仅开发机 Windows x64）；
  A3/A7 的历史候选定性不变（当前候选侧由 A4 自动化覆盖、LICENSE 已落定）；
  一处 P3 外观缺陷遗留（真机色块大小，见第 6 节）。
- **分发渠道与动作**：本次 GO 仅落账批准；实际上传/外发等 jc 指定渠道后执行。
- **不阻塞后续**（复审 8.4 步 4）：有显示会话机器重建候选（`build.files` 加 `LICENSE`）
  + T65 干净环境验证；演示素材按需补拍；G1.3 候选 `20260918013040` 处置仍待决策。

### 9.4 发布执行记录（2026-09-18 晚，渠道：GitHub 私有仓库 Release）

- **tag**：`v0.1.0-alpha.1`（带注释，指向 `49c69d0`，注释含 buildId 与 zip SHA256），
  已推送 `origin`（`* [new tag]`）。
- **Release**：jc 在 GitHub 网页手动创建并发布，标记 **pre-release**，
  `https://github.com/plusmultiply0/oc_theme_editor/releases/tag/v0.1.0-alpha.1`。
  附件：`candidate-20260916114818-8b3b8f8-f4e1c6.zip` + 同名 `.zip.sha256.txt`
  （两件均已在页面 Assets 可见，jc 回执确认）。
- **上传过程如实记录**：新建草稿页时 `.sha256.txt`（528 B）先传成功，127 MiB zip
  一次上传进度条无进展、失败（GitHub 自动附加的 Source code 两件不算本次上传物）；
  改在草稿 Edit 页重传 zip 后成功（jc 回执）。
- **核验边界**：仓库为**私有**，wb 侧匿名抓取 Release 页返回 404（预期），
  远程可见性以 jc 页面回执为准；本地上传前复算 zip SHA256 ==
  `1df4c697…070c739`（与权威块一致）。
- **发布范围口径**：私有仓库 Release 仅对受邀账号可见——按「受控分发」理解，
  与 A8 的 alpha 口径一致；若转公开仓库，A7 隐私处置清单（10 个含本机路径的
  跟踪文件、个人邮箱提交历史）**必须先执行**，届时重评。
- 至此 8.4 步 3（GO → 分发）闭环。剩余非阻塞项见 9.3 末条。

### 9.5 发布执行记录（2026-09-19，alpha.2，渠道：GitHub 私有仓库 Release）

- **签核**：jc 2026-09-19 指令「提交 A2-4 的 tag 和 Release 三件套」（A2-3 复验通过后）。
- **tag**：`v0.1.0-alpha.2`（带注释，指向登记 HEAD `f7abd2f`，注释含 buildId
  `20260919055321-f8bb4fb-e00e50`、zip SHA256、已知限制含 P2 占位符缺陷），
  已推送 `origin`（`* [new tag]`）。与 alpha.1 先例一致：tag 打在登记提交上，非源提交。
- **上传前复算**：zip SHA256 == `68e47fd1…0e46eaf`（133,373,796 B），与侧车
  `.zip.sha256.txt`、`docs/release-checklist.md` §1 权威块三方一致；侧车**先于上传**已在盘
  （A2-2 登记时生成，纠正 alpha.1「引用不存在随附文件」偏差）。
- **Release**：本机无 gh CLI（alpha.1 轮亦网页手动），jc 在 GitHub 网页发布，
  标记 pre-release，`https://github.com/plusmultiply0/oc_theme_editor/releases/tag/v0.1.0-alpha.2`，
  附件两件：`candidate-20260919055321-f8bb4fb-e00e50.zip` + 同名 `.zip.sha256.txt`；
  说明正文为 `docs/release-notes-0.1.0-alpha.2.md` 全文。
- **核验边界**：私有仓库，wb 侧无匿名核验通道（与 alpha.1 同口径），
  远程可见性以 jc 页面回执「已发布」为准。
- **发布范围口径**：同 9.4——受控分发；转公开前 A7 隐私处置清单必须先执行。
- 至此 A2-4 与 alpha.2 发布轮（PLAN 2026-09-19）全部四步闭环。
  遗留非阻塞项：P2 占位符缺陷修复轮、live-cli takeover 参数（工具面）、
  历史候选目录处置、演示素材、A7 隐私处置待 jc。

### 9.6 发布执行记录（2026-09-21，alpha.3，渠道：GitHub 私有仓库 Release）

- **签核口径**：jc 指令链「同步 tag 与发布 alpha.3」→「跑 npm run release:build」。
  本轮**未做 A5 真机复验**（含 structural 徽章/确认框走查），tag 注释如实标注
  「A5 待做，未宣称 A8 签核」——与 alpha.1/alpha.2 的「复验通过后签核发布」先例**不同**，
  属用户明示指令下的提前发布，风险口径以第 5.0 节链证据为准。
- **链运行**：`npm run release:build` 在 **agent 会话**一次跑满 12 步全绿
  （`smoke:gui` 空参数 26.4s `SMOKE_OK`），末行
  `ALL_GREEN buildId=20260921124125-bd8c2d5-0c200b`。据此修订 `docs/acceptance.md`
  §8.1「agent 会话 smoke 必崩」为会话环境相关（§8.2）。
- **登记**：`fab237f`（README/acceptance/alpha-acceptance/release-checklist/
  release-notes 五文件）；`doc-candidate-entry.cjs --check` 得
  `DOC_ENTRY_OK`（文档、manifest、磁盘实算三方一致）；侧车
  `.zip.sha256.txt` 已按规则生成于登记后、分发前（按 `.gitignore` `candidate-*.txt`
  不入库，与先例一致）。
- **tag**：`v0.1.0-alpha.3`（带注释，指向登记 HEAD `fab237f`，注释含 buildId、
  zip SHA256 `7b953fc8…f14085`、相对 alpha.2 变化、已知限制含 A5 待做），
  已推送 `origin`（`* [new tag]`）。
- **Release（待执行）**：本机无 gh CLI，按先例由 jc 在 GitHub 网页创建 pre-release，
  附件两件：`candidate-20260921124125-bd8c2d5-0c200b.zip`（133,378,495 B，
  SHA256 `7b953fc8f9571230cb8668fbedae066a50f6bd6a0078fc30b1446ea5d9f14085`）+
  同名 `.zip.sha256.txt`；正文用 `docs/release-notes-0.1.0-alpha.3.md` 全文。
  **jc 回执后在本节补记 URL 与 Assets 可见性确认，此前不得称已发布。**
- **核验边界与分发口径**：同 9.4/9.5——私有仓库受控分发，远程可见性以 jc 页面
  回执为准；转公开前 A7 隐私处置清单必须先执行。

