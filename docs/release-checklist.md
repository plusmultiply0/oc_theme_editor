# 交付清单

Alpha 候选版本用 `docs/alpha-acceptance.md` 记录逐项验收；本文件只回答两件事：
**当前该用哪个包**、**发布前必须核对什么**。

## 1. 当前候选

> **状态：A4 尚未冻结 Alpha 候选。** 下表是上一次构建（release7，2026-09-12 第七次构建），
> 它含第一批 JPEG 别名支持，但**不含** A1–A3 的改动。A4 会用新目录生成唯一候选并把这里替换掉。
> 在替换之前，任何验证/分发都应以 release7 为基准，且不得声称它是最终 Alpha 包。

| 文件 | 大小 | SHA256 |
|---|---|---|
| `release7/win-unpacked/OpenCodeThemeSwitcher.exe` | 193.3 MB | `3e69d4ff9d0daa46fbb9d8de46078bb28ac3e93d771f312b1197a0d7781861dc` |
| `release7/win-unpacked/resources/app.asar` | 17.7 MB | `811e59df75b120c201e0e8bd3ad19444d42a92d55ea3cc549559ac74638b763e` |

归档 964 条目 / unpacked 7。**未签名。**

包内核对（`npm run verify:package`，28 项 0 失败）：归档顶层只有
`node_modules` / `out` / `package.json`；不含 `src`、`tests`、`handoff`、`docs`；
包内私有路径与凭证 0 命中；第一批格式声明（`out/shared/image-formats.js` 含 jfif/jpe）
与主进程 `DIALOG_EXTENSIONS` 使用点在包内。

**分发时必须整目录打包**（`win-unpacked` 全部文件），不能只发 exe；
zip 的 SHA256 在 A4 生成后一并记录到 `docs/alpha-acceptance.md`。

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

## 3. 当前门禁结果（2026-09-12 第七次构建时的实测）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 通过 |
| `npm run test:unit` | 0 | 122 项 |
| `npm run test:integration` | 0 | 114 项（10 文件） |
| `npm run test:e2e` | 0 | 16 项真实窗口闭环 |
| `npm run test:e2e:electron` | 0 | 35 项真实 Electron 主进程闭环 |
| `npm run audit` | 0 | 通过 |
| `npm run dist` | 0 | 产出 `release7/win-unpacked` |
| `npm run verify:package` | 0 | 28 项 |

这些数字属于**那一次构建**。A4 会重跑全部门禁并替换本表；
`npm run verify` 只覆盖其中一部分，不能只跑它就宣称全部门禁通过。

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
