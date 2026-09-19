# Alpha.2 发布执行计划（2026-09-19）

> 状态：**待执行**。前置背景：`v0.1.0-alpha.1` 已发布（09-18，tag + 私有仓库 Release）。
> alpha.2 的实质增量：UI 精修（`ebcf370`，renderer only）+ 包内 LICENSE（抹掉 alpha.1 已知限制）。
> 本机结构性阻塞：smoke:gui 空参数必崩（G1，无独立 GPU 进程）→ 完整门禁与 GUI 验证
> **必须在一台有显示会话的 Windows 机器上执行**。本机可且只可做「不依赖显示会话」的准备工作。

## 执行原则

1. **一项一提交**，与 handoff 既有计划一致。
2. **门禁语义不变**：候选登记前必须完整链真实退出 0（含 smoke:gui 空参数）；
   `--skip-gui` 产物永远不可发布；诊断模式参数不进默认配置。
3. **哈希只在一处维护**：发布清单的机器可核对块由 `tools/doc-candidate-entry.cjs`
   生成并 `--check`，任何文档不得手抄哈希。
4. **A5 需 jc 当次授权与真机参与**（保存工作、完全退出 OpenCode 是前置），不预填成功。
5. 本机窗口内禁止跑 `npm run dist` 全链（会在 smoke:gui 烧掉一轮时间）；
   准备项用 typecheck/lint/unit 验证即可。

## 任务分解

### A2-1（本机，现在可做）：发布准备三项

1. `package.json` version `0.1.0-alpha.1` → `0.1.0-alpha.2`；
2. `build.files` 增加项目根 `LICENSE`（消除 alpha.1 分发说明里「包内无 LICENSE」的限制，
   后续候选 zip 内可见）；
3. 新建 `docs/release-notes-0.1.0-alpha.2.md`（草稿：相对 alpha.1 的变更 = UI 精修 +
   包内 LICENSE；已知限制如实继承：未签名、A6 待验、P3 色块缺陷）。

**验收**：`npm run typecheck` / `lint` 0；unit 全绿；`npm run dist -- --dir`
（只出 win-unpacked 不打包）后 asar 顶层可见 `LICENSE` 且条目数 +1。
**提交一个**：`chore(release): alpha.2 准备——版本号、包内 LICENSE、release notes 草稿`。

### A2-2（显示会话机器）：重建候选 + 完整门禁

> **2026-09-19 修订**：「显示会话机器 = 另一台机器」的前提被实证推翻——崩溃仅属
> agent 自动化会话，jc 本机**桌面 cmd 会话**即可跑全链。A2-2 已按本节要求在本机
> 完成（`ALL_GREEN buildId=20260919055321-f8bb4fb-e00e50`，空参数 smoke:gui 真过），
> 证据见 `handoff/alpha2-release-evidence/`。下文保留原文以维持计划可追溯。

1. 同步仓库到 A2-1 提交（clone 或打包工作树，排除 `node_modules`/`out`/`release*`，
   目标机 `npm ci` + `npm run build`）；
2. 按 `docs/release-checklist.md` 跑完整链：typecheck → lint → unit → build →
   integration → e2e → e2e:electron → audit → dist（**空参数 smoke:gui 必须真过**，
   这是与 alpha.1 候选构建的本质区别：验证「正常配置能起 GUI」这一条）；
3. 全绿后打包 zip + sha256 + `candidate-manifest.cjs register --pack-method electron-builder`；
4. `verify:release` 只读核验；`doc-candidate-entry.cjs --check` 机器核对。

**验收**：`ALL_GREEN` 真实输出一次；manifest `publishable=true`；核验 0 问题。
**提交一个**：`chore(release): alpha.2 候选 <buildId> 登记`（证据归档
`handoff/alpha2-release-evidence/`）。
**失败处置**：若 smoke:gui 在目标机也崩 → 停，回读证据，判目标机环境；不得降级为 skip-gui 发布。

### A2-3（显示会话机器，与 A2-2 同窗口）：A5 快速复验 + T65 干净环境

- **A5（需 jc 授权）**：正常启动换肤助手 → 导入图片 → 应用 → 完全退出并重启
  OpenCode → 视觉检查（**重点多看一眼新 UI 的拖放区与滑杆在真机的渲染**）→ 恢复。
  取证到 `handoff/alpha2-release-evidence/a5-round-<date>.md`。
- **T65 合并**：在该机对新装 OpenCode 跑一次 `node tools/version-probe.cjs --discover --json`，
  作为干净环境适配流程的首次完整走通（probe → 真机闭环 → 白名单流程验证，不必真加版本）。

**验收**：A5 证据齐（不预填结论）；probe 报告归档。
**提交一个**：`docs(acceptance): alpha.2 A5 复验证据 + T65 干净环境记录`。

### A2-4（等 jc 签核）：发布

1. jc 明确批准（目标、版本 `0.1.0-alpha.2`、内容 = A2-2 候选）；
2. tag `v0.1.0-alpha.2`（带注释，含 buildId 与 zip SHA256）；
3. 发布物三件：zip、`.sha256.txt`（**这轮必须先生成再上传**，不重蹈 alpha.1
   「引用了不存在的随附文件」的偏差）、release notes 定稿；
4. `alpha-acceptance.md` 追加 9.5 发布执行记录；Release 上传渠道由 jc 指定。

**验收**：匿名/可见性核验口径与 alpha.1 一致（私有仓库 404 属预期，以 jc 回执为准）。
**提交一个**：`docs(acceptance): alpha.2 发布执行落账`。

## 时序与依赖

```
本机窗口（现在）          显示会话窗口（需 jc 安排机器）
─────────────            ─────────────────────────────
A2-1 准备 ───────────→  A2-2 重建+门禁 ──→ A2-3 A5/T65 ──→（等签核）A2-4 发布
```

- A2-1 是唯一不依赖外部条件的任务，**建议现在就做**——做完后显示会话窗口只需
  一次性执行 A2-2/A2-3，窗口时长从「半天+」压到「1–2 小时」。
- A2-2 与 A2-3 同窗口（同机同候选，避免二次环境搭建）。
- A2-4 严格在 A2-2 全绿 + A2-3 A5 通过 + jc 签核三者齐备后。

## 明确不做

- 不在本机跑完整链刷时间；不把 `--in-process-gpu` 写入任何默认配置；
- 不顺手改 `supportedVersions`（白名单更新仍走 probe → 真机闭环 → 人工提交）；
- 不为 alpha.2 新增功能范围（纯发布轮，UI 精修与 LICENSE 是全部增量）。

## 执行记录

| 项 | 提交 | 结果 |
|---|---|---|
| A2-1 | `f37b10c` | 本机完成：version→`0.1.0-alpha.2`（lock 同步）；`build.files` 加 `LICENSE`，对照构建坐实 asar 顶层条目 1061→1062 恰 +1、包内文本哈希前缀与仓库 LICENSE 一致（069e1cf1…）；release notes 草稿落 `docs/release-notes-0.1.0-alpha.2.md`（哈希块留待 A2-2 生成）。验收：typecheck/lint 0、unit 321/321、`dist --dir` 正常出包 |
| A2-2 | `6154fc0`（准备）→ `7eff0b6`/`f8bb4fb`（拦停修复）→ `ca90e48`+`a607e72`+`76cd056`+`2c0188a`+`4fd7e5f`（落账） | **本机完成，换机取消**。准备物：`MACHINE-WINDOW.md` 一条龙清单。执行：jc 桌面 cmd 会话手动跑 `npm run release:build`，三轮——第 1 轮停 `test:unit`（编码自检误扫 `release-dev/LICENSES.chromium.html`，修 `7eff0b6`）、第 2 轮停 `verify-package`（顶层白名单缺 LICENSE，修 `f8bb4fb`）、第 3 轮 `ALL_GREEN buildId=20260919055321-f8bb4fb-e00e50`（空参数 smoke:gui 真过 21.1s；登记后 `RELEASE_GREEN`、`publishable=true`；侧车先生成）。落账：doc 入口 `--check` 通过、release-checklist §1/§2.3/§3、alpha-acceptance §5.0、acceptance §8.1 G1 修订、证据归档 `handoff/alpha2-release-evidence/` |
| A2-3 | 本提交（证据入库随本轮唯一提交） | **完成（2026-09-19，本机桌面会话，jc 当次授权）**：A5 快速复验判定通过——基线 `e6957841…`（会话外 alpha.1 目录包 apply，如实登记）→ A/B/C 各 14 项核验 0 失败+包内哈希==源文件 → no-op 复用同 op → 恢复三步全过（original 预期 `BACKUP_MISSING`；takeover 回 `1c53ca24…`）→ 收尾检查 jc 整体回执「通过」，最终停留无主题。新增 P2 占位符可读性缺陷登记（非回归，不进本候选，立后续轮）；偏差两次（含一次裸 restore，FILE_LOCKED 兜住）。T65：probe 7/7 PASS 完整 JSON 入库，「本机非干净环境」限制如实登记。证据 `handoff/alpha2-release-evidence/a5-round-20260919.md` |
| A2-4 | — | 待 A2-3 通过 + jc 签核（A2-2 已全绿） |
