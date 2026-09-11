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

## 5. 真实安装验收（T62、T63、T64）

授权：jc 于 2026-09-11 授权对真实安装执行写入（应用/恢复），**应用的启动、关闭与画面观察由 jc 手动完成**。

驱动脚本：`tools/live-cli.cjs`（`status` / `precheck` / `apply` / `restore`），与 GUI 共用同一套服务层与事务逻辑。

### 5.1 只读预检（已完成）

```
目标：%LOCALAPPDATA%\Programs\@opencode-aidesktop  版本 1.18.29  supported
归档：resources\app.asar（145.3 MB）
进程：idle　可写：true
磁盘：可用 5641 MB，需要 500 MB
```

**进程探针首次在真实环境跑通**（`systemProcessProbe`，PowerShell `Get-CimInstance`），此前一直只在测试中注入 `idle` 探针绕过。

### 5.2 第 1 次应用（已完成）

首次尝试被安全规则拦下，这是本轮最有价值的发现：

```
[FAIL] 准备（预检 + 生成产物）: CONTRAST_BELOW_TARGET
发生了什么：以下元素未达到可读性目标：主按钮文字 4.11（需 4.5）
```

根因：`ensureContrast` 只沿「远离背景」一个方向调整明度，而起点已是纯白；
中间调主色（实测主色约 `#6a7bb5`）上纯白只能到 4.11，反方向的深色起点反而能到 5.1。
修复：起点改为「黑白中对比度更高者」，且调整时两个方向都试；已补 5 个中间调主色的回归用例。

修复后应用成功：

```
[OK] 应用
操作 ID：op-20260911T021501212Z-chtazi
状态：applied　主题：demo-wallpaper-a.png · 深色 · 遮罩 0.35 · 面板 0.86
目标指纹（提交前）：1c53ca2472698a9e…
提交后指纹：aeab66d4a2681f8c…
```

只读复核写入结果：

| 项 | 结果 |
|---|---|
| 归档条目数 | 6996（原 6994 + 新增 2） |
| unpacked 条目 | **47，全部保留**（原生模块标记未被破坏） |
| `out/renderer/index.html` | 已注入 `<link rel="stylesheet" href="./oc-theme-custom.css">`，位置在原 `snow-theme.css` 之后 |
| `out/renderer/oc-theme-custom.css` | 2901 字节，背景引用 `./oc-theme-background.jpg` |
| `out/renderer/oc-theme-background.jpg` | 68950 字节 |
| 备份 | `%LOCALAPPDATA%\OpenCodeThemeSwitcher\instances\a67a928b01029b5c\backups`，original + previous 各一份 |

### 5.3 待 jc 完成的观察（T64）

请启动 OpenCode 并按下列清单走查，逐项记录「符合 / 不符合 / 看不到」：

1. 侧栏：会话列表、选中项底色、文字是否清晰
2. 正文：用户气泡与助手气泡、长段落换行
3. 代码：容器底色（语法高亮**故意不改**，若被改属于缺陷）
4. 输入区：输入框底色、placeholder 可读性、发送按钮
5. 菜单 / 对话 / 提示浮层：面板半透明后的可读性
6. 按钮：默认 / 悬停 / 按下 / 焦点四态是否可区分
7. 终端：应保持原配色（不在覆盖范围内）
8. 错误提示与 diff：新增/删除行颜色
9. 缩放窗口与改变窗口大小：背景是否跟随 `cover` 正确缩放，有无拉伸或黑边

确认后**完全退出 OpenCode**，我再执行「换第 2 个主题」与「恢复」。

### 5.4 后续步骤（未完成）

- [ ] 第 2 次应用（换主题：`demo-wallpaper-b.png`，浅色）→ jc 观察 → 退出
- [ ] 恢复上一主题 → jc 观察 → 退出
- [ ] 恢复原版 → jc 确认回到出厂界面
- [ ] 每个写入阶段重新预检（进程 / 写权限 / 磁盘）
