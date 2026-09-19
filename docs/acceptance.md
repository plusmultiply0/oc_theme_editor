# 验收记录（历史轮次）

> 原则：每条命令记录**真实输出与退出码**；没跑的一律写「未执行」，不把「没有用例」当成「通过」。
>
> **这是历史留档**：下面按轮次记录 2026-09-11 ~ 09-12 各次执行的真实结果，
> 其中的构建目录名（`release2/` 等）、测试数量、未完成项都是**当时**的事实。
> **当前 Alpha 候选的验收请看 `docs/alpha-acceptance.md`**；
> 当前该用哪个包看 `docs/release-checklist.md`。旧条目不再回填成功。

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
| `npm run test:unit` | 0 | 4 文件 / 82 项通过 |
| `npm run test:integration` | 0 | 3 文件 / 48 项通过 |
| `npm run test:e2e` | 0 | **0 个用例**（`--pass-with-no-tests`），E2E 未实现，见 `tests/e2e/README.md` |
| `npm run build` | 0 | 产出 `out/main/index.js`、`out/renderer/index.html` |
| `npm run audit` | 0 | 路径/凭证/产物/许可/IPC 五项检查全部通过（见下） |
| 便携包构建 | 0 | 产出 `release2/win-unpacked`（325 MB，dir 目标）；指纹见 `docs/release-checklist.md` |

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
- [ ] 恢复到首次接管时 → jc 确认回到接管时状态（**不承诺是出厂界面**；
      当前指纹表为空，不会有「恢复原版」入口）
- [ ] 每个写入阶段重新预检（进程 / 写权限 / 磁盘）

---

## 6. P5c 回归（2026-09-11 第三轮，按 P0 审查 R1–R8）

前置：`npm run build`（0，主进程 + renderer）。所有用例都跑在临时目录的合成安装上，
**没有触碰真实安装**；真机侧只做了只读取证（`tools/inspect-asar.cjs`、`tools/dump-official-css.cjs`）。

| 命令 | 退出码 | 结果摘要 |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无输出 |
| `npx eslint .` | 0 | 无告警 |
| `npx vitest run tests/unit` | 0 | 4 文件 / **96 项** |
| `npx vitest run tests/integration/{discover,transaction,main-services,main-recovery}.test.ts` | 0 | 4 文件 / **51 项** |
| `npx vitest run tests/integration/electron-runtime.test.ts` | 0 | 真实 Electron 主进程，**35 项断言**全过（`tools/electron-fixture-e2e-result.json`，逐条落盘） |
| `npx playwright test` | 0 | **8 项真实窗口闭环** |
| `npm run audit` | 0 | FAIL 0 / WARN 0；路径/用户名规则对本地诊断产物与 `handoff/` 豁免（输出里显式列出），凭证规则不豁免 |

### 6.1 这轮真的发现了什么（不是重跑一遍旧断言）

| 发现 | 证据 | 处理 |
|---|---|---|
| Electron 主进程 `fs.statSync('…/app.asar')` 返回 `isFile=false / size=0` | `tools/asar-probe-result.json`（真实 Electron 运行时） | 全部归档 I/O 走 `original-fs`（R1） |
| 真机 HTML 同时挂官方 CSS、原型旧主题与本工具主题；旧主题用 `#root { --x: … !important }` | `tools/inspect-asar.cjs --read out/renderer/index.html` | 准备阶段撤下已确认的旧主题层（R3） |
| 真机 `snow-theme.css` 的内容其实是**粉彩主题**（原型原地覆盖过） | 同上 | 来源标记与内容指纹分开判定（R3） |
| 真机备份 `original` 与 `previous` 哈希相同且 `pristine=true` | `%LOCALAPPDATA%\OpenCodeThemeSwitcher\instances\…\backups\*\meta.json` | 备份语义改为证据制（R2） |
| 多采样点取最差后暴露 4 个真实对比度缺陷：链接 3.1、主按钮 pressed 3.77、焦点环 2.26、用户消息气泡 4.37 | 单元/集成测试输出 | 修推导逻辑（新增 `accentText`、三态保障、按最不利底色保障），不是放宽目标（R4） |
| 无显示会话下 Electron 的 GPU 子进程反复重启，`app.exit()` 被拖住约 3 分钟 | `tools/electron-fixture-e2e-result.json` 写出后进程仍不退出 | 截图/fixture 工具改 `process.exit()`（结果同步落盘），并统一 `--disable-gpu --no-sandbox --in-process-gpu` 等开关；测试改监听 `exit` 而非 `close` |

### 6.2 修正此前的记录

- 第 2 节里「`npm run test:e2e` 0 = 0 个用例」**作废**：现在 `test:e2e` 是真实窗口闭环
  （8 项），且命令已去掉 `--pass-with-no-tests`——零用例会让门禁失败。
- 第 3 节「IPC 三处一致：14 个通道」→ 现在 **17 个通道**（新增 `chooseTargetDirectory`、
  `getRecoveryStatus`、`resolveRecovery`），脚本自动核对通过。
- 第 5.4 节「恢复原版」的预期要改：在没有出厂指纹证据时，「恢复原版」入口**不会出现**，
  可用的是「恢复到首次接管时」。当前真机那份 `original` 备份已被降级为「首次接管快照」
  （下次读取元数据时自动迁移，迁移前留 `meta.json.pre-r2.bak`）。

### 6.3 仍未执行

- **T64 真机视觉走查**：需要 jc 启动 OpenCode 逐项确认（第 5.3 节清单仍有效）。
  下一次应用的确认框会列明会撤下的旧主题层。
- **T65 干净环境启动验证**。
- 出厂指纹登记（可选）：按 `docs/original-evidence.md` 补录后「恢复原版」入口才会出现。
- `npm run dist` 的便携包**未重新构建**：本轮改了大量源码，`release2/win-unpacked` 是旧产物，
  重新发布前必须按第 4 节流程重打包并重新核对归档内容。

---

## 7. 真机应用与验收（2026-09-12，背景事故 F1–F4 之后，jc 授权）

前置：OpenCode 完全退出（相关进程 0）；`live-cli precheck` 通过（1.18.29 supported、
进程 idle、目录可写）。执行走 `tools/live-cli.cjs`，与 GUI 同一服务层与事务逻辑。

| 步骤 | 结果 |
|---|---|
| 应用 A（用户壁纸 `80fbd6a9…`） | applied，归档 `2b75faf7…` |
| 应用 B（纯色图 `ae03d212…`） | applied，归档 `89748b46…`（连续换图成功，F3 在真机成立） |
| 再应用 A | applied，回到 `2b75faf7…` |

最终核验（`npm run` 级别工具 `tools/verify-real-install.cjs --deep`）：**16 项 0 失败**——
图片字节与哈希等于用户壁纸、HTML 链接唯一且在 head 内、CSS 含 `html:root` 与外壳限定规则、
逐条完整性 6949 条、无 offset 冲突、1293 脚本解析通过（2776 个 ESM/TS 声明如实跳过）。

真机同时暴露并修复三个额外缺陷：准备区清理阻塞结果（改为后台）、
预检空间估算少算一份（3→4 份）、live-cli 启动清理无上界（加 30s）与注册表开关。

**未完成**：OpenCode 启动后的肉眼验收（首页/会话/侧栏/输入/菜单/旧新布局、
主题与明暗切换、重启后是否保留、Portal 与终端）——必须由 jc 亲自看。
未做真机 DOM 探针，未截真实窗口图。

---

## 8. 本机环境前提与不可验证项（2026-09-18，复审 G1 登记）

**环境前提（结构性，非产品缺陷）**：本机当前会话无可用独立 GPU 进程。
已证事实（取证见 `handoff/review-2026-09-17/evidence/f4-candidate-attempt.md`）：
新旧候选以空参数 spawn 同样以 0x80000003（GPU FATAL）崩溃；仅带
`--in-process-gpu` 系参数能起窗口。

由此得出**不可验证项**：

| 项 | 状态 |
|---|---|
| `smoke:gui`（发布链默认参数，等价真实双击） | 本机**不可验证**——空参数在本机必然失败，属环境限制；不判产品通过，也不判产品失败 |
| GUI 正常配置的真机验收（含 T65 干净环境核对） | **待执行**——移到有显示会话的机器上与 T65 合并一次跑完 |

**诊断模式与发布资格的边界**：`--in-process-gpu` 只是已文档化的**诊断模式前提**
（`tools/smoke-packaged.cjs --diagnostic-gpu` / `--diagnostic-degraded`），其结果
不构成发布资格（退出码非 0）；该参数**不得**进入 `DEFAULT_ARGS`（现为空数组，
F2 修正；机器核对在 `tests/unit/smoke-packaged.test.ts`——「DEFAULT_ARGS 本身为空」
与「含 --in-process-gpu → 不构成发布资格」两条断言）。把 workaround 塞回默认参数
等于重演 F2 要修的错误。

**候选 `20260918013040-b43dc44-a0a453` 现状**：测试链全绿（unit/integration/
e2e/e2e:electron/audit/dist），停在 smoke:gui；只到 `win-unpacked`，未 zip、未登记，
`ALL_GREEN` 未产出（也不应人为补上）。处置待用户决策：在有显示会话的机器重跑
完整链产出真实 `ALL_GREEN`（推荐），或本机 `--skip-gui` 跑 `DEV_BUILD_COMPLETE`
（仅验证链路，不可发布、不更新当前候选入口）。

### 8.1 修订追加（2026-09-19，alpha.2 跑链实证）

上节「本机不可验证」的结论**范围过宽，现予修订**：崩溃并非本机结构性不能跑 GUI，
而是**会话类型**差异——

- **agent 自动化会话**：无独立 GPU 进程可派生，空参数 spawn 必然 0x80000003 崩溃
  （上节取证在该类会话中做出，结论对其仍然成立）。
- **桌面交互会话**：2026-09-19 jc 本人在桌面 cmd 会话手动运行整条
  `npm run release:build`，12 步全绿，其中 `smoke:gui` 以**默认空参数**（与双击等价）
  真实通过（`SMOKE_OK`，21.1s），末行 `ALL_GREEN buildId=20260919055321-f8bb4fb-e00e50`。
  先例佐证：A5 轮（`handoff/alpha-release-evidence/a5-round-20260918.md`）jc 双击
  候选 exe 成功。

**修订后的可操作结论**：`smoke:gui` 与 GUI 真机项**不需要换机**，本机由 jc 在
桌面会话手动执行即可；agent 只可做只读核验与诊断模式跑（不构成发布资格）。
上节候选 `20260918013040-b43dc44-a0a453` 的处置选项随之变化：换机不再是必要项，
该候选仍停在 smoke:gui、未登记不可发布，是否弃用并入 alpha.2 线待用户决策。
三条过程偏差与新候选登记详见 `docs/alpha-acceptance.md` §5.0 与
`docs/release-checklist.md` §2.3/§3。
