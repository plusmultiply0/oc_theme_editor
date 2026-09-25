# 交付清单

Alpha 候选版本用 `docs/alpha-acceptance.md` 记录逐项验收；本文件只回答两件事：
**当前该用哪个包**、**发布前必须核对什么**。

## 1. 当前候选（正式版）

版本 **`1.0.0`**（Windows x64，首个正式版），由 `npm run release:build` 的正式发布链产出
（`packMethod: electron-builder`，**可重复构建**，**首跑即一次跑满 12 步全绿、无拦停轮**）。
功能与 `0.1.0-alpha.10` 零差异（本候选相对其仅版本号与文档）；版本号不沿用
`0.1.0` 因其已被 Alpha 之前的首个标记版本占用（tag `v0.1.0`，提交 `8e6bd04`）。

下面这段是本文件的**唯一权威入口**，由 `tools/doc-candidate-entry.cjs` 从选中
manifest 加磁盘实算生成：

<!-- CURRENT-CANDIDATE:BEGIN -->
buildId: 20260925081334-0160900-e4b156
sourceCommit: 0160900565c4b81df6f8da516a690a41410afe51
schema: candidate-manifest/3
packMethod: electron-builder
manifest: candidate-20260925081334-0160900-e4b156/candidate-manifest.json
candidateDir: candidate-20260925081334-0160900-e4b156/win-unpacked
zip: candidate-20260925081334-0160900-e4b156.zip
zipSha256: 7a812b3ea8b73b3bee2c77ede5c57c7d33e71fe851b70b161c1260da7facab91
exeSha256: 3b6584b7ded9f932f9c42529c4e0de765f2086113f4ad5f6e2d32c4196ef08aa
asarSha256: d367a90abb34c85814e68faf2ebff8b95073a220468f4c1d39f93378ca8eb004
<!-- CURRENT-CANDIDATE:END -->

| 文件 | 大小 | 说明 |
|---|---|---|
| `candidate-20260925081334-0160900-e4b156.zip` | 127.2 MB | 分发以 zip 为准（82 条目，整目录压缩） |
| ├ `OpenCodeThemeSwitcher.exe` | 193.3 MB | 未签名 |
| └ `resources/app.asar` | 17.8 MB | 1064 条目 / unpacked 7 |

候选身份由 `release-receipt/1` 与 `build-record/2` 绑定同一 buildId 与源码提交；
`build-record` 的 12 项必检（`typecheck`、`lint`、`test:unit`、`test:integration`、
`build`、`test:e2e`、`test:e2e:electron`、`audit`、`dist`、`smoke:gui`、
`verify-package`、`zip`）全部 `passed`，`releaseEligible=true`。

**核对方式（不靠人眼比对）**：

```bash
node tools/doc-candidate-entry.cjs \
  --manifest candidate-20260925081334-0160900-e4b156/candidate-manifest.json --check
```

该命令把「文档块 / manifest 登记 / 磁盘实算哈希」三方对齐；任一不符即非 0 退出。
**重封或重建后必须换掉上面的 buildId 与哈希，而不是沿用旧块。**

**分发要求**：整个 `win-unpacked` 一起发（zip），不能只发 exe；
zip 的 SHA256 必须与上表一致。

## 2. 历史构建（全部过期，不要用于验证或分发）

### 2.1 历史候选：手工重封 alpha 包（`manual-repack-20260912`）

**不作为本次发布候选，仅供历史追溯。** 该包早于 R1–R6 / S1–S6 全部源码修复，
其 manifest、hash 与 receipt 原样保留，未做任何改写：

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.1` |
| 来源提交 | `871703da2bd775a2af1a9eb464b813a57e6fb8ae` |
| 登记 | `candidate-manifest.json`（schema `candidate-manifest/1`，buildId `manual-repack-20260912`，`manual-repack`，**不可重复构建**） |
| 分发 zip | `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.zip` |
| zip SHA256 | `9212617177fa9bb7c8f46b5bd313f7c76484f26e2c646d5e9e9de598c7e81c6c` |
| exe SHA256 | `99c02d6796bc2df00d7b16f8135ae9052b11bfb08384ee502b5044961756f46f` |
| app.asar SHA256 | `7ca56cc52318ce49193fe32100e195a4885aaac7681660846a180daab4efdce8` |
| 备注 | 归档 967 条目 / unpacked 7；旧 `win-unpacked` 目录中 `app.asar` 曾被外部进程占用，无法删除 |

历史候选的命令与结果记录保留在 `docs/acceptance.md`
与 `docs/alpha-acceptance.md`「历史候选」小节，**不作为当前入口**。

### 2.2 早期目录构建

| 目录 | 构建时间 | 内容 | 状态 |
|---|---|---|---|
| `release/` | 2026-09-11 | 最早的可执行目录目标 | 过期 |
| `release2/` | 2026-09-11 | 目标发现过滤修复 | 过期 |
| `release3/` | 2026-09-11 | P0 审查 R1–R8 修复 | 过期 |
| `release4/` | 2026-09-12 | 事故 F1–F4 修复前 | 过期 |
| `release5/` | 2026-09-12 | 背景事故 F1–F4 | 过期 |
| `release6/` | 2026-09-12 | 真机验收发现的三处修复 | 过期 |
| `release7/` | 2026-09-12 | 第一批 JPEG 别名支持 | 过期（曾是手工重封候选的基准，现已被第 1 节取代） |

旧的 `app.asar` 曾被安全软件占用（环境的安全删除包装器对 `.asar` 回收失败），
因此每轮只能递进一个新目录，旧的删不掉。锁释放后在资源管理器手动删除即可。

### 2.3 历史候选：v0.1.0-alpha.1 正式包（electron-builder，已对外发布）

2026-09-16 由正式链产出、当时曾作为第 1 节当前候选的包。已打 tag `v0.1.0-alpha.1`
并发布到私有仓库 Release（登记见 `docs/acceptance.md` 9.4）。**自 2026-09-19 起转为历史**：
alpha.2（第 1 节）取代它成为唯一入口；其 manifest、hash 与 receipt 原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.1` |
| buildId | `20260916114818-8b3b8f8-f4e1c6` |
| 来源提交 | `8b3b8f88f91df20ed2438388bd7270b9b7532e69` |
| 分发 zip | `candidate-20260916114818-8b3b8f8-f4e1c6.zip` |
| zip SHA256 | `1df4c69765ee91e92b8bde46a2bb331aa45c63f3de0376423be83caef070c739` |
| exe SHA256 | `ed8ee97cddb8afadd7d3c9975aa661a4dfebc9bbe9e27fa7165b92c158426cba` |
| app.asar SHA256 | `e79cd599cbc1c6f66b23b6d80a9b666fffcc2c8e897ca108a835ae0379670a95` |

该候选当时的两条记录随本节一并保留（原载于第 3 节）：

- 注（`smoke:gui` 一条的语义）：该条由**整改前**的冒烟工具跑出——当时默认带
  `--disable-gpu` 等 GPU workaround，证明的是「关掉 GPU 相关子进程后能起窗口」，
  **不等于**默认配置可启动。2026-09-17 已把默认参数改为**空**（与双击等价），
  并用整改后的默认配置对同一候选独立复测通过（`SMOKE_OK`，args=[]）。
  该复测**未**回写 build-record（回写等于篡改历史记录）；
  详见 `handoff/review-2026-09-17/evidence/f2-f3-smoke.md`。
- 另有 2026-09-17 的独立只读发布核验（`handoff/review-2026-09-17/`）：绑定同一
  buildId 的 `verify:release` **18 项 0 失败，`RELEASE_GREEN`**。该核验只读、未重跑构建步骤。

另有 2026-09-19 两次**未登记、不可发布**的拦停轮：第 1 轮 buildId
`20260919054303-6154fc0-ebedb9`（test:unit 拦停，停在 `dist` 前，未生成候选目录）；
第 2 轮 `candidate-20260919054633-7eff0b6-7b9983/`（verify-package 拦停，目录在盘）。
两者无 manifest 登记与 receipt，仅作排障现场，处置前不得被误认为候选。

### 2.4 历史候选：v0.1.0-alpha.2 正式包（electron-builder，已对外发布）

2026-09-19 由正式链产出（jc 桌面会话跑链）、曾为第 1 节当前候选并对外发布的包。
已打 tag `v0.1.0-alpha.2` 并发布到私有仓库 Release（登记见 `docs/alpha-acceptance.md` 9.5）。
**自 2026-09-21 起转为历史**：alpha.3（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.2` |
| buildId | `20260919055321-f8bb4fb-e00e50` |
| 来源提交 | `f8bb4fb0cc2a485856dc7c8d72f32ae7fff1e5de` |
| 分发 zip | `candidate-20260919055321-f8bb4fb-e00e50.zip` |
| zip SHA256 | `68e47fd18f200621f5f12c6af7f6b9b8075cd4347545ba7ae1992e1fb0e46eaf` |
| exe SHA256 | `c60b32d008783fed18f48c51dccae06c34ea845a14a646a1948aff57ad3f4fae` |
| app.asar SHA256 | `1399191aee072d16c5f7f601a37fcce30976068b204744ee2fefd24ab1dd5d46` |

注：P2 占位符缺陷的修复（`bee960b`）与真机复验完成于该候选登记**之后**，
不在 alpha.2 包内，随 alpha.3 分发。

### 2.5 历史候选：v0.1.0-alpha.3 正式包（electron-builder，已对外发布）

2026-09-21 由正式链产出（agent 会话跑满全链）、曾为第 1 节当前候选并对外发布的包。
已打 tag `v0.1.0-alpha.3` 并发布到私有仓库 Release（登记见 `docs/alpha-acceptance.md` 9.6）。
**自 2026-09-22 起转为历史**：alpha.4（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.3` |
| buildId | `20260921124125-bd8c2d5-0c200b` |
| 来源提交 | `bd8c2d50802aceab189b41ded457101e0ed9ff28` |
| 分发 zip | `candidate-20260921124125-bd8c2d5-0c200b.zip` |
| zip SHA256 | `7b953fc8f9571230cb8668fbedae066a50f6bd6a0078fc30b1446ea5d9f14085` |
| exe SHA256 | `bab39ac743d9d14bc5c7a82070dec480d7849782dce7ce47322e7c60e21afefd` |
| app.asar SHA256 | `d4e5df653b3e740095189ed13a526138d27032baab114fb614fd366775c888eb` |

注：UI 轮 U1–U3（顶栏精简 + 「启动 OpenCode」按钮，`ded5175`/`958d0c1`/`4d11f43`）
完成于 alpha.3 登记**之后**，不在 alpha.3 包内，随 alpha.4 分发。

**未登记的中间构建（勿分发）**：`candidate-20260922045126-a374f2e-8ad1f2/`（含同名 zip）
是 09-22 在版本号 bump 前从 `a374f2e` 试跑的链，`ALL_GREEN` 但包内版本字段仍是
`0.1.0-alpha.3`，未做候选登记、无文档入口；仅作排障现场保留。

### 2.6 历史候选：v0.1.0-alpha.4 正式包（electron-builder，已对外发布）

2026-09-22 由正式链产出（agent 会话跑满全链）、曾为第 1 节当前候选并对外发布的包。
已打 tag `v0.1.0-alpha.4` 并发布到私有仓库 Release（登记见 `docs/alpha-acceptance.md` 9.7）。
**自 2026-09-23 起转为历史**：alpha.5（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.4` |
| buildId | `20260922050618-c48863e-769d1d` |
| 来源提交 | `c48863e0303f854b080abd678174517ea3b226ca` |
| 分发 zip | `candidate-20260922050618-c48863e-769d1d.zip` |
| zip SHA256 | `4b25f17bec96e5ec3c36c5588f04741a63a84ddb0afd02ce3c627658b96469ae` |
| exe SHA256 | `8ed0c00d4a0c1e3cfead7ccd833c57ba918174bccd0ec500ae46b098ae07b97c` |
| app.asar SHA256 | `53970cdb39f133910458a52cc9f9c8d5456d6b7ef6e83c16f411897c79003422` |

注：baseline-drift 轮 B1–B3（`c957272`/`3ee6f0c`/`bca0071`）完成于 alpha.4 登记**之后**，
不在 alpha.4 包内，随 alpha.5 分发——alpha.4 用户「接管后自动更新致基线恒拒」限制
在 alpha.5 前仍然成立。

### 2.7 2026-09-23 ago/ 归档迁移与 robocopy 事故定损（追加，不改写上文结论）

应 jc 要求，全部历史构建（`release/`~`release7/`、`release-dev/`、各
`candidate-*` 目录与 zip/侧车）已迁至 `ago/` 目录归档（本地归档区，已加入
`.gitignore`，不入库）。迁移过程中 agent 的一次后台 robocopy 批量移动因
MSYS2 路径转换规避（`MSYS2_ARG_CONV_EXCL='*'`）导致循环变量未展开，9 个候选
目录被合并写入字面目录 `ago$B` 并按同名后写覆盖先写，`/MOVE` 随即清空源目录
（仅剩被安全软件锁定的 `app.asar`）。**分发链无损，受损的是部分历史目录的
「物理原样保留」**。定损如下（2026-09-23 实盘核验）：

| 目录（现位于 `ago/`） | 迁移后状态 |
|---|---|
| `candidate-20260922050618-c48863e-769d1d/`（alpha.4） | **完整**（83 文件：win-unpacked 79 件 + manifest/build-record/receipt 三件 JSON，buildId 核对一致） |
| `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1/`（手工重封） | **完整**（122 文件，含 4 枚 asar） |
| `candidate-20260916074544-f425ea3-3c455a/` | 151 文件，win-unpacked 与 builder-out 两树互补、各缺对方独有件（unpacked 7 件 / app.asar 1 枚），非事故丢失 |
| `candidate-20260916094710-…`（alpha.1 前置试跑） | 仅剩 2 枚被锁 `app.asar`，其余件丢失 |
| `candidate-20260916114818-8b3b8f8-f4e1c6/`（alpha.1） | 同上，仅剩 2 枚 `app.asar` |
| `candidate-20260918013040-b43dc44-a0a453/`（未登记轮） | 同上（无 zip，独有件丢失最重） |
| `candidate-20260919054633-7eff0b6-7b9983/`（verify-package 拦停轮） | 同上 |
| `candidate-20260919055321-f8bb4fb-e00e50/`（alpha.2） | 同上 |
| `candidate-20260921124125-bd8c2d5-0c200b/`（alpha.3） | 同上 |
| `candidate-20260922045126-a374f2e-8ad1f2/`（未登记试跑） | 同上 |

**哈希核验（certutil 实测，全部与 §2.1、§2.3–2.6 台账一致）**：四代 alpha 的
zip、`app.asar`，及 alpha.4 的 exe；alpha.1–3 的 exe 随目录覆盖丢失，但其
二进制可由在位的对应 zip 重新解出。各 zip 与侧车 `.sha256.txt` 均在位。

**勘正（只追加）**：§2.3–2.6 的「其 manifest、build-record、receipt 与哈希
原样保留，未做任何改写」中，**哈希与登记事实**仍然成立（以本表 + zip +
`docs/alpha-acceptance.md` §9.x 为权威），但 alpha.1–3 及未登记轮的目录内
**物理文件**自本日起不再原样保留。当前候选 alpha.5（第 1 节）完全未受影响，
`--check` 三方核对仍为 `DOC_ENTRY_OK`。

**遗留清理**：①根目录 `ago$B/` 为事故残留（两棵 electron 运行时树 + 2 枚被锁
asar），锁释放后直接删除；②`ago/` 内被锁的旧 `app.asar` 同 §2.2 注，锁释放后
可清。

**教训落账**：Windows 批量移动含 electron 产物的目录，必须先单目录演练并在
目的地点验，再跑循环；`MSYS2_ARG_CONV_EXCL='*'` 下含 `\` 的目标路径字面量
可能静默不展开，首轮必须 `ls` 验证去向；robocopy 返回码「成功」不代表目标正确。

**遗留清理闭环（追加，2026-09-24）**：上述 ①② 已执行完毕——锁已释放，先单文件
试删点验通过，随后删除根目录 `ago$B/` 全部与 `ago/` 内 7 个「仅剩 2 枚被锁 asar」的
事故目录（`094710`、`114818`、`013040`、`054633`、`055321`、`124125`、`045126`，
删前逐目录核数确认各仅 2 文件，与上表一致）。保留件未动：`074544`、alpha.4、
alpha.5、alpha.1 手工重封四目录及其余在位 zip/侧车。本项遗留清零。

### 2.8 历史候选：v0.1.0-alpha.5 正式包（electron-builder，已对外发布）

2026-09-23 由正式链产出（agent 会话跑满全链）、曾为第 1 节当前候选并对外发布的包。
已打 tag `v0.1.0-alpha.5` 并发布到私有仓库 Release（登记见 `docs/alpha-acceptance.md` 9.8）。
**自 2026-09-24 起转为历史**：alpha.6（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.5` |
| buildId | `20260923081342-001342d-30fc1c` |
| 来源提交 | `001342dcf7c03c5c5de7b8ef40c4edac7ce97fe5` |
| 分发 zip | `candidate-20260923081342-001342d-30fc1c.zip` |
| zip SHA256 | `addb45120d265cf7de84d2bace5f7dfbe62404363849b4b914580962086ba1b9` |
| exe SHA256 | `ed0f8595ffb62cca7d2e373f5626336af8badacd2269c720579df914b61456f3` |
| app.asar SHA256 | `743b37bb9a5b3379bfef4ac34950438e879a705608c24d19ff7e82029490a869` |

注：界面信息架构重整 T1–T5（`475c295`…`e6500d5`，2026-09-24 真机观感整体回执）完成于
alpha.5 登记**之后**，不在 alpha.5 包内，随 alpha.6 分发——alpha.5 用户界面上看到的
仍是重整前的三区长布局，行为层无差异。

### 2.9 历史候选：v0.1.0-alpha.6 正式包（electron-builder，已对外发布）

2026-09-24 由正式链产出（agent 会话跑满全链）、曾为第 1 节当前候选并对外发布的包。
已打 tag `v0.1.0-alpha.6` 并发布到私有仓库 Release（登记见 `docs/alpha-acceptance.md` 9.9）。
**自 2026-09-24（同日，alpha.7 登记起）转为历史**：alpha.7（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.6` |
| buildId | `20260924060658-064cc08-cfcc98` |
| 来源提交 | `064cc082ab1d56852f45f6c326310867e09b577f` |
| 分发 zip | `candidate-20260924060658-064cc08-cfcc98.zip` |
| zip SHA256 | `e409984c7fafe775c14b0930d865ce3da620a17ba7a25bbe9090c49444d97bef` |
| exe SHA256 | `91bf018a9b899c96aceb153b053b14703c891ea80a9f58e452e83738a63a2745` |
| app.asar SHA256 | `e682d1f5d240e510bdbcae9422fdf7205c13f46c56d88203ed33bfe349f9ebe8` |

注：界面修复轮 F1–F4（`0694937`…`fa12cd0`：删启动按钮全链、删菜单栏、「自动调整」按钮、
预览与真机观感对齐）完成于 alpha.6 登记**之后**，不在 alpha.6 包内，随 alpha.7 分发——
alpha.6 用户看到的仍是带「启动 OpenCode」按钮与旧预览 mock 的界面，行为层无差异。

### 2.10 历史候选：v0.1.0-alpha.7 正式包（electron-builder，已对外发布）

2026-09-24 由正式链产出（agent 会话跑满全链）、曾为第 1 节当前候选并对外发布的包。
已打 tag `v0.1.0-alpha.7` 并发布到私有仓库 Release（登记见 `docs/alpha-acceptance.md` 9.10）。
**自 2026-09-25 起转为历史**：alpha.8（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.7` |
| buildId | `20260924103659-afdd5dc-c6e390` |
| 来源提交 | `afdd5dcb215d607392fbcef3392baac60ba77623` |
| 分发 zip | `candidate-20260924103659-afdd5dc-c6e390.zip` |
| zip SHA256 | `8fa07a421e3257f4f714f242c3e06ba67b9ca80e643714c05f2938224fef5e49` |
| exe SHA256 | `91078dbc14459ab8b9269a1e8b1a21d6cd4126470cb8008469e2d5799960c60c` |
| app.asar SHA256 | `f8a5bf8b038dd7ef1d671c14e6c21916b3d297830a18aa774863512ae47bcc1e` |

注：观感修复与功能回合 W1–W5（`f97514b`…`2c553cb`：输入框白条、遮罩/面板推导调优、
可读性门软化、启动按钮回归、预览模糊缩比折算）完成于 alpha.7 登记**之后**，
不在 alpha.7 包内，随 alpha.8 分发——alpha.7 用户看到的仍是 W 轮前的推导参数、
无启动按钮与旧预览模糊口径的界面。

### 2.11 历史候选：v0.1.0-alpha.8 正式包（electron-builder，已登记待发布）

2026-09-25 由正式链产出（agent 会话跑满全链）、曾为第 1 节当前候选的包。
已打 tag `v0.1.0-alpha.8` 并推送（登记见 `docs/alpha-acceptance.md` 9.11）；
Release 上传与网页回执补记归 jc，登记时未闭合的「整体观感回执」如实标注在发布说明里。
**自 2026-09-25 起转为历史**：alpha.9（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.8` |
| buildId | `20260925025400-047ce1f-d4519a` |
| 来源提交 | `047ce1f7793ef3869b8f60b475b4a9e276508f2a` |
| 分发 zip | `candidate-20260925025400-047ce1f-d4519a.zip` |
| zip SHA256 | `93c2edc66a5d7032815aec34f02be00bf433f03ce2cfef3035424fec167afb9c` |
| exe SHA256 | `0f168e5de52216bfa0ad864b2d20cdce69022c4415c8c40200a66bcb464756e7` |
| app.asar SHA256 | `5f22903d69fca6ccfe95552d74330b094ae8bc0e3e7025d5553afbdcdf9a45df` |

注：观感修复第二轮 X1–X3（`9f45251`…`9283170`：菜单/弹层不透明深色面、
可读性面板一行结论条折叠、封面标语同源描边）完成于 alpha.8 登记**之后**，
不在 alpha.8 包内，随 alpha.9 分发——alpha.8 用户看到的仍是半透明菜单、
展开态可读性面板与无标语描边的封面。

### 2.12 历史候选：v0.1.0-alpha.9 正式包（electron-builder，已登记待发布）

2026-09-25 由正式链产出（agent 会话首跑即 `ALL_GREEN`）、曾为第 1 节当前候选的包。
已打 tag `v0.1.0-alpha.9` 并推送（登记见 `docs/alpha-acceptance.md` 9.12）；
Release 上传与网页回执补记归 jc，登记时未闭合的「X1/X3 同窗口真机应用验证」与
「整体观感回执」两项如实标注在发布说明里。
**自 2026-09-25 起转为历史**：alpha.10（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.9` |
| buildId | `20260925050329-f2434b8-057575` |
| 来源提交 | `f2434b80887966c70b0cc65fc4289fe3d5ef1905` |
| 分发 zip | `candidate-20260925050329-f2434b8-057575.zip` |
| zip SHA256 | `feeab70c795831709a0f902d9e13d5148fd6e2843eafe97b757a017491a5f692` |
| exe SHA256 | `84df005ab0e1e34d566a94c0d8b6d9593b8067fb170c42d10b3ee3abad851ec2` |
| app.asar SHA256 | `1b240a90bd1dab65fed98b67723d253c2632c83d95465287721838a3e696931c` |

注：封面固定不透明 X3c（`54ba951` 取证更正 + `264c0f0` 实施，含 `session-new-design`
锚点、封面输入框实色底与大字 opacity 钉满，报告新增「封面输入文字」「封面大字标语」
两条目）与本次的 `coverText` 拦停修复都完成于 alpha.9 登记**之后**，**不在 alpha.9 包内**
——alpha.9 用户看到的新布局封面仍是 6.7% 水印式淡字与随滑杆的半透明输入框。

### 2.13 历史候选：v0.1.0-alpha.10 正式包（electron-builder，已登记；Release 补记按决定跳过）

2026-09-25 由正式链产出（首跑被可读性门拦停，`a36c38d` 修复 coverText 后第二跑跑满全链）、
曾为第 1 节当前候选的包。已打 tag `v0.1.0-alpha.10` 并推送（登记见 `docs/alpha-acceptance.md` 9.13）。
**自 2026-09-25 起转为历史**：正式版 `1.0.0`（第 1 节）取代它成为唯一入口；
其 manifest、build-record、receipt 与哈希原样保留，未做任何改写。
Release 网页回执补记按使用者决定跳过（alpha.8/9/10 同此），登记时未闭合的
「X1/X3/X3c 同窗口真机应用验证」与「整体观感回执」两项其后已由使用者回执闭合（2026-09-25）。

| 项 | 值 |
|---|---|
| 候选版本 | `0.1.0-alpha.10` |
| buildId | `20260925064032-a36c38d-3694d2` |
| 来源提交 | `a36c38d03f8c5ac08a273915df9d1f2af321f67c` |
| 分发 zip | `candidate-20260925064032-a36c38d-3694d2.zip` |
| zip SHA256 | `521e2546ff777faebafdb792a89e8e51381066f74f135982d7e9f315c019db35` |
| exe SHA256 | `6811fb0e9bfd23b8dbfb56325fd37c09ac16f8d81d12f8a02dbdca4bbed0feff` |
| app.asar SHA256 | `461e6c8e8d880e2b5b48a37974f55232a8a6cca4cac5e8beaf113bf7272c6c16` |

注：X3c 封面固定不透明与 `coverText` 拦停修复**都在 alpha.10 包内**；
第 1 节的 `1.0.0` 相对它功能零改动（仅版本号与文档），无需从本包升级的用户动任何东西。

## 3. 当前门禁结果（buildId `20260925081334-0160900-e4b156`）

以下数字**只属于第 1 节那一个候选**，取自其 `build-record.json`；
包有改动必须重建并更新第 1 节哈希，旧数字不作数。

| 命令 | 退出码 | 耗时 | 结果 |
|---|---|---|---|
| `npm run typecheck` | 0 | 11.6s | 通过 |
| `npm run lint` | 0 | 30.2s | 通过 |
| `npm run test:unit` | 0 | 18.1s | 通过（见文末数量注） |
| `npm run build` | 0 | 13.6s | 通过 |
| `npm run test:integration` | 0 | 80.9s | 通过 |
| `npm run test:e2e` | 0 | 55.7s | 通过 |
| `npm run test:e2e:electron` | 0 | 23.3s | 通过 |
| `npm run audit` | 0 | 1.4s | FAIL 0 / WARN 0 |
| `npm run dist` | 0 | 72.3s | 通过 |
| `npm run smoke:gui` | 0 | 20.9s | 通过 |
| `npm run verify-package` | 0 | 1.5s | 通过 |
| `zip`（链内步骤） | 0 | — | 通过 |

注：上表「结果」只记通过与否，**具体测试数量以该次构建的原始日志为准**，
不在本文另抄一份（抄写必然滞后，正是本文件此前出错的成因）。

注（本轮执行环境与验收口径，2026-09-25）：本链由 **agent 会话**跑出，**首跑即一次
跑满 12 步全绿、无拦停轮**（alpha.10 轮的 coverText 修复在本候选源码内，其
`test:integration` 真 Electron 闭环因此正常通过）；`smoke:gui` 默认参数为空（与双击等价）
并通过（20.9s），`test:e2e:electron` 亦在本轮真实通过（23.3s），延续「以每次链运行的真实
退出码为准」口径（alpha.5–10 轮同此）。发布级只读终检 18 项 0 失败、
`RELEASE_GREEN`、`publishable=true`。**验收闭合口径（与 alpha 轮的差异）**：
X1/X3/X3c 同窗口真机应用验证（含「封面大字颜色随亮/暗壁纸自适应」项）与
W1–W5/X1–X3c 整体观感回执已由使用者回执确认（2026-09-25，「通过」并明确覆盖真机项）；
alpha.8/9/10 的 Release 网页回执补记按使用者决定跳过、不再挂账；A6 干净环境仍按决定跳过，
平台声明维持「仅开发机 Windows x64 验证」窄口径。

一条命令跑全链（`bash tools/release-gate.sh` 是薄入口，任一步非 0 即停）：

```bash
# 全链构建 + 打包 + 登记 + 核验（buildId 省略时自动生成）
bash tools/release-gate.sh build

# 只读核验既有候选：必须显式绑定 manifest 与候选目录，且须与 buildId 推导一致
GATE_MANIFEST=candidate-<buildId>/candidate-manifest.json \
GATE_CANDIDATE_DIR=candidate-<buildId>/win-unpacked \
GATE_BUILD_ID=<buildId> bash tools/release-gate.sh verify
```

缺绑定或绑定与 buildId 推导不一致时**在核验前即失败关闭（exit 2）**，
**不回落根目录 `candidate-manifest.json`**。
`npm run verify:package` 只是**旧候选身份核验**（磁盘与登记一致），
通过它不代表当前源码已通过发布验收。
`npm run verify` 不含 `test:e2e:electron` / `audit` / `dist` / `verify:release` ——
**不能只跑 verify** 就宣称全部门禁通过。

## 4. 文档索引

| 文件 | 内容 |
|---|---|
| `docs/alpha-acceptance.md` | **Alpha 验收记录**（候选标识、A1–A8 逐项，未执行一律「待执行」） |
| `README.md` | 定位、支持范围、使用步骤、恢复语义、风险、常见报错、已知限制 |
| `docs/security.md` | 信任边界、写入范围、事务安全、备份语义、输入安全、隐私 |
| `docs/compatibility.md` | 官方主题机制取证与路线选择 |
| `docs/architecture.md` | 分层、契约、事务与恢复模型 |
| `docs/discovery.md` | 目标归档只读取证 |
| `docs/original-evidence.md` | 出厂指纹登记方式（当前指纹表为空） |
| `docs/portable-verify.md` | 干净环境验证清单 |
| `docs/acceptance.md` | 历史轮次的命令与证据记录 |
| `CHANGELOG.md` | 分阶段变更记录 |

## 5. 发布前的硬性提醒

- 不要把它说成「官方功能」，也不要声称「已签名」——当前没有代码签名证书。
- 不要教用户关闭安全软件，也不要把所有拦截都称为误报。
- 必须对外说明的三件事：**只验证过 OpenCode Desktop 1.18.29**、
  **应用与恢复后都需要完全重启才看得到效果**、**没有出厂指纹证据时不承诺回到出厂状态**
  （可用的诚实入口是「恢复上一主题」与「恢复到首次接管时」）。
- 分发内容：整目录 zip + SHA256 + 已知限制 + 兼容范围 + 使用与恢复说明 + 反馈模板。
- 公开仓库、上传安装包、发文都需要单独授权；本清单不代表已获授权。
