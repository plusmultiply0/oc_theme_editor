# 变更记录

版本号尚未对外发布，按阶段记录。所有条目均可在 `git log` 与 `handoff/progress.md` 中对照。

## 未发布（当前）

### 修复 — 目标发现扫出满屏无关软件（2026-09-11）

- **现象**：界面「未通过的候选」列出 Fiddler、Postman、VS Code、zotero、Trae、Bandizip 等一屏无关目录。
- **根因**：读卸载登记表时取了**所有**软件的 `InstallLocation` 当候选，而不是先按名称过滤。
- **修法**：先查 `DisplayName`，只在命中 `/opencode/i` 时才读该项位置；登记值去引号与尾部反斜杠；
  同路径去重；补 WOW6432Node 视图；「目录里没有归档」不再计入「未通过」。
- **界面**：面板改名「目标检查」，位置清单默认折叠。
- 回归测试 4 项，总计 130 项通过。

### 重新构建便携包（2026-09-11 第二次构建）

- 产物 `release2/win-unpacked`，约 325 MB；exe SHA256 `3ba432fb…`，app.asar SHA256 `67683383b…`。
- 已核对归档 952 条目：顶层只有 `node_modules` / `out` / `package.json`，源码、测试、私有路径零命中。
- **旧 `release/` 目录没能删掉**（`app.asar` 被占用，判定为安全软件在扫），改输出到 `release2/`。
  旧目录是过期构建，需手动删除，不要拿它做验证。
- 便携包仍**未签名**。

### P0 — 盘点与适配可行性（commit `dbc435a`）

- 只读取证目标归档：`@opencode-ai/desktop` 1.18.29，152,395,856 字节 / 6,994 条目 / 47 个 unpacked 条目。
- **关键结论**：官方主题机制只支持颜色 token，**没有背景图片字段**；localStorage 里的 CSS 是应用内部 FOUC 缓存，不是对外接口。
- 路线决策：保留壁纸，走 ASAR 资源补丁（路线 B）。

### P1 — 工程骨架与契约（commit `78e948b`）

- Electron 36 + React 19 + TS 5.9 + Vite 6 + Vitest 3 + zod。
- 统一错误码与 `Result`；11 类数据的 zod schema；11 个 IPC 通道的白名单桥接。
- 窗口安全基线：`contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开。

### P2 — 图片、配色与可读性引擎（commit `180aa52`）

- magic bytes 判格式、SVG 拒绝、20 MiB / 40 MP 上限。
- 确定性取色（量化 + 频次 + 稳定排序，无随机种子）。
- WCAG 对比度、三层 alpha 合成、token 模板 CSS（变量与选择器取自原型的真实取证）。

### P3a — 目标识别与 adapter（commit `6285774`）

- 只扫明确登记位置；路径安全与包含性检查；adapter 声明；合成 ASAR 识别；进程/权限/磁盘预检。

### P3b — 事务应用与恢复（commit `8f90c0e`）

- 实例独占锁、准备区白名单、备份三语义、同卷 rename 提交、事务日志、启动恢复扫描、两类恢复入口、幂等与 no-op。
- 13 类故障注入的 20 项集成测试。

### P4a — 主进程服务层与 IPC（commit `db5e8b6`）

- 图片登记/导入、目标识别服务、主题生成与逐条可读性报告、准备→应用两段式、两类恢复、进度事件、https 外链。
- 新增 `src/core/theme/report.ts`：报告写明覆盖范围与采样方法，未做真实采样时 `verified` 恒为 false。
- 删除 P1 的 mock 处理器。

### P4b — 桌面界面（commit `51d0476`）

- 三栏布局、九类状态机、拖拽导入、参数防抖重算、应用确认对话框、原版/上一主题双入口、缩放与减少透明度。

### P5a — 集成检查与合规审计（commit `4f0a510`）

- `docs/acceptance.md` 记录命令与退出码；`tools/audit.cjs` 五项自检；便携包 `win-unpacked` 构建与产物核对。

## 已知未完成

- T62–T64：真实安装验收（需授权）。
- T65：干净环境启动验证；便携包签名。
- T72：演示视频（缺真实应用画面，只写了脚本）。
- E2E：0 用例。
