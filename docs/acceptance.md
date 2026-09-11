# 验收记录

> 原则：每条命令记录**真实输出与退出码**；没跑的一律写「未执行」，不把「没有用例」当成「通过」。

## 1. 环境

| 项 | 值 |
|---|---|
| 系统 | Windows 10.0.26200（win32 x64） |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Electron | 36.9.5 |
| 日期 | 2026-09-11 |

## 2. 命令与退出码（T60）

| 命令 | 退出码 | 结果摘要 |
|---|---|---|
| `npm run typecheck` | 0 | 无输出，`tsc --noEmit` 通过 |
| `npm run lint` | 0 | 无告警 |
| `npm run test:unit` | 0 | 4 文件 / 76 项通过 |
| `npm run test:integration` | 0 | 3 文件 / 44 项通过 |
| `npm run test:e2e` | 0 | **0 个用例**（`--pass-with-no-tests`），E2E 未实现，见 `tests/e2e/README.md` |
| `npm run build` | 0 | 产出 `out/main/index.js`、`out/renderer/index.html`（JS 246 KB / CSS 9.8 KB） |
| `npm run audit` | 0 | 路径/凭证/产物/许可/IPC 五项检查全部通过（见下） |
| `npm run dist` | 0 | 产出 `release/win-unpacked`（326 MB，dir 目标） |

`npm run dist` 需要下载 Electron 发行包与 electron-builder 二进制，**直连 GitHub 会 ETIMEDOUT**；本机构建时使用了镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win --dir
```

## 3. 合规自检（T61，`npm run audit`）

检查脚本：`tools/audit.cjs`，可反复执行，退出码非 0 即存在 FAIL。

| 检查项 | 结果 |
|---|---|
| 作者专属绝对路径 / 用户名 | 0（测试与文档里的占位用户名如 `someone` 已排除，避免噪声淹没真泄漏） |
| 密钥 / 私钥 / Token 形态 | 0（覆盖 `sk-`、`ghp_`、`AKIA`、`BEGIN PRIVATE KEY`、`AIza`、`Bearer`） |
| 产物含归档 / 备份 / 个人图片 | 0（`out/` 内无 `.asar`、无 `backups/`、无图片） |
| 依赖许可 | `@electron/asar` MIT、`react` MIT、`react-dom` MIT、`sharp` Apache-2.0、`zod` MIT、`electron` MIT；无 GPL/LGPL/AGPL 直接依赖 |
| IPC 三处一致 | 14 个通道在 `shared/ipc.ts`、`preload/index.ts`、`main/ipc.ts` 全部对齐 |
| renderer 直连 ipcRenderer | 无（只经 `contextBridge` 白名单） |

补充的静态事实（不靠脚本，逐条核对过）：

- 远程图片被禁：`validateImageRef()` 拒绝 `http(s)://`、`//`、`file:`、绝对路径与含 `;'"` 换行的注入串，单测已覆盖（`tests/unit/theme.test.ts`）。
- 日志脱敏：事务记录写在系统用户数据目录（`%LOCALAPPDATA%\OpenCodeThemeSwitcher`），`targetPath` 只落本机日志，不随 manifest 外传；manifest 里的 `installPath` 是本机安装位置，属用户自己的机器信息，不外发。
- 未使用全局 `* { ... !important }`，终端与语法高亮不在覆盖范围内（T27）。

**未执行**：IPC 边界的运行时渗透测试、日志文件的实际人工抽查。

## 4. 便携包（T65，部分）

- 目标：`--win --dir`（免安装目录，非安装包）。
- 归档内容核对：`resources/app.asar` 952 个条目，顶层仅 `out/`、`node_modules/`、`package.json`；
  **源码 `src/`、测试 `tests/`、`handoff/`、旧原型 `OpenCode/` 均未打进包**，
  归档内检索 `zjcfile` / `作者用户名` 命中 0。
- 关键文件齐全：`out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html`。
- 体积 326 MB（Electron 运行时 + sharp 原生模块），未压缩、未做安装包。
- **未签名**：本包没有代码签名证书，绝不能对外声称「已签名」，也不应建议用户关闭安全软件来运行。
- **未执行**：在「无作者开发目录 / 无全局 Node 与 Python」的干净机器上启动验证。本环境无法启动 Electron 窗口
  （`ELECTRON_RUN_AS_NODE=1` 时主进程不起；去掉后 GUI 进程 stdout 不回传），因此**只完成了产物内容核对，未完成启动验证**。

## 5. 真实安装验收（T62、T63、T64）— 未执行

这三项需要对 jc 本机的 OpenCode 安装执行真实写入（应用 → 重启观察 → 换主题 → 恢复），
**必须另行获得明确授权**，授权内容应包括：目标安装、版本、允许的操作范围、是否允许启动/关闭应用、是否采集截图。

未授权前，工具对真实安装只做只读识别，不做任何写入。
