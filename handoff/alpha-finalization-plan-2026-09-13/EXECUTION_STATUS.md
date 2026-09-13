# Alpha 发布收尾 · 执行状态记录

计划：`ALPHA_IMPLEMENTATION_PLAN.md`（本目录）。方案编写完成不代表任务完成；
本表由实施者按实际执行填写：每步填命令、退出码、证据、提交/来源，未执行保持未执行。

| 阶段 | 状态 | 来源提交/buildId | 命令与退出码 | 证据位置 | 负责人/时间 |
|---|---|---|---|---|---|
| P0 基线与保护 | **完成**（无代码改动，故无独立提交） | 基线 `eed1f45` | `git log`/`git status` → 0；`node tools/candidate-manifest.cjs check` → 0 | 下方「P0 明细」；`archive/out-871703d-before-refresh.tar.gz` | agent / 2026-09-13 22:2x |
| P1 清单规范及真实调用测试 | 待执行 | — | — | — | — |
| P2 新登记与冻结分离 | 待执行 | — | — | — | — |
| P3 完整发布链与双重校验 | 待执行 | — | — | — | — |
| P4 新候选构建与GUI冒烟 | 待执行 | — | — | — | — |
| P5 真实安装闭环 | 等待当次授权，未执行 | — | — | — | — |
| P6 材料与GO/NO-GO | 待执行 | — | — | — | — |

## P0 明细（2026-09-13）

- **基线提交**：`eed1f45`（master，提交主题「验收记录补充第二轮审查修复 S1–S6…」）。
- **工作树**：仅 3 个未跟踪目录 `handoff/alpha-finalization-plan-2026-09-13/`、`handoff/review-2026-09-13-r2/`、`handoff/review-2026-09-13/`（计划与取证文档）；已跟踪文件无改动。未使用 `git reset --hard`、批量还原或强制删除。
- **旧候选身份（留存，禁止冒充最新）**：schema `candidate-manifest/1`，buildId `manual-repack-20260912`，sourceCommit `871703d`；exe `99c02d67…` / asar `7ca56cc5…` / zip `92126171…`（完整值见 `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.sha256.txt`）。`candidate-manifest.cjs check` 通过（磁盘与登记一致）。
- **out/ 保护**：`build:main` 会 `rmSync('out')`（`package.json:35`），故先把旧构建输出归档为 `archive/out-871703d-before-refresh.tar.gz`（173540 bytes，61 条目 = 50 文件 + 11 目录，可用 `tar -xzf` 原样恢复）。归档不参与源码提交。
- **候选/历史目录**：`candidate-*/`、`candidate-*.zip`、`release*/` 均在 `.gitignore` 内；本轮不删除、不重命名、不占位覆盖。`win-unpacked`、`win-unpacked-fresh`、`win-unpacked.new` 全部保留。
- **已知阻断**（本轮待修）：B1 清单路径命名不一致（磁盘清单 `main/…` vs 归档/必需模块 `out/main/…`，真实调用下 50 缺 / 50 多）；B2 登记与源码冻结冲突（根 manifest 被 Git 跟踪 → 登记即判脏，提交又换 HEAD）。另须保留 `verify-package` 的包可用性检查，不得让 `verify-release` 把它顶掉。
- **环境注记**：本会话 shell 的 `PATH` 缺 `/usr/bin`（`dirname`/`head` 不可用），执行命令前显式 `export PATH="/usr/bin:/bin:$PATH"`；属命令环境问题，非仓库缺陷。

## 新候选身份（未生成）

- sourceCommit：待填
- buildId：待填
- manifest绝对路径：待填
- 候选目录/zip：待填
- exe/app.asar/zip SHA256：待填
- 锁文件/构建记录hash：待填
- 测试数量/失败数：待填
- 包内sharp及GUI启动：未验证
- 用户真实安装操作授权：未取得
- 真实应用/重启/恢复：未验证
- A6：用户决定跳过，未验证；不得填通过
- 发布渠道与外部操作授权：未取得
- 结论：NO-GO，等待阶段验收

## 新增接口及RUNBOOK交付

- [ ] 记录实际新增脚本及参数（方案里的--manifest等目前未实现）。
- [ ] 补RUNBOOK.md完整命令，成功与失败路径均可照做。
- [ ] 按实际结果更新兼容范围、许可、隐私及恢复说明。

## 异常与处理

逐条记录：发生阶段、原始错误码、是否影响用户安装、已采取的安全操作、剩余事项。不得省略失败，也不得把mock成功标为真实安装通过。
