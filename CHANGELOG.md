# 变更记录

按阶段记录。所有条目均可在 `git log` 与 `handoff/progress.md` 中对照。

- `v0.1.0`（tag，提交 `8e6bd04`）是项目首个标记版本，对应第七次构建 `release7`。
- 下面的历史条目记录的是**当时**的事实（含当时的构建目录名与测试数量），
  不代表当前状态；当前候选包与门禁结果见 `docs/release-checklist.md`，
  当前 Alpha 验收见 `docs/alpha-acceptance.md`。

## 未发布（当前）

### 观感修复与功能回合 W1–W2（2026-09-24，随下一候选生效）

- **W1**：注入层为输入区停靠容器补透明规则（`#root [data-component="session-prompt-dock"]`），
  半透明主题下输入框两侧的全宽实底「白条」消失；取证与定案见
  `handoff/visual-fix-plan-2026-09-24/W1-EVIDENCE.md`。
- **W2（默认行为变化）**：「自动调整」遮罩映射段 0.55–0.85 → 0.35–0.60，面板固定不透明度
  0.85 → 0.65；出厂默认面板 0.86 → 0.65。方向由三组小样交 jc 拍板（选样 B），
  对比度阈值与逐步上调兜底不变。小样与真机前后对比见
  `handoff/visual-fix-plan-2026-09-24/W2-SAMPLES.md`。

### 第一批：JPEG 别名（.jfif/.jpe）入口支持（2026-09-12 第六轮）

依据 `handoff/format-review-2026-09-12/NEXT_EXECUTION_PLAN.md`：

- **T1**（`46af497`）：新增 `src/shared/image-formats.ts` 作为格式与扩展名别名的唯一声明
  （纯数据，不 import sharp/fs/electron）。系统对话框、主进程校验、界面文案全部由它派生 ——
  此前三处各写一份，导致标准 JPEG 别名 `.jfif/.jpe` 在选择框里看不见、选到了也被拒。
  只登记内容格式（jpeg/png/webp），别名挂在 jpeg 下，不新增伪枚举，旧数据无需迁移。
  后缀与实际内容不一致但都受支持时按实际内容处理并提示。
- **T2**（`f9a61f0`）：新增程序生成的图片样本与 15 项入口回归
  （选图/拖拽两个入口、全部别名、中文名、大小写、异常与超限、取消选择、PNG/WebP 不回归），
  拖拽路径一路跑到真实 `generateTheme`。JFIF 样本按规范构造，并记录
  「sharp 自身不输出 JFIF 标记」这一事实。
- **T3**（本提交）：合成安装闭环 `.jfif → .png → .webp → 同图 no-op → 恢复上一主题 →
  恢复到首次接管`，按字节与指纹核对；README/CHANGELOG 更新；构建 release7。

门禁：typecheck 0 / lint 0 / 单元 122 / 集成 114 / 真实窗口 e2e 16 / 真实 Electron 主进程 35 /
`npm run dist` 成功 / `verify:package` 28 项 0 失败（964 条目，包内含 jfif 与 jpe）。

**真机应用与视觉走查未执行**（需授权）。第二批（规范化静态背景 + GIF/AVIF/TIFF）与
第三批（核验脚本改为真实完整解码、HTML 结构边界）未开始。


### 真机应用与验收（2026-09-12，jc 授权）

在真实安装上完成 A→B→A 三次应用（用户壁纸 / 纯色图 / 回到壁纸），
最终核验 16 项 0 失败：图片哈希等于用户壁纸、HTML 链接唯一且在 head 内、
CSS 含 `html:root` 与外壳限定规则、逐条完整性 6949 条、无 offset 冲突、
1293 脚本解析通过。真机同时暴露并修复三个额外缺陷：

- **准备区清理阻塞结果**（`27438a3`）：递归删除 224MB 准备区被卡住约 25 分钟，
  而安装早已换好；改为后台执行，残留交给启动时 `cleanAllStages`。
- **预检空间估算 3 份 → 4 份**（`da9aaaf`）：漏算「解包出来的准备区目录」，
  真机在提交阶段 ENOSPC（安全机制正确中止，安装未被修改）。
- **live-cli 启动清理加 30s 上界**（`0d47453`），并让它遵守 `THEME_SWITCHER_NO_REGISTRY`。

新增 `tools/verify-real-install.cjs`（真实安装写入结果的只读核验，支持 `--deep`）。
**仍需人工**：启动 OpenCode 肉眼验收各区域与 Portal，未做真机 DOM 探针与真实截图。


### 背景图片不显示：四项渲染/门禁缺陷（2026-09-12 第五轮）

依据 `handoff/background-incident-2026-09-12/BACKGROUND_FIX_PLAN.md`，每项一个提交：

- **F1**（`525d072`）：官方启动后把 `style#oc-theme`（普通 `:root`）append 到 head，
  位置在助手样式表之后，同特异性下把助手的半透明变量盖成实色，图片加载成功却被挡住。
  token 声明改用 `html:root`（0,1,1）；同步纠正两处「最后加载即可覆盖」的错误注释。
- **F2**（`3a3621d`）：`--background-stronger` 改为跟随面板透明度；
  大面积 NewLayout 外壳（限定选择器）不再额外叠一层底色。
- **F3**（`c4a04af`）：去掉「HTML 必须变化」的门禁（injectLink 本就幂等，换图时 HTML 不该变），
  改为结构性校验 `verifyStagedHtml`：链接唯一、href 正确、在 head 内、标记唯一。
- **F4**（`216e01e`）：区分局部层 alpha（CSS/预览）与从图片起的累计 alpha（报告），
  修掉气泡层把累计值当局部值画导致的 1-(1-p)³ 重复计算。

新增 `tests/e2e/background-cascade.spec.ts`（8 项，含像素级可见性与累计 alpha 实测）、
`tests/integration/stage-idempotence.test.ts`（9 项）、`tests/unit/surfaces.test.ts`（6 项）。
验证：typecheck 0 / lint 0 / 单元+集成 205 项 / 真实窗口 e2e 16 项 / 真实 Electron 主进程 35 项。
**未做真机应用**（需授权），`release4/` 不含本次修复。

### 按 P0 审查报告 R1–R8 的修复（2026-09-11 第三轮）

审查报告见 `handoff/review-2026-09-11/REVIEW.md`。本轮按「先修识别 → 修备份语义与旧主题冲突 →
统一预览与可读性 → 补 GUI 闭环测试」的顺序处理，**没有**用「把应用按钮强行启用」的方式绕过任何一条。

**R1 识别失败：Electron 把 ASAR 当目录**

- 新增 `src/core/patch/physical-fs.ts`：物理文件系统访问层。Electron 主进程的 `fs` 被包装过，
  路径含 `.asar` 的会被当虚拟目录（`isFile=false`、`size=0`）；识别、stat、hash、备份、复制、
  替换、恢复一律改走 `original-fs`。
- 新增 `src/core/patch/archive-io.ts`：归档库 I/O 隔离层。`@electron/asar` 内部直接 `require('fs')`，
  无法注入；改为在调用归档库时**临时**打开 `process.noAsar` 并串行执行，用完立刻恢复
  （不设全局长期开关，否则工具自身从 app.asar 加载模块会一起坏掉）。
- 新增 `tools/electron-fixture-e2e.cjs` + `tests/integration/electron-runtime.test.ts`：
  在**真实 Electron 主进程**里对合成安装跑 识别 → 生成 → 准备 → 应用 → 恢复 → 启动恢复扫描，35 项断言全过。
  这是 Node 测试永远抓不到的一类缺陷。

**R2 备份语义：已修改的安装被当成原版**

- `alreadyPatched`（只看有没有本工具的注入条目）**删除**。新增 `src/core/patch/original-evidence.ts`：
  原版必须由「已登记的出厂指纹」证明，指纹表默认为空（诚实边界，补录办法见 `docs/original-evidence.md`）。
- `BackupRecord` 增加 `evidence` 字段；旧元数据读取时自动迁移：靠标记缺失推断的 `original` 记录
  降级为「未验证」，备份文件本体不动，迁移前留 `meta.json.pre-r2.bak`。命中指纹时会自动升级。
- 恢复入口拆成三个：`previous`（上一主题）/ `original`（**仅在有出厂证据时可用**）/
  `takeover`（首次接管快照，界面写明它不是出厂界面）。IPC、界面、测试同步更新。

**R3 旧主题与新主题同时加载**

- 新增 `src/core/patch/legacy-theme.ts`：识别 HTML 里活跃的主题层，按「来源标记 + 内容指纹」
  区分「本工具的层 / 已确认的原型旧主题 / 来源不明」。
- 准备阶段会撤下已确认的旧主题链接（文件本体留在归档里可恢复），遇到来源不明的第三方样式层
  直接以 `THEME_CONFLICT` 拒绝，不自动覆盖。确认对话框列明「会撤下哪些旧主题层」。
- 真机取证发现：`snow-theme.css` 的内容其实已被后续的粉彩主题**原地覆盖**过，
  因此标记与内容指纹要分开看——标记证明来源，内容用来说明撤下的到底是哪一套。

**R4 可读性报告没有检查实际显示状态**

- 报告从 12 条扩到 28 条：侧栏、选中项、对话气泡（双层）、用户消息气泡、输入区、菜单、
  次级按钮、主按钮 default/hover/pressed、边框、焦点环、状态色、diff 色。
- 底色改为对**多个图片采样点逐点合成取最差**，条目上标 `estimated` 与采样点数；
  界面不再把估算说成「实际底色」。
- 修掉侧栏 `panelOpacity-0.06` 与报告口径不一致、普通导航项被 `opacity:.6` 额外淡化两处缺陷。
- 连带修了三个真实的对比度缺陷：链接（主色当正文用只有 3.1）、主按钮 pressed（3.77）、
  焦点环（2.26）。新增 `accentText` token；token 推导改为对候选底色的最差值做保障。

**R5 预览、输出、参数生效范围不一致**

- 新增 `src/core/theme/surfaces.ts`：唯一的层级模型（图片 → 遮罩 → 面板 → 叠加 → 文字），
  预览、对比度计算、写入归档的 CSS 三处共用同一组不透明度函数。
- 面板在输出里改成真正的 `rgba()`（原来被合成成 HEX 实底，透明度变成「改色」）。
- 「减少透明度」进入 `ThemeSpec`，成为真实主题参数（原来只存在于 React 预览状态）。
- 模糊分支修正：遮罩改成叠在图片**之上**的独立层（原来遮罩被压在图片下面，等于没生效）。
- 从 schema 移除从未支持、却被输出成非法值的 `backgroundPosition`。
- 按钮按 `data-variant` 分开处理，不再把 destructive / ghost 一起染成主色。

**R6 识别失败后没有恢复路径**

- 新增 `chooseTargetDirectory` IPC：目录由主进程对话框选出并登记，renderer 仍拿不到也不传路径。
- 界面增加「重新检测」「选择安装目录」与多目标选择；未通过项显示具体错误码与原因。
- 底部就绪文案改由「目标 + 对比度 + 待恢复状态」共同决定，不再与禁用原因互相矛盾。

**R7 启动恢复扫描没接到实际流程**

- 新增 `src/main/services/recovery-service.ts`，并在 `src/main/index.ts` 启动时 `bootstrap()`：
  清理残留准备区 + 扫描所有实例的未完成事务。
- 落账方向由磁盘事实校验（`needs_recovery` 不允许写成 `applied`）；
  有阻断性事务时 `OperationService.apply` 在进入事务之前就被拒绝。
- 界面新增「待恢复」面板。

**R8 发布门禁**

- `test:e2e` 去掉 `--pass-with-no-tests`：零用例不再返回 0。
- 新增真实窗口的 Playwright 用例 `tests/e2e/theme-switcher.spec.ts`（8 项，含拖拽导入、
  确认框披露、真实改写合成归档、恢复闭环）。隔离手段：`LOCALAPPDATA` 指向临时目录、
  关掉注册表扫描、开工前断言目标在临时目录内。
- 新增 `npm run test:e2e:electron` 与 `npm run verify`（类型 + lint + 单测 + 集成 + 构建 + E2E）。
- `tools/audit.cjs` 区分交付内容与本地诊断产物：`tools/*result*.json`、`tools/*.png`、
  `handoff/**` 豁免路径/用户名规则（它们故意记录本机路径），**凭证规则不豁免**，
  并在输出里显式列出豁免清单。

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
