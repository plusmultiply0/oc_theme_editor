# 交付清单

Alpha 候选版本用 `docs/alpha-acceptance.md` 记录逐项验收；本文件只回答两件事：
**当前该用哪个包**、**发布前必须核对什么**。

## 1. 当前候选（Alpha）

版本 **`0.1.0-alpha.1`**（Windows x64）。分发前请核对 zip 的 SHA256：

| 文件 | 大小 | SHA256 |
|---|---|---|
| `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.zip` | 131 MB | `f41354a398c732a0e58cf84231cd77e4b14aafcd4d32f578c59b4959e1d9b08a` |
| ├ `win-unpacked/OpenCodeThemeSwitcher.exe` | 193.3 MB | `99c02d6796bc2df00d7b16f8135ae9052b11bfb08384ee502b5044961756f46f` |
| └ `win-unpacked/resources/app.asar` | 17.7 MB | `3381173d21ac8f45039a42ade17a76611dde3a949d040a5524b713e9f5f4ac6f` |

归档 965 条目 / unpacked 7。**未签名**。
逐项验收与包内抽查见 `docs/alpha-acceptance.md`；校验和清单随包分发。

**分发要求**：整个 `win-unpacked` 一起发（zip），不能只发 exe；
zip 的 SHA256 必须与上表一致。

## 2. 历史构建（全部过期，不要用于验证或分发）

| 目录 | 构建时间 | 内容 | 状态 |
|---|---|---|---|
| `release/` | 2026-09-11 | 最早的可执行目录目标 | 过期 |
| `release2/` | 2026-09-11 | 目标发现过滤修复 | 过期 |
| `release3/` | 2026-09-11 | P0 审查 R1–R8 修复 | 过期 |
| `release4/` | 2026-09-12 | 事故 F1–F4 修复前 | 过期 |
| `release5/` | 2026-09-12 | 背景事故 F1–F4 | 过期 |
| `release6/` | 2026-09-12 | 真机验收发现的三处修复 | 过期 |
| `release7/` | 2026-09-12 | 第一批 JPEG 别名支持 | 当前基准（见第 1 节） |

旧的 `app.asar` 曾被安全软件占用（环境的安全删除包装器对 `.asar` 回收失败），
因此每轮只能递进一个新目录，旧的删不掉。锁释放后在资源管理器手动删除即可。

## 3. 当前门禁结果（Alpha 候选 0.1.0-alpha.1）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 通过 |
| `npm run test:unit` | 0 | 135 项（9 文件） |
| `npm run test:integration` | 0 | 138 项（12 文件） |
| `npm run test:e2e` | 0 | 16 项真实窗口闭环 |
| `npm run test:e2e:electron` | 0 | 35 项真实 Electron 主进程闭环 |
| `npm run audit` | 0 | 通过 |
| `npm run dist` | 0 | 产出 `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1/win-unpacked` |
| `npm run verify:package` | 0 | 28 项（965 条目） |

一条命令跑全链：`bash tools/release-gate.sh`（任一步非 0 即停，逐条打印退出码与耗时）。
`npm run verify` 不含 `test:e2e:electron` / `audit` / `dist` / `verify:package` ——
**不能只跑 verify** 就宣称全部门禁通过。这些数字属于本候选包那一次构建；
包有改动必须重跑并更新第 1 节哈希。

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
