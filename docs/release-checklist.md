# 交付清单

Alpha 候选版本用 `docs/alpha-acceptance.md` 记录逐项验收；本文件只回答两件事：
**当前该用哪个包**、**发布前必须核对什么**。

## 1. 当前候选（Alpha）

版本 **`0.1.0-alpha.3`**（Windows x64），由 `npm run release:build` 的正式发布链产出
（`packMethod: electron-builder`，**可重复构建**）。本轮为 agent 会话一次跑满全链（见 §3 注）。

下面这段是本文件的**唯一权威入口**，由 `tools/doc-candidate-entry.cjs` 从选中
manifest 加磁盘实算生成：

<!-- CURRENT-CANDIDATE:BEGIN -->
buildId: 20260921124125-bd8c2d5-0c200b
sourceCommit: bd8c2d50802aceab189b41ded457101e0ed9ff28
schema: candidate-manifest/3
packMethod: electron-builder
manifest: candidate-20260921124125-bd8c2d5-0c200b/candidate-manifest.json
candidateDir: candidate-20260921124125-bd8c2d5-0c200b/win-unpacked
zip: candidate-20260921124125-bd8c2d5-0c200b.zip
zipSha256: 7b953fc8f9571230cb8668fbedae066a50f6bd6a0078fc30b1446ea5d9f14085
exeSha256: bab39ac743d9d14bc5c7a82070dec480d7849782dce7ce47322e7c60e21afefd
asarSha256: d4e5df653b3e740095189ed13a526138d27032baab114fb614fd366775c888eb
<!-- CURRENT-CANDIDATE:END -->

| 文件 | 大小 | 说明 |
|---|---|---|
| `candidate-20260921124125-bd8c2d5-0c200b.zip` | 127.2 MB | 分发以 zip 为准（82 条目，整目录压缩） |
| ├ `OpenCodeThemeSwitcher.exe` | 193.3 MB | 未签名 |
| └ `resources/app.asar` | 17.7 MB | 968 条目 / unpacked 7 |

候选身份由 `release-receipt/1` 与 `build-record/2` 绑定同一 buildId 与源码提交；
`build-record` 的 12 项必检（`typecheck`、`lint`、`test:unit`、`test:integration`、
`build`、`test:e2e`、`test:e2e:electron`、`audit`、`dist`、`smoke:gui`、
`verify-package`、`zip`）全部 `passed`，`releaseEligible=true`。

**核对方式（不靠人眼比对）**：

```bash
node tools/doc-candidate-entry.cjs \
  --manifest candidate-20260921124125-bd8c2d5-0c200b/candidate-manifest.json --check
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

## 3. 当前门禁结果（buildId `20260921124125-bd8c2d5-0c200b`）

以下数字**只属于第 1 节那一个候选**，取自其 `build-record.json`；
包有改动必须重建并更新第 1 节哈希，旧数字不作数。

| 命令 | 退出码 | 耗时 | 结果 |
|---|---|---|---|
| `npm run typecheck` | 0 | 8.1s | 通过 |
| `npm run lint` | 0 | 6.6s | 通过 |
| `npm run test:unit` | 0 | 9.6s | 通过（见文末数量注） |
| `npm run build` | 0 | 8.9s | 通过 |
| `npm run test:integration` | 0 | 60.9s | 通过 |
| `npm run test:e2e` | 0 | 35.3s | 通过 |
| `npm run test:e2e:electron` | 0 | 3.7s | 通过 |
| `npm run audit` | 0 | 1.3s | FAIL 0 / WARN 0 |
| `npm run dist` | 0 | 61.8s | 通过 |
| `npm run smoke:gui` | 0 | 26.4s | 通过 |
| `npm run verify-package` | 0 | 1.5s | 通过 |
| `zip`（链内步骤） | 0 | <1s | 通过 |

注：上表「结果」只记通过与否，**具体测试数量以该次构建的原始日志为准**，
不在本文另抄一份（抄写必然滞后，正是本文件此前出错的成因）。

注（本轮执行环境与 smoke:gui 语义，2026-09-21）：本链由 **agent 会话**一次跑满，
无拦停轮；`smoke:gui` 默认参数为空（与双击等价）并通过。这把 `docs/acceptance.md` §8.1
「仅 agent 自动化会话不可跑该步」的结论修订为**会话环境相关**——
Electron 步骤能否跑以每次链运行的真实退出码为准，不再预设「agent 会话必崩」；
真机 GUI 视觉观察仍归 jc（机器退出码证明不了观感）。

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
