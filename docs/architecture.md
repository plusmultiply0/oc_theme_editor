# P0 架构方案

日期：2026-09-10。负责人：单 agent。为 P1 工程骨架提供设计依据。
路线 A（官方主题 JSON）与路线 B（ASAR 补丁）共用同一套核心，差异仅在末端 adapter。

## 分层

```
renderer (React + TS)  ──受限 IPC──▶  main (Electron 主进程)
                                        ├── theme core   取色 / 语义 token / CSS / 对比度
                                        ├── adapter A    官方主题 JSON（读写用户配置目录）
                                        ├── adapter B    ASAR 资源补丁（路线 B，待授权）
                                        └── tx store     事务、备份、恢复
```

硬性约束（来自计划第 3、5 节）：

- renderer 不获得任意文件读写、shell 或完整 Node 权限；`nodeIntegration: false`，启用 `contextIsolation`，不加载远程页面，不用 `eval`。
- 图片、目标、操作一律使用主进程登记的 **ID**；renderer 不得传任意路径要求写文件。
- 所有 token、枚举、数值范围在主进程复验。
- 运行数据放系统用户数据目录，**不进源码、不进安装包、不进 OpenCode 用户配置目录**。

## 目录

```text
handoff/                 执行计划与状态（已存在）
docs/                    discovery / compatibility / architecture（本文）
tools/                   inspect-asar.cjs（只读 ASAR 探测，P0 已建）
src/main/                窗口、IPC、文件选择、系统服务
src/preload/             最小允许列表桥接
src/renderer/            编辑器、参数面板、模拟预览
src/core/theme/          取色、语义 token、CSS、对比度
src/core/patch/          事务状态、备份、恢复（路线 B 使用）
src/adapters/            official-theme（A）与 asar-resource（B）
src/shared/              公共类型、schema、错误码
tests/unit/  tests/integration/  tests/e2e/  tests/fixtures/
```

旧原型 `OpenCode/_Theme/_Switcher/` 原样保留，新工程不改动它。

## 路径解析约定

沿用 P0 前已完成的脱敏约定，任何本机路径不得硬编码：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `OPENCODE_APP_DIR` | `%LOCALAPPDATA%\Programs\@opencode-aidesktop` | 安装目录（路线 B） |
| `OPENCODE_USER_CONFIG` | `%USERPROFILE%\.config\opencode` | 官方主题目录（路线 A） |
| `ASAR_STAGE` | — | 若引入 ASAR 打包库，须纳入项目依赖，不得引用个人目录 |

源码与文档中一律使用上述变量名或占位符，禁止出现账户名、盘符绝对路径。

## 核心数据流

1. **选图**：renderer 请求 `pickImage` → 主进程打开系统对话框 → 返回 `imageId`（原图只读）。
2. **导入**：`importImage(imageId)` → 主进程校验 magic bytes 与实际解码、计算 hash、生成工作副本与缩略图（T20/T21）。
3. **取色**：`generateTheme(imageId, params)` → theme core 确定性量化 → `ThemeTokens`。
4. **分析**：`analyzeContrast(tokens, params)` → `ContrastReport`（T25/T26）。
5. **应用**：
   - 路线 A：`applyTheme` 写入 `<userConfig>/themes/<id>.json`，备份同名原文件。
   - 路线 B：`discoverTargets` → `inspectTarget` → `stageTheme` → `applyTheme`（T30–T42）。
6. **恢复**：`listBackups` / `restoreTheme`，区分「上一主题」与「原版」（T41）。

## 契约对象（P1 冻结，运行时 schema 校验）

| 对象 | 字段要点 |
|---|---|
| `ThemeSpec` | schemaVersion、imageId、mode、palette、overlayOpacity、panelOpacity、blurPx、backgroundPosition |
| `ThemeTokens` | background / panel / text / muted / primary / onPrimary / hover / pressed / border / focus / selection；语义状态色（error/warning/success/info、diff、syntax）分开 |
| `TargetInfo` | targetId、真实绝对路径、渠道、版本、adapterId、指纹、支持状态、拒绝原因 |
| `ContrastReport` | 元素/状态、前景背景、比值、目标值、通过/失败、验证范围与采样方法 |
| `OperationManifest` | schema、operationId、targetId、版本、adapterId、before/after/backup hashes、主题摘要、状态、时间、前序操作 |
| `Result<T>` | `{ success: true, data }` 或 `{ success: false, error: { code, message, recoveryHint } }`，不得把异常吞成成功 |

桥接方法（T13）：`pickImage`/`importImage`、`generateTheme`、`analyzeContrast`、`discoverTargets`、`inspectTarget`、`stageTheme`、`applyTheme`、`listBackups`、`restoreTheme`、`getOperation`。

## 路线 A 与路线 B 的差异

| 维度 | A 官方主题 JSON | B ASAR 补丁 |
|---|---|---|
| 写入位置 | 用户配置目录 `themes/*.json` | 安装目录 `resources/app.asar` |
| 需要进程检查 | 否 | 是（T32） |
| 需要事务/备份 | 仅需备份同名主题文件 | 需要完整 T34–T42 |
| 版本耦合 | 低（schema 稳定） | 高（随版本失效） |
| 支持背景图 | 否 | 是 |
| 失败影响 | 主题文件损坏，可删除恢复 | 安装资源损坏，须依赖备份恢复 |
| 适配声明 | 官方支持 | 非官方本地资源定制，须显著标注 |

两条路线共用：取色、token 生成、对比度分析、预览、主题管理 UI。adapter 接口统一为 `inspect / stage / apply / restore`，主进程按 `TargetInfo.adapterId` 分派。

## 技术选型（P1 锁定，当前为计划）

- Electron 主进程 + React + TypeScript renderer；独立 TS core。
- 图片解码：选成熟库，支持 PNG/JPEG/WebP 与 EXIF 方向；不自行实现解码。
- 校验：schema 用运行时校验库，不只依赖 TypeScript 类型（T12）。
- 测试：unit（算法）、integration（合成安装/故障注入）、e2e（界面）。

具体依赖与版本在 P1 通过 `npm` 安装后写入 `package.json`，并核实许可（T35 要求辅助库纳入项目）。

## 未完成与待定

- 路线 A/B 的最终取舍待用户决策（见 `docs/compatibility.md` 的 G0 节）。
- 依赖清单、版本、锁文件：P1 确定。
- ASAR 写入与替换的 Windows 语义验证：P3 在合成 fixture 中完成。

---

## 事务与恢复模型（P3b 落地）

代码位置：`src/core/patch/`（`lock.ts` / `layout.ts` / `backup.ts` / `stage.ts` / `commit.ts` / `txlog.ts` / `recovery.ts` / `restore.ts` / `apply.ts`）。

### 状态机

```text
inspected → staged → backed_up → committing → applied
                │         │            │
                └─────────┴────────────┴──→ failed          （提交前，安装未变）
                                            needs_recovery  （提交后无法自证，等人处理）
```

恢复是一次新的前向操作，状态标记为 `restore-previous` / `restore-original`，不改写历史记录。

### 提交顺序与补偿

1. 复核目标 hash（防准备期被升级/被其他进程改动）
2. staged 文件写到**目标同目录**的临时文件（同卷，保证 rename 是同卷移动）
3. `rename` 覆盖目标 —— 同卷 rename 不会写出半截文件
4. 复核目标 hash，等于预期才标 `applied`

第 3 步之前失败 → 删除临时文件，安装原封不动。
第 3 步之后失败 → 按磁盘事实判定，**绝不盲目回滚**，落 `needs_recovery` 由用户决定。

### 关键取证：unpacked 条目必须保留

本机只读探测发现目标归档有 **47 个 unpacked 条目**（`@lydell/node-pty-win32-x64`、`@msgpackr-extract`、`@parcel/watcher-win32-x64`、`msgpackr-extract` 的原生模块），实体在 `resources/app.asar.unpacked/`。

因此重打包**不能**用 `createPackage` 一把梭：那会把原生模块塞回归档，导致应用启动即崩。
`stage.ts` 的做法是从原始 header 收集 unpacked 集合，再用 `createPackageFromStreams` 逐条目重建，
打包后复核 unpacked 集合与原归档完全一致，否则整个 stage 判失败。

### 备份语义

- `original`：工具首次接管时的状态。若首次接管就发现目标已含本工具注入的条目，
  标记 `pristine=false`，并**禁用「恢复原版」**——不能把已经被改过的状态冒充出厂原版。
- `previous`：上一次成功应用前的状态，用于「恢复上一主题」，只保留最近 3 份。
- `pre-restore`：执行恢复前的现场备份，保证恢复失败也不会更糟。

所有备份复制后重新算 SHA256 校验，不符即删坏备份并报错，不留假备份。

### 并发保护

锁文件用 `wx` 独占创建 + 进程内持有集合。同进程内二次操作同样被拒：
只靠「pid 是自己就当残留锁清理」会把并发保护整个绕过。

---

## 更新（2026-09-11）：物理归档 I/O 层与统一的主题层级模型

第三轮审查（`handoff/review-2026-09-11/REVIEW.md`）暴露了两处架构级缺口，本轮补上。

### 新增的一层：物理归档 I/O

```
main / core ──▶ physical-fs.ts   所有涉及应用归档的真实读写（original-fs）
            ├▶ archive-io.ts     @electron/asar 的薄封装（Electron 下临时关 asar 解释，串行执行）
            └▶ patch/*           识别、备份、打包、提交、恢复
```

原因：Electron 主进程的 `require('fs')` 被包装过，路径里出现 `.asar` 的会被当虚拟目录
（`isFile=false / size=0`），同一份代码在 Node 测试里全绿、在真机上一跑就「找不到归档」。
因此**规则是：凡涉及应用归档的 I/O 一律走 physical-fs / archive-io，不得直接 `import fs from 'node:fs'`。**

`archive-io.ts` 的三条纪律（为什么不全局关 asar）：

1. 只在调用归档库那一小段时间内打开 `process.noAsar`，用完立刻恢复——
   工具自身模块也在归档里，全局关掉会破坏模块加载；
2. 所有物理归档操作**串行**执行，进程级开关不允许并发交叉；
3. `try/finally` 保证恢复，归档库抛错也不会把开关漏在打开状态。

### 新增的一层：统一主题层级模型（surfaces.ts）

```
图片层 ─▶ 图片遮罩层 ─▶ 区域面板层 ─▶（可选）区域叠加层 ─▶ 文字
```

预览、对比度报告、写入归档的 CSS 三处**共用**同一组不透明度函数
（`panelAlpha` / `bubbleAlpha` / `overlayAlpha` / `REGION_ALPHAS`）。
这是修「预览半透明、输出实底、报告第三种口径」这类缺陷的唯一办法：
不是让三处「恰好一致」，而是让它们没有第二种算法。

### 恢复入口的语义

```
restore(kind)
  ├── previous   恢复上一主题（应用前的状态）
  ├── original   恢复出厂原版   ← 仅当备份带 evidence='factory'（有出厂指纹证据）
  └── takeover   恢复首次接管快照 ← 没有证据时的诚实入口，界面写明它不是出厂界面
```

判定逻辑在 `original-evidence.ts`，指纹表默认为空（见 `docs/original-evidence.md`）。

### 启动流程

```
app.whenReady
  └─▶ RecoveryService.bootstrap()
        ├─ cleanAllStages()      清理各实例遗留的准备区
        └─ scanAllPending()      按「磁盘事实」给未完成事务定性
              └─ needs_recovery 的存在会让 OperationService.apply 在进入事务前被拒
```

之前 `scanPending` 只有函数与单测、没有任何调用点；现在它挂在启动流程上，并有闸门保护写入路径。
