# GPU 崩溃 + smoke:gui 环境受限事故（2026-10-18）

## 一句话结论

本机（Windows 10 Home China **25H2**，build 26200.9711）上叠了两个问题：

1. **真缺陷（已修，`d59417c`）**：NVIDIA 驱动 32.0.15.8157 与**沙箱化 GPU 进程**冲突，
   GPU 进程反复 0xC0000005，重试耗尽后 FATAL「GPU process isn't usable. Goodbye.」
   整个应用退出——任何启动方式、旧版 exe 同样崩。主进程追加
   `app.commandLine.appendSwitch('disable-gpu-sandbox')` 规避；renderer 沙箱、
   contextIsolation、webSecurity 全部不动。
2. **环境受限（policy v2 登记）**：修复后 **Playwright 驱动的默认配置（沙箱开）启动
   仍必崩**，与应用代码无关（见下取证链）。smoke:gui 的发布事实改由
   `smoke:gui-env-limited` 替代证据承担。

## 证据链（第二层：Playwright 沙箱崩溃与应用无关）

| # | 实验 | 结果 | 排除对象 |
|---|------|------|----------|
| 1 | 冒烟脚本剥除 ELECTRON_RUN_AS_NODE 后重跑 | 仍 "Target crashed" | 宿主变量泄漏（叠加干扰项，非主因） |
| 2 | 上游 `electron.exe` + 最小夹具走同一 Playwright 启动 | 同样崩 | **应用代码** |
| 3 | 腾讯电脑管家完全退出后重跑 | 仍崩 | QQPCMgr 注入 |
| 4 | 最小环境白名单（PATH/SYSTEMROOT/TEMP…）启动 | 仍崩 | 环境变量面 |
| 5 | 剥除 NODE_OPTIONS（宿主 language-shim） | 仍崩 | 宿主 shim |
| 6 | 系统 node 与 WorkBuddy 托管 node 各跑一次 | 双双仍崩 | Node 运行时 |
| 7 | 旗标矩阵：in-process-gpu / disable-gpu / disable-gpu-sandbox / swiftshader | 全部仍崩 | GPU 路径 |
| 8 | 旗标矩阵：**仅 `--no-sandbox` 存活**（e2e 正是靠这组降级旗标通过） | 存活 | — |
| 9 | 手动 spawn + 内置 WebSocket 完整复刻 CDP（node inspector + Debugger.enable + 页面域并发 6s） | 存活 | CDP/inspector 协议本身 |
| 10 | Windows 事件日志 | 无 WER 崩溃转储（静默退） | — |

- 时间线吻合：25H2 为本机近期功能更新；九月 v1.0.0 冒烟可过，十月全部形态（新旧 exe）
  均崩。此前「环境回归非代码缺陷」的定性**部分错误**：GPU 崩溃是真缺陷（已修），
  Playwright 沙箱冲突才是环境项。
- 真实用户路径（双击等价启动，干净环境无参数）实测存活 ≥6s；降级冒烟
  `--diagnostic-degraded` READY=true、界面契约正确。

## 实验脚本（可重跑）

- `pw-one.cjs <name> [args]` — 单旗标单进程 Playwright 探针（崩溃异步逃逸 try/catch，
  必须子进程隔离）
- `pw-minenv.cjs` — 最小环境白名单探针
- `manual-cdp.cjs` — 手动 spawn + 浏览器级 CDP 附加
- `cdp-isolate.cjs` / `cdp-dual.cjs` — node inspector / 页面域 / 双会话并发细分
- `cdp-debugger.cjs` — Debugger.enable 长驻复刻

## 处置

- `d59417c`：GPU 沙箱规避（主进程 `disable-gpu-sandbox`）。
- policy v2：`RELEASE_POLICY_VERSION` 1→2，显式声明 `envLimitedGui` 时以
  `smoke:gui-env-limited` 替代 `smoke:gui`；配套 `tools/smoke-env-limited.cjs`
  （双击等价存活 + 降级冒烟 READY 双证据）、发布链 `--env-limited-gui` 放行路径、
  契约测试 10 项新钉子。
- 恢复路径：微软/Electron 侧修复 25H2 沙箱冲突后，回归默认 smoke:gui 并停用
  envLimitedGui 声明（政策 v2 保留，属应急通道而非常态）。
