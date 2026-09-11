# 交付清单（T74）

生成时间：2026-09-11（**第三次构建**，含 P0 审查 R1–R8 修复，见 CHANGELOG 对应小节）。
构建环境 Windows 10.0.26200 / Node v22.22.2 / Electron 36.9.5 / electron-builder 26.15.3。

> 哈希与大小由构建完成后回填；构建命令见第 5 节。

## 1. 产物

生成时间：2026-09-11（**第三次构建**，含 P0 审查 R1–R8 修复）。

| 文件 | 大小 | SHA256 |
|---|---|---|
| `release3/win-unpacked/OpenCodeThemeSwitcher.exe` | 193.3 MB | `ac4896317bd66a87b002aa090a248e5be5f0ccd9b7d8f8a17b2d93a0bb23837f` |
| `release3/win-unpacked/resources/app.asar` | 17.6 MB | `824fd0d9633a06d35a3cb498af95517b27d3ca0a009ca469cf0991e356b22bce` |

目录总大小约 325 MB（`--win --dir`，免安装目录，不是安装包）。

**为什么输出在 `release3/`：** `release/` 与 `release2/` 里的旧 `app.asar` 被占用（判定为安全软件在扫描），
删除与改名都被拒绝。为不再出现三个目录互相混淆，`package.json` 的 `build.directories.output`
已固定为 `release3`，以后每次构建都覆盖它。
**`release/` 与 `release2/` 是过期产物，不要用它们验证或分发**；锁释放后在资源管理器里手动删除即可。

本轮核对（`npm run verify:package`，28 项，0 失败）：

| 项 | 结果 |
|---|---|
| 归档条目数 | 960（上一轮 952；新增的是本轮模块），unpacked 7 |
| 归档顶层 | 仅 `node_modules`(914) / `out`(45) / `package.json`(1) |
| 源码/测试/交接/文档条目 | 0 |
| 本轮模块在包内 | `physical-fs.js`、`archive-io.js`、`legacy-theme.js`、`original-evidence.js`、`surfaces.js`、`tokens.js`、`recovery-service.js` 全部命中 |
| 主进程抽查 | 含 `RecoveryService` 启动、`THEME_SWITCHER_NO_REGISTRY`、`chooseTargetDirectory`/`getRecoveryStatus`/`resolveRecovery` 处理器 |
| renderer 抽查（vite 单文件） | 「减少透明度」「恢复到首次接管时」「没有可证明的出厂原版」「选择安装目录」「待恢复」「旧主题层」全部命中 |
| 包内私有路径与凭证 | 扫描全部文本条目，0 命中 |

重新构建后哈希会变化，发布前请用 `npm run verify:package` 重新核对并替换本表。

## 2. 文档

| 文件 | 内容 |
|---|---|
| `README.md` | 定位、支持范围、五步使用、恢复语义、风险、常见报错、已知限制、开发命令 |
| `docs/acceptance.md` | 命令与退出码、合规自检、便携包核对、未执行项 |
| `docs/security.md` | 信任边界、写入范围、事务安全、备份语义、输入安全、隐私、不保证什么 |
| `docs/compatibility.md` | 官方主题机制取证与路线选择 |
| `docs/architecture.md` | 分层、契约、事务与恢复模型 |
| `docs/discovery.md` | 目标归档只读取证 |
| `docs/demo-script.md` | 演示分镜（**未拍摄**） |
| `docs/article-outline.md` | 掘金文章提纲（**发布前需核实活动规则**） |
| `CHANGELOG.md` | 分阶段变更记录 |
| `handoff/progress.md` | 每项功能一次提交的交接记录 |

## 3. 测试结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 通过 |
| `npm run test:unit` | 0 | 4 文件 / 82 项 |
| `npm run test:integration` | 0 | 3 文件 / 48 项 |
| `npm run test:e2e` | 0 | **8 项真实窗口闭环**（Playwright + Electron） |
| `npm run test:e2e:electron` | 0 | **35 项真实 Electron 主进程闭环** |
| `npm run verify:package` | 0 | 便携包内容核对 28 项 |
| `npm run build` | 0 | 通过 |
| `npm run audit` | 0 | 5 项自检全通过 |
| 便携包构建 | 0 | 产出 `release2/win-unpacked`（见第 1 节） |

## 4. 未完成 / 待办（按优先级）

1. **T63 真实应用与观察（进行中）**：第 1 次应用已成功（指纹 `1c53ca…` → `aeab66…`），
   **等 jc 观察当前效果**；之后还有：换浅色主题 → 再观察 → 恢复上一主题 → 恢复原版。
2. **T64 真实界面走查**：侧栏、正文、代码、输入、菜单、按钮四态、终端、错误/diff；背景缩放与窗口变化。
3. **T65 干净环境验证**：在无作者开发目录、无全局 Node/Python 的机器上启动便携包；当前**未验证**。
   清单见 `docs/portable-verify.md`。
4. **E2E**：`tests/e2e` 补 F1–F5 用例（当前 0 用例）。
5. **便携包签名**：当前未签名，不得声称已签名。
6. **演示视频**：依赖 1、2 完成，当前只有脚本。
7. **公开仓库 / 发文 / 上传安装包**：均需 jc 单独授权。
8. **清理旧 `release/` 目录**：文件被占用未能删除，锁释放后手动删。

## 5. 发布前的硬性提醒

- 不要把它说成「官方功能」或「已签名」。
- 不要教用户关闭安全软件。
- 「已验证版本 1.18.29」「需要重新应用」「卸载前先恢复原版」三句话必须出现在对外说明里。

---

## 更新（2026-09-11）：第三次构建（P0 审查 R1–R8 修复）

| 项 | 结果 |
|---|---|
| 输出目录 | `release/win-unpacked`（`package.json` 的 `directories.output` 未改） |
| 旧 `release2/` | **仍是上一次构建的产物，已过期，不要用它验证或分发**。本次尝试删除与改名均被占用拒绝 |
| 测试门禁 | `npm run verify`（类型 + lint + 单测 96 + 集成 62 含真实 Electron 主进程 35 项 + 构建 + 真实窗口 E2E 8 项）全过 |
| 合规自检 | `npm run audit` FAIL 0 / WARN 0 |
| 签名 | 仍未签名，不要对外声称已签名 |

### 核对项（构建后必须重做）

1. 归档条目数与顶层结构：顶层只允许 `node_modules` / `out` / `package.json`。
2. `src/`、`tests/`、`handoff/` 零命中；工作区绝对路径与作者用户名零命中（`npm run audit` 已覆盖源码与文档）。
3. **本轮修复必须在包内**：抽查 `out/core/patch/physical-fs.js`、`archive-io.js`、`legacy-theme.js`、
   `original-evidence.js`、`theme/surfaces.js`、`theme/tokens.js` 存在；
   `out/shared/ipc.js` 含 `chooseTargetDirectory` / `getRecoveryStatus` / `resolveRecovery`；
   `out/main/index.js` 含 `RecoveryService` 启动调用。
4. 重新计算 exe 与 app.asar 的 SHA256 并替换第 1 节的表。

### 构建命令（直连 GitHub 会 ETIMEDOUT，走镜像）

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist
```
