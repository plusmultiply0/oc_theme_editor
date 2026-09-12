# 公开范围与脱敏检查（A7 整理稿，待 jc 确认）

日期：2026-09-12。执行者：wb。**本轮只做检查与清单，没有删除任何文件、没有重写 Git 历史、没有推送远端。**

结论先说：**二进制包本身可以对外发**（包内私有路径与凭证扫描 0 命中）；
**源码仓库目前不适合直接公开** —— `handoff/` 里有 10 个跟踪文件写明了本机绝对路径，
其中还包含事故现场材料；此外 49 个提交的作者邮箱是个人邮箱。

## 1. 二进制分发材料

| 材料 | 状态 |
|---|---|
| 版本 zip（整 `win-unpacked`，82 条目，完整性校验通过） | ✅ `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.zip`（131 MB） |
| SHA256 清单 | ✅ `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.sha256.txt`（zip / exe / app.asar 三项） |
| 已知限制与兼容范围 | ✅ `docs/release-notes-0.1.0-alpha.1.md` |
| 五步使用与恢复说明 | ✅ 同上 + `README.md` |
| 反馈模板 | ✅ `docs/release-notes-0.1.0-alpha.1.md` 末节 |
| 工具版本 / 包版本一致 | ✅ 界面与 `package.json` 均为 `0.1.0-alpha.1` |
| 演示素材 | ⏳ 未拍摄（`docs/demo-script.md` 只有分镜） |

包内检查（`npm run verify:package`，28 项 0 失败）：归档顶层只有
`node_modules` / `out` / `package.json`；不含 `src`、`tests`、`handoff`、`docs`；
**包内私有路径与凭证 0 命中**。

## 2. 源码公开：建议排除 / 脱敏清单

`git grep` 实测（跟踪文件）：

| 文件 | 问题 | 建议处理 |
|---|---|---|
| `handoff/background-incident-2026-09-12/BACKGROUND_FIX_PLAN.md` | 含本机安装路径 | 公开快照排除整个 `handoff/` |
| `handoff/background-incident-2026-09-12/verify-background.cjs` | 同上 | 同上 |
| `handoff/background-incident-2026-09-12/verification/evidence.json` | 同上 + 现场证据 | 同上 |
| `handoff/background-incident-2026-09-12/verification/*.png`（5 张） | 隔离夹具截图（非用户壁纸） | 同上 |
| `handoff/format-review-2026-09-12/probe-formats.cjs` | 含本机路径 | 同上 |
| `handoff/review-2026-09-11/electron-readonly-result.json` | 含本机路径 | 同上 |
| `handoff/startup-incident-2026-09-11/Recover-OpenCode.ps1` | 含本机安装路径与事故快照哈希 | 同上（**且不要公开**：绑定特定故障现场，公开会误导他人使用） |
| `handoff/startup-incident-2026-09-11/archive-evidence.json` | 事故现场证据 | 同上 |
| `handoff/alpha-release-plan-2026-09-12/*` | 发布计划与验收记录（含本机路径） | 同上 |
| `tools/post-restore-health.cjs` | 默认路径写死为本机安装 | 公开前改为必填参数（无默认路径） |
| `tools/verify-package.cjs` | 注释中提及本机路径 | 改为中性描述 |
| `tools/audit.cjs` | 豁免清单里出现本机样例路径 | 同上 |

没有发现的问题（值得记录）：

- **仓库里没有用户的私人壁纸**：跟踪的 5 张 PNG 是隔离夹具截图，不是用户图片。
- **没有凭证**：`npm run audit` FAIL 0（凭证规则不豁免）。
- **没有用户聊天内容、没有完整用户目录列表**。
- **旧构建目录未入库**：`release*` / `candidate-*` 都不在 Git 跟踪内。

## 3. Git 历史层面的两件事

1. **作者邮箱**：49 个提交的作者是 `plusmultiply0 <kimzhou36@foxmail.com>`。
   即使公开快照里删掉文件，历史仍能看到这个邮箱。建议公开发布时使用中性邮箱
   （例如项目专用邮箱），**不要**为此重写已有历史。
2. **历史里已有 handoff 材料**：`handoff/` 是分批提交进去的，历史中可回溯。
   若要彻底不公开这些内容，需要另建**脱敏源码快照**（导出当前工作树、剔除 handoff、
   重新初始化仓库），而不是重写现有历史。这属于需要授权的动作。

## 4. 仓库元信息缺口

- `package.json` 声明 `license: MIT`，但**仓库里没有 LICENSE 文件** → 公开前需补上，
  或调整声明。
- `author` 未设置、`repository` 未设置 → 公开前按需补齐。
- `private: true` 保留即可：npm 的私有标记与「是否公开源码仓库」无关，
  发布桌面程序不需要解除它。

## 5. 明确不做（需要 jc 单独授权）

- 删除任何私人证据文件、把 handoff 从历史中移除、重写 Git 历史；
- 推送远端、公开仓库、上传 zip、对外发文、购买代码签名。

以上四项本轮**均未执行**。A8 的 GO/NO-GO 当前仍是 **NO-GO**：
A5（真实安装闭环）与 A6（干净环境）都没有证据，按计划口径不能标为可发布。
