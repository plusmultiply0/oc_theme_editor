# F2 + F3：冒烟工具整改与取证

日期：2026-09-17
源码基线：`8b3b8f8`（HEAD 未改）；本轮只改 `tools/smoke-packaged.cjs` 与其单测。

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 默认启动参数（F2） | **空数组**，与用户双击等价；GPU workaround 只在显式诊断模式 |
| 资格判据（F2） | 未追加任何参数才构成发布资格；GPU 诊断通过**不能**覆盖正常配置失败 |
| 正常配置实测 | ✅ **`SMOKE_OK` exit 0**（候选 `20260916114818-8b3b8f8-f4e1c6`，args=[]） |
| 错误通道（F3） | 自 `firstWindow()` 起（早于文档加载）+ 主进程 `web-contents-created` 含**回填已存在窗口** |
| 时序场景夹具（真实 Electron） | ✅ **4/4 符合预期**（`SMOKE_FIXTURE_OK`） |
| 运行时证据 | 记录真实 argv 与运行时 webPreferences（不只是调用前的数组） |
| 单测 | `tests/unit/smoke-packaged.test.ts` **31/31 通过** |
| typecheck / lint / audit | 退出 0 / 0 / 0（FAIL 0 WARN 0） |

## 1. F2：默认参数改为空

旧默认 `DEFAULT_ARGS` 含 `--disable-gpu`、`--disable-gpu-compositing`、
`--disable-software-rasterizer`、`--disable-dev-shm-usage`，而资格函数只排除
`no-sandbox` / `in-process-gpu` —— 于是「关了 GPU」的配置被算作可发布的默认启动验收。
关 GPU 可能掩盖默认渲染路径的问题；这不等于应用真有 GPU 故障，
而是**这条绿色证据证明不了未加参数时也正常**。

改法：

- `DEFAULT_ARGS = []`；
- 新增 `DIAGNOSTIC_GPU_ARGS`，只在 `--diagnostic-gpu` 时追加；
- `DEGRADED_ARGS` 仍在 `--diagnostic-degraded` 时追加；
- `judgeReleaseQualification` 改为「**未追加任何参数**才构成发布资格」，
  并逐类点名参数（GPU workaround / 安全降级 / 额外参数）；
- 新增纯函数 `launchConfig()`，让测试能断言**实际传给 launch 的配置**
  （F2 验收明确要求不能只测资格纯函数）。

### 1.1 「正常配置独立通过」的实测

先确认前提成立，再改默认值——否则就是把门禁改成红的：

| 配置 | 结果 |
|---|---|
| **空参数（等价双击）** | ✅ 启动成功，`title="OpenCode 换肤助手"`，`applyVisible=true` |
| 仅 GPU workaround | ✅ 启动成功（所以旧默认确实更容易起窗口——但语义不等价） |

改完后对当前候选跑正式冒烟（**默认配置**）：

```
SMOKE_MODE default
SMOKE_ARGS []
SMOKE_PLATFORM win32
SMOKE_EXE_SHA256 ed8ee97cddb8afadd7d3c9975aa661a4dfebc9bbe9e27fa7165b92c158426cba
SMOKE_READY ready=true timedOut=false waitedMs=1019 polls=1 settleMs=1500
SMOKE_OK
exit=0
```

### 1.2 运行时证据（不再只打印调用前的数组）

```
SMOKE_RUNTIME argv=["…\\win-unpacked\\OpenCodeThemeSwitcher.exe","--inspect=0","--remote-debugging-port=0"]
SMOKE_RUNTIME webPreferences={"contextIsolation":true,"nodeIntegration":false,"sandbox":true,
  "webSecurity":true,"nodeIntegrationInSubFrames":false,"webviewTag":false,…} windowsAtHook=1
```

`argv` 与 `webPreferences` 都取自**运行中的主进程**（`app.evaluate`），
`windowsAtHook=1` 说明主进程诊断确实回填了已存在的首个窗口。

> 附注（撤销一个中途疑点）：本机 playwright-core 1.63.0 的自动 `--no-sandbox` 分支受
> `platform() === linux` 限制，Windows 不命中。运行时 `webPreferences.sandbox=true`
> 也直接印证：当前 Windows 候选**没有**被关沙箱。

## 2. F3：错误通道与就绪边界

### 2.1 通道建立时机

| 通道 | 覆盖起点 | 说明 |
|---|---|---|
| `app.on('window')` | `launch()` 返回后立即 | 覆盖后续创建的窗口 |
| 页级 `console` / `pageerror` / `crash` | `firstWindow()` 返回后立即 | 该方法在**窗口创建时**即返回，早于文档加载 |
| 主进程 `web-contents-created` + **回填已存在窗口** | `app.evaluate` 装上后 | 补页级看不到的 `preload-error` / `did-fail-load` / `render-process-gone` |

**实测依据**（真实 Electron 夹具，`early-error`）：在 `<head>` 内联脚本里
`console.error` + `throw`，页级监听**能**捕获——因为 `firstWindow()` 早于文档加载返回。

**已排除的通道**：Node 侧 `app.process().stderr` 拿不到任何输出——
Playwright 完整消费了子进程 stdio（实测连加载后主动 `console.error` 都捕获不到，
stdout/stderr 总长度 0）。所以「读子进程 stderr」不是可用方案，未采用。

**诚实边界**：`launch` 之前的主进程错误不在覆盖范围内。工具会打印
`SMOKE_COVERAGE` 明确说明，不假装全覆盖。

### 2.2 就绪判据

- 就绪 = 标题精确匹配 + 主控件可见 + 可见文本 ≥ 下限，三者同时满足；
- **有界轮询**（`readyTimeoutMs` 20s / 间隔 250ms），不用固定 sleep；
- 就绪后只取**一次**快照；
- 未就绪 → 失败（`界面在 …ms 内未就绪（超时失败）`），不是继续等或降级放行。

### 2.3 观测窗口（为什么需要，以及它不是掩盖手段）

就绪只能证明「此刻渲染好了」，证明不了「之后不报错」——启动期的异步失败
（延迟抛错、子资源失败、preload 报错）常常晚于就绪。就绪即判定会**结构性漏掉**它们。

因此新增有界 `settleMs`（默认 1500ms）观测窗口，并在日志打印
`SMOKE_READY … settleMs=1500`。它**不承担**就绪职责：就绪本身走独立的有界轮询并单独断言。
若不设这段窗口，`late-error` 场景必然漏检（整改前实测 4 项中该 1 项不符合预期）。

### 2.4 四场景夹具自检（真实 Electron）

`node tools/smoke-packaged.cjs --self-test-fixtures`

```
SMOKE_FIXTURE_EXE D:\…\node_modules\electron\dist\electron.exe
[OK]   正常延迟渲染必须通过（normal-delayed） | 无问题
[OK]   始终不就绪必须超时失败（never-ready） | 顶栏标题 .topbar h1 缺失（主界面未渲染）；关键控件「应用到 OpenCode」按钮不可见
[OK]   初始化早期抛错必须失败（early-error） | 渲染进程错误 1 条：[first-window] FIXTURE_EARLY_BOOT_ERROR；控制台错误 1 条：…
[OK]   晚到错误必须失败（late-error） | 控制台错误 1 条：[first-window] FIXTURE_LATE_ERROR
SMOKE_FIXTURE_OK（4 项时序场景结论均符合预期）
```

夹具同样走**默认配置**（空参数），与产品冒烟一致。
每个场景还断言「**因为什么**失败」（`must` 关键字），避免「碰巧失败」也算通过。

## 3. 对已记录门禁结论的影响（如实标注）

候选 `20260916114818-8b3b8f8-f4e1c6` 的 `build-record.json` 里
`smoke:gui` 那一条，是**整改前的工具**跑出来的——当时默认带 GPU workaround，
所以它证明的是「关掉 GPU 相关子进程后能起窗口」，**不等于**默认配置可启动。

本轮已用**整改后的默认配置**对同一候选独立复测通过（见 §1.1）。
但该复测**没有**回写进 build-record（回写等于篡改历史记录）。
因此：

- 「默认配置可启动」的证据是 §1.1 的本次运行，不是 build-record 里那一条；
- 若要让候选的 build-record 自身反映默认配置，需按 §5 的流程**重建新候选**
  （新 buildId），而不是改旧记录。

### 3.1 补记（2026-09-18）：本机正常配置**已不可用**

§1.1 那次「空参数 `SMOKE_OK`」是在当天较早的会话状态下取得的。
此后重跑发布链时 `smoke:gui` 在**默认配置**下 `Target crashed`，
逐层定位后确认是**本机当前会话没有可用的独立 GPU 进程**（环境），
**不是**包缺陷、也**不是** F2 引入的：

| 启动参数 | 存活 |
|---|---|
| 空参数（双击等价） | ❌ `GPU process isn't usable` FATAL |
| **F2 改动前的旧默认**（4 个 GPU 参数） | ❌ **同样 FATAL** |
| 仅 `--in-process-gpu` | ✅ |

即：这条链**无论 F2 改不改**都会停在 `smoke:gui`。
详细取证见 `evidence/f4-candidate-attempt.md`。

因此 F2 在本机的准确结论是：
**工具改动正确（夹具 4/4、单测 31/31）；「正常配置在真实 GUI 上可启动」在本机为「未验证」。**
按 F2 的要求，此时应当如实失败，**不得**把 `--in-process-gpu` 塞回默认参数刷绿。

## 4. 未做

- 未改产品业务代码、未改断言判据的严格程度、未放宽任何检查；
- 未重打包、未写真实安装、未启动真实 OpenCode；
- 未删除 `--diagnostic-gpu` / `--diagnostic-degraded` 两个诊断入口
  （保留用于无显示会话定位，但两者都不构成发布资格）。
