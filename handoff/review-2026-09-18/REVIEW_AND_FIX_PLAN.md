# 2026-09-18 复审：问题清单与修复计划

审查基线：`acdd659`（F1–F4 已全部落地并归档）；工作树干净（0 未提交源码改动）。
审查方式：静态代码核对 + 机器核对命令实跑 + 交叉对照 09-16/09-17/09-18 三轮证据。
本轮**未改任何产品代码**，只产出本报告。

## 一、结论

F1–F4 修复质量经复核全部成立，两项 09-16 遗留（zip 目录条目口径、e2e 有界重试）也已在
后续提交（`a6154d1`、R6）中修掉、本轮核销。**剩余问题共 5 项：1 项环境决策（G1）、
2 项编排/默认值不一致（G2、G3）、1 项发布脚手架脚枪（G4）、1 项可选诊断增强（G5）。**
无新发现的产品业务缺陷；当前阻断新候选产出的唯一原因是 G1（本机 GPU 环境）。

## 二、本轮核验过的证据

| 检查 | 结果 |
|---|---|
| `git status --short` | 0 行，工作树干净 |
| `node tools/doc-candidate-entry.cjs --manifest candidate-20260916114818-8b3b8f8-f4e1c6/... --check` | 退出 0，文档/manifest/磁盘三者一致（F1 机制仍有效） |
| `tools/verify-release.cjs` 目录条目处理（`checkZipMatchesDir` :775–800） | 09-16 遗留 #6 已修：显式目录条目须磁盘实存，不再误报 |
| `tests/e2e/theme-switcher.spec.ts:206–229` | 09-16 遗留 #2 已修（R6）：有界轮询断言 + 超时诊断 |
| `tools/smoke-packaged.cjs` | F2/F3 在位：`DEFAULT_ARGS=[]`、`launchConfig()`、`settleMs=1500`、诊断模式不构成发布资格 |
| `handoff/review-2026-09-17/evidence/f4-candidate-attempt.md` | 09-18 两次构建尝试的完整取证（safe-delete 配额 / GPU FATAL） |

## 三、问题、修复步骤、验收条件

### G1 / P1：smoke:gui 正常配置在本机结构性不可验证 → 新候选无法登记

**事实**（09-18 取证，`f4-candidate-attempt.md`）：
- 本会话无可用独立 GPU 进程：新旧候选空参数 spawn 同样崩（exit 0x80000003，GPU FATAL）；
  仅 `--in-process-gpu` 系参数能起窗口。
- 发布链第 2 次（`20260918013040-b43dc44-a0a453`）测试链全绿（unit 313 / integration 179 /
  e2e 16 / e2e:electron 全 OK / audit / dist），只停在 smoke:gui。
- 新候选只到 `win-unpacked`，未 zip、未登记；`ALL_GREEN` 未产出（且不应人为补上）。

**修复计划**（处置而非改代码——把 workaround 塞回默认参数会重演 F2 要修的错误）：

1. `docs/acceptance.md` 增「本机环境前提与不可验证项」：登记
   「无显示会话/独立 GPU 进程的机器上 smoke:gui 空参数必然失败，属环境限制」；
   `--in-process-gpu` 只是已文档化的**诊断模式前提**（现有 `--diagnostic-gpu` /
   `--diagnostic-degraded`），**不得**进入默认参数。
2. GUI 正常配置验收移到**有显示会话的机器**执行（与既有 T65 干净环境验证合并，一次跑完）。
3. 新候选 `20260918013040` 处置二选一（用户决策）：
   - **(i) 推荐**：在有显示会话的机器重跑完整链 → 真实 `ALL_GREEN`；
   - (ii) 本机 `--skip-gui` 跑 `DEV_BUILD_COMPLETE`（现有机制，`releaseEligible=false`，
     仅验证链路，不可发布、不更新当前候选入口）。

**验收**：docs 有登记且措辞不含「已验证」；默认参数仍为空数组；`ALL_GREEN` 只在链真实
通过后输出一次。

### G2 / P2：test:e2e / test:e2e:electron 不传 testEnv()，与 unit/integration 不一致

**定位**：`tools/release-build.cjs:524–525`（无 `env`）对比 `:479`、`:519`（`env: testEnv()`）。
09-16 已用 `tools/e2e-chain-repro.cjs` 取证：e2e 步骤实际继承外层 TEMP。
`tests/e2e/theme-switcher.spec.ts:99` 的 fixture 用 `os.tmpdir()` mkdtemp —— 即外层 TEMP，
本机外层 TEMP 在项目盘，与「项目盘 TEMP」已知坑同源；且 e2e 紧跟 integration 之后跑，
正是 09-16 观察到间歇目标发现失败的拥挤窗口。

**修复计划**：给两个 e2e 步骤补 `env: testEnv()`，与 integration 同策略；若判定刻意不传
（理由写明），则在 `release-build.cjs` 加注释并在 `tools/test-release-gate.cjs` 补编排断言。
倾向前者——两处行为不一致本身没有成立的理由。

**验收**：`node tools/e2e-chain-repro.cjs` 显示 e2e 步骤拿到与 integration 相同的 TEMP 根；
门禁测试新增断言通过。

### G3 / P2：临时根默认落项目盘，与本机已证行为矛盾

**定位**：`tools/r5-run-suite.cjs:388–391`、`tools/release-build.cjs:92`——默认
`node_modules/.cache/ots-test-tmp`（项目盘）。本机已证「TEMP 落项目盘 → vitest 跑完不
退出 → 稳定触顶 9min SIGTERM」（09-16 实测：改 `OTS_TEST_TMP` 到系统根后 13s 全绿；
09-18 两次尝试也是靠外部设置 `OTS_TEST_TMP` 才过）。默认值让任何不设环境变量的新会话
必然踩坑。

**修复计划**：默认根改为**系统临时根下唯一子目录**（`os.tmpdir()` + `ots-<runId>`），
保留 `OTS_TEST_TMP` / `--tmp` 覆盖；两处（wrapper 与 `testEnv()`）同步改。
系统根下的 `*.asar` 间歇 EBUSY 是既有基线（与当前树同量级），按既有约定判环境、不修。
**注意**：这是行为变更，改完需实跑 `r5-run-suite.cjs run tests/unit` 验证不回归。

**验收**：不设任何环境变量跑 unit 套件正常退出；单测覆盖默认根推导；项目盘默认路径
从代码中消失。

### G4 / P3：`npm run dist` 会写进历史手工候选目录，存在覆盖归档证据的脚枪

**定位**：`package.json` `build.directories.output = "candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1"`；
根目录 `candidate-manifest.json`（legacy，`manual-repack-20260912`）指向该目录下的
`win-unpacked.new`。F1 刚把这些归档为「历史证据、不作为本次发布候选」——但任何人跑一次
`npm run dist`（它还先跑 `npm run build`）就会把构建产物写进同一目录，覆盖历史文件。
目录内现有 `win-unpacked` / `win-unpacked-fresh` / `win-unpacked.new` 三个变体，同源性已不可辨。

**修复计划**：
1. `build.directories.output` 改成中性名（如 `release-dev/`），与候选目录彻底解耦；
   正式链不受影响（`release-build.cjs:558` 用 `--config.directories.output` 显式覆盖）。
2. 历史候选目录移入 handoff 归档或改名加日期后缀（**移动前列哈希清单，事后 `--check` 验证
   根 manifest 仍指向有效路径**；根 manifest 路径若失效，同步更新并在文档登记迁移记录）。
3. README 的 dist 说明处标注「候选一律走 `npm run release:build`，`npm run dist` 仅开发自用」。

**验收**：`npm run dist`（干跑或检查输出路径）不再写历史候选目录；历史 manifest 哈希未被改写。

### G5 / P4（可选）：discoverTargets 主进程侧无持久诊断日志

**现状**：`scanned` / `rejected`（含 code/message/recoveryHint）已回传 renderer
（`target-service.ts:60`），e2e 超时也能从 UI 收集诊断（R6）；缺的只是主进程逐候选根的
一次性日志。09-16 遗留 #4 的一半。

**修复计划**：低优先。仅当 e2e 间歇失败再现时实施：在 `TargetService.discover()` 失败路径
（targets 为空）打印候选根列表 + scanned + inspectRoot 失败码，一次会话一条。

## 四、明确不修的（环境类，已有定性）

| 项 | 定性 | 处置 |
|---|---|---|
| safe-delete 轮次配额（305/300） | 环境（轮次级计数，换轮次即恢复） | 遇到换一轮再跑，不改代码 |
| 无独立 GPU 进程 | 环境（结构性，见 G1） | G1 文档登记 + 换机器验收 |
| 系统 Temp 下 `*.asar` EBUSY | 环境（与基线同量级） | 按既有约定判环境 |
| 09-16 遗留 #3（background-cascade 与 theme-switcher 拆 worker） | 已被 R6 有界重试覆盖，workers=1 本就串行 | 关闭 |

## 五、最小实施顺序（一项一提交）

1. **G3 + G2**：同一次编排修正（先 G3 默认根，后 G2 e2e env），各一提交；
   每步跑 `node --check` / 相关单测 / `node tools/test-release-gate.cjs`；
   G3 需实跑 unit 套件验证不回归。
2. **G4**：改 `build.directories.output` + 归档历史候选目录（先哈希清单后移动）+ README 标注。
3. **G1**：docs 登记环境前提与不可验证项（纯文档，一提交）。
4. **等用户决策 G1.3**：有显示会话机器重跑完整链（推荐），或本机 `--skip-gui` 开发构建。
   在此之前**不**动 `candidate-20260918013040` 的未登记状态，**不**回写任何旧记录。

## 六、核验命令（本报告的复核方式）

```bash
node tools/doc-candidate-entry.cjs --manifest candidate-20260916114818-8b3b8f8-f4e1c6/candidate-manifest.json --check
node tools/e2e-chain-repro.cjs   # G2 的取证复跑
grep -n "testEnv()" tools/release-build.cjs   # :479/:519 有、:524-525 无 → G2
grep -n "ots-test-tmp" tools/r5-run-suite.cjs tools/release-build.cjs   # G3
```

报告基线 `acdd659`；G2/G3/G4 修复后基线前移，本文件结论不随之改写，只追加。

## 七、执行记录（2026-09-18 当日实施）

| 项 | 提交 | 验收结果 |
|---|---|---|
| G3 | `f52b244` | 默认根改 `os.tmpdir()/ots-<runId>`；wrapper 导出 `resolveTmpRoot` 并补单测；不设任何环境变量实跑 unit 314 全绿、12s 正常退出 |
| G2 | `30a0a2d` | e2e 两步补 `env: testEnv()`；`e2e-chain-repro.cjs` 改为复用真实 `testEnv`；门禁新增场景 13（npm 桩端到端捕获 TEMP，断言不继承外层哨兵值）；完整取证链 unit/integration/e2e/e2e:electron 全 0，四步同根不同 `ots-*` 目录 |
| G4 | `6a8c6b8` | `build.directories.output=release-dev` + `.gitignore` + README 标注；历史 zip/sha256 清单加 `-archived-20260918` 后缀，根 manifest 同步 zip 路径并追加迁移登记；exe/asar/zip 哈希改名前后复算一致。**挂起**：目录本体改名 EPERM（锁定叶子为各 `resources/app.asar`，安全软件持久锁，属第四节环境类）——收尾命令见 `handoff/review-2026-09-18/evidence/g4-archive-migration.md` §3；`npm run dist` 按「检查输出路径」方式核验，实跑因当轮自动化策略未执行 |
| G1 | `1905fc4` | `docs/acceptance.md` 新增第 8 节；措辞无「已验证」；`DEFAULT_ARGS` 仍为空数组；F1 机器核对 `DOC_ENTRY_OK` 复跑通过 |
| G5 | — | 按计划保持低优先，未实施（e2e 间歇失败未再现） |

**待用户决策（G1.3）**：候选 `20260918013040-b43dc44-a0a453` 的处置二选一
（有显示会话机器重跑完整链 / 本机 `--skip-gui` 开发构建）。决策前保持其未登记现状。

## 八、Alpha 发布就绪评估（2026-09-18 下午追加）

### 8.1 核实过的事实

| 项 | 结果 |
|---|---|
| G1–G4 执行 | 已提交（`f52b244`/`30a0a2d`/`6a8c6b8`/`1905fc4`），验收记录见上表 |
| `git diff 8b3b8f8..HEAD -- src/ out/` | **零变动**——登记候选 `20260916114818-8b3b8f8-f4e1c6` 的产品二进制与当前源码同源；后续提交全部是工具/文档/测试 |
| 当前候选发布级核验 | 09-17 复核 RELEASE_GREEN（18 项 0 失败），F1 机器核对本日复跑通过 |
| 候选包内 LICENSE | **坐实缺失**：asar 顶层仅 `package.json`/`out/**`/`node_modules/**`（依赖自带各自 LICENSE）；`build.files` 列表没有项目根 `LICENSE`。A7 的疑问现在有确定答案 |
| A8 现状 | 仍为 **NO-GO**，但其理由 2（F2/F3/F4 待修）已过时，需刷新 |

### 8.2 剩余问题（发布前清单）

| 级 | 项 | 说明 |
|---|---|---|
| **P1** | A5 真实安装闭环 | 唯一硬缺口。需用户当次授权：正常启动（空参数）→ 导入→应用→重启→视觉检查→恢复。同时补上「正常配置 GUI 启动」证据（一石二鸟） |
| P2 | A8/A7 文档过时 | F2/F3/F4 已修未回写；A7 的「LICENSE 未核验」可落定（缺失，发布说明如实声明） |
| P2 | 包内无项目 LICENSE | 本次候选不改（改 `build.files` 须重建候选，而重建被 GPU 环境挡住）；下次重建时加入。分发时以随附文本（仓库/发布页 LICENSE + zip 内 electron/chromium 自带许可）满足 MIT 要求，说明措辞不得称「包内附带」 |
| P3 | 演示素材未拍摄 | A7 待执行项；alpha 可后补或由用户豁免 |
| P3 | 隐私处置清单待确认 | 10 个跟踪文件含本机路径、49 个提交为个人邮箱——**只分发 zip 时均不在包内**（zip 只有 out/asar/node_modules）；若连仓库一起公开才需处置 |
| 环境 | G4 目录改名 EPERM | 安全软件锁 `app.asar`；收尾命令在 evidence，不阻塞发布 |

### 8.3 结论：差 A5 一步

**不能今天就发，但缺口已收敛到唯一一项（A5）。** NO-GO 的三类理由中：
缺证据类只剩 A5（A6 已按用户决定跳过、按已知风险处理）；待修类（F2–F4、G1–G4）全部
落地；历史结论不可继承类中，A3 由自动化测试覆盖、A7 已可落定措辞。

两条路径：
- **方案 A（正式 alpha，推荐）**：授权走 A5 → 通过后刷 A8 → GO → 分发
  `candidate-20260916114818-8b3b8f8-f4e1c6.zip` + `.sha256.txt` + release notes。
- **方案 B（受限内测）**：按 A8 允许的「受控展示或内部测试」先行分发，分发说明如实
  列明 A5 未执行、包内无 LICENSE、未签名。

### 8.4 修复计划（最小顺序）

1. 刷 A8/A7 文档（一提交）：F2–F4/G1–G4 已修回写、LICENSE 核验落定、A5 前的 NO-GO 理由收敛为单项。
2. **A5 执行**（需用户授权与参与，我方全程取证记录到 alpha-acceptance.md，不预填成功）。
3. A5 通过 → A8 GO → 用户批准发布目标、版本与内容 → 分发。
4. 不阻塞本次 alpha 的后续项：有显示会话机器重建候选（`build.files` 加 `LICENSE`）+
   T65 干净环境验证；演示素材按需补拍。

### 8.5 执行记录（2026-09-18 当日，8.4 步 1）

| 项 | 结果 |
|---|---|
| 刷 A7/A8 文档 | 已完成（纯文档一提交）：`docs/alpha-acceptance.md` 第 8 节 LICENSE 行追加「[落定 2026-09-18]」（包内缺失坐实：asar 顶层清单 + `build.files` 实测不含，分发措辞不得称「包内附带」，下次重建加入）；第 9 节 A7 行同步指向落定注明；新增 9.1 更新段——理由 2（F1–F4）与 G1–G4 已落地、理由 3 收敛、NO-GO 缺口收敛为 A5 单项，**A8 结论保持 NO-GO 未刷** |
| 核对 | `git diff 8b3b8f8..HEAD -- src/` 为 0 行（9.1 声明属实）；F1 机器核对 `DOC_ENTRY_OK` 复跑通过；本次更新未执行任何新验证、未改任何候选产物 |
| 8.4 步 2（A5 执行） | 待用户授权与参与，未开始 |
| 8.4 步 3（A8 GO → 分发） | 依赖步 2，未开始 |
| 8.4 步 4（重建加 LICENSE / T65 / 素材） | 需有显示会话的机器，本机暂缓 |
