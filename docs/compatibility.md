# P0 适配可行性：官方接口验证与路线选择

日期：2026-09-10。负责人：单 agent。任务：T03、T05。依赖：`docs/discovery.md`。

## 结论摘要

**官方主题机制存在且可用，但只覆盖配色，不支持背景图片。** 这是本次可行性评估最重要的结论，直接决定 F1（选图）与 F5（应用）的实现方式。

| 五项功能 | 官方机制能否覆盖 |
|---|---|
| F1 选图（本地图片） | ❌ 官方主题无图片字段，图片无法成为主题的一部分 |
| F2 自动配色 | ✅ 完全覆盖（颜色 token） |
| F3 可读性调节 | ⚠️ 部分覆盖（明暗模式、配色可用；背景遮罩/不透明度/模糊无对应字段） |
| F4 预览 | ➖ 与实现方式无关，工具自身职责 |
| F5 应用与恢复 | ✅ 官方路线下退化为「写/删主题 JSON 文件」，风险极低 |

## T03 官方接口验证

### 证据一：官方文档（一手，2026-09-10 访问）

来源：<https://opencode.ai/docs/themes>

- 自定义主题存放位置，按优先级从低到高：
  1. 内置主题（嵌在二进制）
  2. 用户配置目录 `~/.config/opencode/themes/*.json` 或 `$XDG_CONFIG_HOME/opencode/themes/*.json`
  3. 项目根 `<project-root>/.opencode/themes/*.json`
  4. 当前工作目录 `./.opencode/themes/*.json`
- 同名主题，高优先级覆盖低优先级。
- JSON 结构：`{ "$schema": "https://opencode.ai/theme.json", "defs": {...}, "theme": {...} }`
- 颜色值支持：hex（`#ffffff`）、ANSI 数字（0–255）、`defs` 引用、`"none"`（继承终端默认）、以及 `{"dark": ..., "light": ...}` 明暗变体。
- theme 字段全集（官方文档示例）：`primary`、`secondary`、`accent`、`error`、`warning`、`success`、`info`、`text`、`textMuted`、`background`、`backgroundPanel`、`backgroundElement`、`border`、`borderActive`、`borderSubtle`、`diff*`（8 项）、`markdown*`（15 项）、`syntax*`（9 项）。

**关键判断：上述字段全部是颜色语义 token，没有任何图片、壁纸、背景图或 `url()` 字段。** 官方主题系统无法表达「用某张图片作背景」。

### 证据二：本机安装源码（一手，只读）

- `out/renderer/index.html` 引用 `./oc-theme-preload.js`。
- `out/renderer/oc-theme-preload.js`（已读全文）：读 `opencode-theme-id`，默认 `oc-2`；**themeId 为 `oc-2` 时直接 return，不注入任何自定义 CSS**；否则读 `opencode-theme-css-<mode>` 注入 `<style id="oc-theme-preload">`。
- 这与上游 `packages/ui/src/theme/context.tsx` 的 `STORAGE_KEYS` 一致（THEME_ID / COLOR_SCHEME / THEME_CSS_LIGHT / THEME_CSS_DARK），样式元素 id 为 `oc-theme`。

**判断：localStorage 中的 CSS 是应用自身写入的主题缓存，用于防首屏闪烁，不是对外开放的 CSS 注入接口。** 外部工具若直接改写该缓存：
1. 应用在启动后由 `ThemeProvider.applyThemeCss` 依据当前主题重新计算并覆盖，注入内容不保证持久；
2. 依赖未公开的内部键名与时序，版本更新即可能失效；
3. 不满足 T23「只引用工具本地图片、不接受远程 URL」之外的稳定性要求。

因此**不作为合规路线**，仅记录事实。

### 证据三：本机官方目录已在使用（一手，只读文件名）

`%USERPROFILE%\.config\opencode\themes\` 下已有 `hanafune.json`、`hanafune-glass.json`。证明官方自定义主题路径在本机可用，用户已熟悉该机制。

### 二手来源（仅辅助，不作为结论依据）

- DeepWiki `anomalyco/opencode` 条目、Codex Infinity 的 `context.tsx` 镜像：与上述一手证据一致，用于交叉印证 `STORAGE_KEYS` 与主题解析流程。
- learnopencode.com 第三方教程：与官方文档一致。

## 路线对比

### 路线 A：官方主题 JSON（推荐为主）

写 `~/.config/opencode/themes/<name>.json`，内容为本工具生成的颜色 token。

- 优点：官方支持、无需修改安装资源、无需进程检查、无需 ASAR 事务；备份即复制原文件；恢复即删除/还原文件；跨版本稳定。
- 缺点：**无背景图片**；无背景遮罩/模糊/不透明度（官方无对应字段，只能通过调整各层级背景色近似）。
- 覆盖：F2 完整，F3 部分，F5 完整且极低风险。F1 需重新定义（见下）。

### 路线 B：ASAR 资源补丁（原型路线）

在 `out/renderer/` 注入 CSS 与图片、改写 `index.html`。

- 优点：可实现背景壁纸，保留原型的核心效果。
- 缺点：需完整实现 T30–T42（进程检查、事务、备份、hash 校验、故障恢复）；随应用更新失效；非官方修改，须显著标注风险。
- 覆盖：F1–F5 全部，但风险与工作量集中在 P3。

### 组合方案

工具同时支持两种输出：默认走路线 A（官方主题），壁纸作为**可选的、明确标注风险的高级功能**走路线 B。两者共用同一套取色与对比度核心。

## T05 首个兼容对象

| 项 | 值 |
|---|---|
| 渠道 | GitHub releases，electron-updater，`owner=anomalyco` / `repo=opencode` / `channel=latest` |
| 平台 | Windows x64 |
| 版本 | 1.18.29 |
| 安装形式 | 用户级安装至 `%LOCALAPPDATA%\Programs\@opencode-aidesktop` |
| 框架 | Electron，资源打包为 `resources/app.asar` |
| 资源布局 | 入口 `out/renderer/index.html`，样式与脚本在 `out/renderer/assets/` |
| 归档指纹 | 152,395,856 字节 / 6,994 条目（**当前值，仅作记录；adapter 应以运行时读取的 package.json version + 归档 hash 为准，不硬编码**） |
| 官方主题接口 | `%USERPROFILE%\.config\opencode\themes\*.json`，schema `https://opencode.ai/theme.json` |
| 支持状态 | 路线 A：已验证可用。路线 B：待实现，需先完成 P3 全部 fixture |
| 未知版本 | 一律只允许预览，禁止应用（T05 硬性要求） |

## G0 验收门：待用户决策

P0 已完成盘点与验证，**但存在必须由用户拍板的分叉**：

1. **保留背景壁纸吗？** 保留 → 必须实现路线 B（P3 大幅工作量 + 非官方风险）；放弃 → 走路线 A，工具变成「图片取色 → 生成官方主题 JSON」，风险与工作量大幅下降，但失去壁纸这一原型核心效果。
2. F1（选图）在路线 A 下如何定位？可保留「从图片取色」，但图片只是配色来源，不进入主题文件。

在用户明确前，不启动 P3（ASAR 事务与补丁）的开发，以免把工作押在可能被否掉的分支上。P1（工程骨架与类型契约）不受影响，可先行。

---

## 更新（2026-09-10）：G0 已决策，走路线 B

用户选择：**保留壁纸，走 ASAR 补丁**。因此路线 A 降级为备用的「仅配色」输出，主路线为受限资源补丁。

### T31 adapter 声明（首个兼容对象）

声明位置：`src/adapters/opencode-desktop.ts`，注册表 `src/adapters/registry.ts`。

| 项 | 值 |
|---|---|
| adapter id | `opencode-desktop-win-asar` |
| 渠道 | `windows-local-user-install` |
| 框架 | `electron-asar`（非此框架一律不套用归档补丁） |
| 包名 | `@opencode-ai/desktop` |
| 已验证版本 | 1.18.29（白名单外一律 unknown，只允许预览） |
| 安装目录名 | `@opencode-aidesktop`（只扫明确登记位置） |
| 资源布局 | `OpenCode.exe`、`resources/app.asar` |
| 注入点 | `out/renderer/index.html` 的 `</head>` 锚点 |
| 允许变更集合 | `out/renderer/index.html`、`out/renderer/oc-theme-custom.css`、`out/renderer/oc-theme-background.jpg` |
| 指纹 | 运行时读取归档 SHA256，不硬编码 |

未实现：真实的归档改写与事务提交（P3b）。当前代码只做只读识别与环境预检。

## 更新（2026-09-19）：新版本适配流程（version-probe 落地，计划 V3）

只读探测脚本 `tools/version-probe.cjs` 已就位（V1 `9821928`，单测 V2 `2e27f68`）。
它回答「补丁机制在某个 OpenCode 版本上能不能用、哪里变了」，**不回答**「能不能发布」。

```
OpenCode 出新版 →
1. 装新版（或更新后）→ node tools/version-probe.cjs --discover
2. 全 PASS → 跑一轮真机闭环（导入→应用→重启→视觉→恢复，授权后执行）
3. 通过 → adapters/opencode-desktop.ts 的 supportedVersions 加版本号，提交
4. 任一 FAIL/WARN → 不改代码，按报告定位结构变化，先评估再动手
```

**硬性口径**：

- **probe PASS 本身不构成发布资格**——白名单更新必须带真机闭环证据，
  与 alpha 验收（`docs/alpha-acceptance.md` A5）同一标准。
- probe 只读：不写安装目录、不启动 GUI；其输出也**不自动**改变 `supportedVersions`。
- 检查判据与生产代码同源（`out/` 里的 `readAsar` 系与 adapter 声明），
  脚本内禁止重抄布局/锚点定义。
- 对**已挂本工具主题**的安装，检查 5（变更集合冲突）会如实 FAIL 并提示先恢复——
  新版本适配探测应在未挂主题的安装上跑，或对已挂主题的安装先走恢复流程。
- 真机验证报告归档：`handoff/version-probe-plan-2026-09-19/evidence/probe-real-20260919.md`。

## 更新（2026-09-21）：两通道放行模型（structural-compat 计划 S1–S5）

上文「白名单外一律 unknown，只允许预览」的口径已被本节的结构验证通道**取代**：
白名单不再是唯一放行依据。`TargetSupportSchema` 三值不变，门径判断（`support !== 'supported'` 拒绝）一行未改。

### 两通道一张门

| 通道 | 条件 | 结果 | UI 呈现 |
|---|---|---|---|
| whitelist | `supportedVersions` 命中 | `supported` + `verifiedBy: 'whitelist'` | 绿色「supported」徽章，行为与之前逐字节一致（不跑结构验证） |
| structural | 未命中，但只读结构验证全过 | `supported` + `verifiedBy: 'structural'` | 提示蓝「结构验证通过」徽章 + 应用前逐项确认框 |
| 都不满足 | — | `unknown`，rejectReason 写明失败的检查项 | 只允许预览，不允许应用 |

### 结构验证判据（单一来源 `src/core/patch/compat-check.ts`，产品链路与 version-probe 共用）

1. **锚点唯一**：`adapter.injection.anchor` 在 htmlEntry 中恰好出现 1 次。
   0 次＝结构已变；≥2 次＝落点不唯一、拒绝（不猜测、不取第一处）；htmlEntry 读不到按 0 次处理。
2. **变更集合归属**：`cssFile`/`imageFile` 不存在＝干净；存在且可识别为本工具产物
   （HTML 带 `HTML_INJECT_COMMENT` 注入标记 **且** CSS 带 `CSS_OWN_BANNER` 生成横幅）＝通过，再应用会覆盖；
   无法确认归属（含只有图片没有 CSS 的孤儿产物）＝按第三方占用拒绝。
3. **unpacked 目录存在性**：信息项，PASS/WARN，永不阻断。

标记常量在 `src/core/patch/markers.ts`，由 stage/css/compat-check 三处共用，防止生成侧与判据侧漂移。

### 竞态重验（apply 入口，本通道的安全核心）

inspect 与 apply 之间归档可能被自动更新换掉。`applyTheme` 在算完 `beforeHash` 后与
`target.fingerprint` 比对：不一致就**对新归档重跑结构验证**——不通过则 `TARGET_HASH_MISMATCH`
拒绝且尚未写任何东西；通过则把 target 的版本与指纹刷新为新归档实测值再继续，
事务记录、备份证据（assessOriginalEvidence / ensureOriginalBackup / createBackup）全部对齐刷新后的 target。

### 显式确认（防「悄悄放行」）

structural 目标的 stage 与 apply **两个入口**都要求 `confirmStructural: true`，缺失即
`STRUCTURAL_CONFIRM_REQUIRED`（安装未修改类错误）。UI 侧对应点击「应用到 OpenCode」时先弹
逐项确认框（列三项检查结论），确认后才带标志进入流程；白名单路径不受影响、零变化。

### 如实边界

- **结构验证 ≠ 完整真机验证**：只证明「注入机制结构适用」，不证明界面效果逐项正常
  （UI 能看 ≠ 全部功能验过）。徽章用提示蓝而非验证绿，确认框明写此边界。
- 应用后若 OpenCode 自动更新，主题可能被覆盖（这同时是竞态重验存在的原因），需重新应用。
- 不猜锚点、不改 `supportedVersions` 内容（白名单更新仍须走 probe＋真机闭环流程）、
  structural 通道不宣称「已验证」。

### 实况记录（2026-09-21）

真机 OpenCode 已自动更新到 **1.18.31**（不在白名单）。probe 只读复跑：结构 6 项 PASS、
白名单检查 WARN；`inspectRoot` 实测返回 `support: 'supported', verifiedBy: 'structural'`——
两通道模型对真实漂移版本的直接实证。
