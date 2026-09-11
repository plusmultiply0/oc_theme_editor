# 交付清单（T74）

生成时间：2026-09-11（**第二次构建**，含「目标发现过滤」修复）。
构建环境 Windows 10.0.26200 / Node v22.22.2 / Electron 36.9.5 / electron-builder 26.15.3。

## 1. 产物

| 文件 | 大小 | SHA256 |
|---|---|---|
| `release2/win-unpacked/OpenCodeThemeSwitcher.exe` | 193.3 MB | `3ba432fb3092115fb83ded7f0f2ac10ba9bd79162743e6575a9da767bda8a3cc` |
| `release2/win-unpacked/resources/app.asar` | 17.5 MB | `67683383b698deab5ec4220a6ed15449c1a418a48ba09f0e1992ae1cbb820a3f` |

目录总大小约 325 MB（`--win --dir`，免安装目录，不是安装包）。

**为什么输出在 `release2/`：**
上一轮的 `release/win-unpacked/resources/app.asar` 在本次重构时处于被占用状态（`EBUSY`），
删除与重命名都失败（进程列表里没有本工具或 OpenCode 的进程，判断为安全软件正在扫描该文件）。
为了不强行结束任何进程，改输出到新目录 `release2/`。
**旧 `release/` 需要手动删除**——锁释放后直接删即可，它是构建产物，删掉不影响任何功能。

本轮核对（新产物）：归档 952 条目，顶层只有 `node_modules` / `out` / `package.json`，
`src/` 与 `tests/` 零命中，工作区绝对路径与作者用户名等私有串零命中；
并抽查 `out/core/patch/discover.js` 已含本次修复（DisplayName 过滤、WOW6432Node、`TARGET_NOT_FOUND` 不再算未通过）。

重新构建后哈希会变化，发布前请重新计算并替换本表。

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
| `npm run test:e2e` | 0 | **0 用例**（未实现） |
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
