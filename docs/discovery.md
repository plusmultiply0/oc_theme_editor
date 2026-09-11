# P0 盘点：现状与目标识别

日期：2026-09-10。负责人：单 agent。任务：T00–T02。
所有路径使用环境变量或占位符表示，不写入本机账户名。

## T00 目录与 git 状态

仓库根：`OpenCode_Theme_Switcher`

| 项 | 结果 |
|---|---|
| git | 已初始化，分支 `master`，初始提交 `a3f2300`，工作区 clean |
| 入库文件 | 21 个（原型 20 + `.gitignore`） |
| 忽略规则 | `backups/`、`*-manifest.json`、`app.*.asar`、`.workbuddy/` |
| 旧原型 | `OpenCode/_Theme/_Switcher/`：三套 CSS、`theme-tool.cjs`、`arknights-tool.cjs`、`pastel-tool.cjs`、`verify-electron.cjs`、`build-pastel.py` |
| 交接文档 | `handoff/` 四份 |
| 工程文件 | 无 `AGENTS.md`、无 `package.json`、无锁文件（本轮新建工程前记录：不存在，不假设已有） |

本轮新增：`tools/inspect-asar.cjs`（只读 ASAR 探测，见下）。

## T01 旧原型盘点

按「复用思想 / 重写 / 不纳入」标注。

| 项 | 现状 | 标注 |
|---|---|---|
| ASAR 解析与打包 | 脚本内自行实现 pickle 头部解析；打包依赖外部 `asar_stage.cjs` | **重写**。解析逻辑可复用思路，但依赖作者个人 `.codex` 路径，不符合 T35「辅助库须纳入项目」 |
| 硬编码路径 | 已于 2026-09-10 脱敏改造，改为 `OPENCODE_APP_DIR` / `OPENCODE_THEME_IMAGE` / `ASAR_STAGE` 三个环境变量 | **不纳入**。仅作为历史参考，新工程不继承 |
| 版本/指纹校验 | 硬编码 `1.18.29` 与归档 SHA256 | **复用思想**（版本+hash 双校验），**重写**为 adapter 声明式配置 |
| 进程检查 | PowerShell `Get-CimInstance Win32_Process` 检测目标是否运行 | **复用思想**，重写为跨平台可测的服务 |
| 备份与恢复 | 备份 `app.asar` 到 `backups/<时间戳>/`，manifest 记录 hash | **复用思想**（完整备份 + hash 校验 + 首次原版/上一主题双语义），**重写**为事务存储 |
| restore 语义 | `pastel-tool.cjs` 的 restore 返回上一个（明日方舟）主题，**不等于**恢复未定制原版 | **不纳入**。新工具必须区分「恢复上一主题」与「恢复原版」（T41） |
| `build-pastel.py` | 用字符串替换从 arknights 生成 pastel 的 CSS 与脚本 | **不纳入**。T23 明确要求 token 模板生成，不做大量 replace |
| 三套主题 CSS | snow / arknights / pastel 的配色与选择器 | **复用思想**（配色可作为预设来源、选择器可作参考），**重写**为模板 |
| `verify-electron.cjs` | 用 `ELECTRON_RUN_AS_NODE` 启动目标读归档验证 | **复用思想**，可作为集成测试的读取侧参考 |

### 外部依赖

- `asar_stage.cjs`：位于作者个人 skill 目录，未随仓库分发。**不纳入**，新工程须自带依赖（T35）。
- PIL（Python）：仅 `build-pastel.py` 使用。**不纳入**（新工程为 Node/TS 栈）。
- Electron：目标应用自身提供。

### 安全检查整理（原型已有，需保留并强化）

1. 目标进程未退出则拒绝写入 —— 强化为 T32。
2. 备份后校验 hash —— 强化为 T36/T39。
3. 提交前后校验目标 hash，检测期间变更 —— 强化为 T37。
4. 版本不符拒绝 —— 强化为 T31/T37。

## T02 目标安装识别（只读）

探测工具：`tools/inspect-asar.cjs`（只读，不写入、不解压、不修改）。

| 项 | 值 |
|---|---|
| 安装目录 | `%LOCALAPPDATA%\Programs\@opencode-aidesktop` |
| 归档 | `resources/app.asar`，152,395,856 字节，6,994 条目，数据区起点 1,815,360 |
| package name | `@opencode-ai/desktop` |
| version | 1.18.29 |
| main | `./out/main/index.js` |
| 框架 | Electron（存在 `LICENSE.electron.txt`、`resources.pak`、`app.asar.unpacked/`） |
| 更新渠道 | `resources/app-update.yml`：`owner=anomalyco`、`repo=opencode`、`provider=github`、`channel=latest`（electron-updater） |
| renderer 资源 | `out/renderer/` 956 条目，入口 `index.html`（1,264 字节） |

### 当前补丁状态

`out/renderer/` 下**未发现** `snow-theme.css`、`*-background.jpg/png` 等补丁条目；`index.html` 中无注入的本地样式引用。

结论：当前安装处于**未打补丁**状态（或已被完整还原）。`app.asar` 的 mtime 为 2026-09-09 09:42，早于本轮，仅作记录，不作为「已被修改」的证据。

### 官方主题机制（关键发现）

`out/renderer/index.html` 引用了官方脚本 `oc-theme-preload.js`。其行为（只读源码得到）：

- 读取 `localStorage["opencode-theme-id"]`，默认 `oc-2`；若为 `oc-2` 则直接返回，不注入自定义 CSS。
- 读取 `localStorage["opencode-color-scheme"]`（`light`/`dark`/`system`）。
- 设置 `document.documentElement.dataset.theme` 与 `dataset.colorScheme`。
- 仅当 themeId ≠ `oc-2` 时，读取 `localStorage["opencode-theme-css-" + mode]` 并注入 `<style id="oc-theme-preload">`。

上游源码对应 `packages/ui/src/theme/context.tsx`，`STORAGE_KEYS = { THEME_ID: "opencode-theme-id", COLOR_SCHEME: "opencode-color-scheme", THEME_CSS_LIGHT: "opencode-theme-css-light", THEME_CSS_DARK: "opencode-theme-css-dark" }`，样式元素 id 为 `oc-theme`。

即：该 CSS 缓存是 **应用内部主题缓存**，由 `applyThemeCss` 写入，用于防 FOUC，**不是供外部工具注入任意 CSS 的接口**。详细结论见 `docs/compatibility.md`。

### 用户配置目录

`%USERPROFILE%\.config\opencode\themes\` **已存在**，内含两个自定义主题文件：

- `hanafune.json`（4,787 字节）
- `hanafune-glass.json`（2,326 字节）

（仅记录文件名与大小，未读取内容。）这表明官方自定义主题目录在本机**已在使用**。

### 未读取声明

按 T02 要求，本次**未读取**：会话内容、`opencode.json` 配置（可能含凭据）、任何密钥或账号数据。仅读取安装目录结构、归档元数据、`app-update.yml` 与主题目录文件名。

## 证据与命令

| 命令 | 结果 |
|---|---|
| `git log --oneline` | `a3f2300 初始化 OpenCode 换肤工具仓库` |
| `node tools/inspect-asar.cjs` | 输出 asar 路径、字节数、条目数、package 名/版本 |
| `node tools/inspect-asar.cjs --list out/renderer` | 956 条目，无主题/背景文件 |
| `node tools/inspect-asar.cjs --read out/renderer/index.html` | 含 `oc-theme-preload.js` 引用，无注入样式 |
| `node tools/inspect-asar.cjs --read out/renderer/oc-theme-preload.js` | 官方 preload 逻辑，见上 |

---

## 更新（2026-09-11）：卸载登记表的扫描范围收紧

真机界面上出现过一屏无关目录（Fiddler、Postman、VS Code、zotero、Trae…）被列进「未通过的候选」。

原因：`registryRoots()` 原先用 `reg query <Uninstall 键> /s /v InstallLocation`
把**所有**卸载登记项的位置都当候选，于是每装过的软件都成了「候选」，扫不到归档就报一条失败。

修法（`src/core/patch/discover.ts`）：

1. 先 `reg query <键> /s /v DisplayName`，**只在 DisplayName 命中 `/opencode/i` 时**才去读该子键的 `InstallLocation`；
2. 登记值统一去引号、去尾部分隔符（这两种脏数据在真机上都出现过）；
3. 同一路径按小写去重（同一安装常在 HKCU/HKLM 与 WOW6432Node 视图里各登记一次）；
4. `discoverTargets()` 不再把「这目录里没有应用归档」当成「未通过」——
   那只是注册表顺带带来的无关目录，现在只计入「已检查位置」，界面默认折叠。

补了 4 项回归测试，用贴近 `reg query` 实际输出的样本喂给解析器，断言 Fiddler/Postman/VS Code 一个都不会成为候选。
