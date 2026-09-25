# W4a 证据：启动按钮可行性探测（2026-09-25）

计划出处：`PLAN.md` §W4a。目标：验证「模拟用户双击启动且会话正常加载」是否可行，
gate 达标才进 W4b。探测脚本为一次性产物（`tools/tmp-w4-probe.cjs` 等，用毕已删不入库），
本文档记录命令与结论。

## 探测方法

- 拉起前先 `Stop-Process -Name OpenCode`（确认无实例），逐一测试三种 ShellExecute 等价路径；
- 三种均经 node `child_process.spawn`：`detached: true`、`stdio: 'ignore'`、`unref()` 后探测进程即退出（不持句柄）、
  `cwd` 设为 exe 所在目录；环境消毒剔除 MSYS/GIT_/QODER/ELECTRON_RUN_AS_NODE 等 19 项会话变量，贴近双击；
- 目标 exe：`C:\Users\ylzho\AppData\Local\Programs\@opencode-aidesktop\OpenCode.exe`（1.18.32，W2 主题在装）；
- 达标判据：主窗口出现 → 截图核验**上次会话完整恢复**（标签页、消息内容渲染、输入框可用）。

## 结果

| 方式 | 命令 | 拉起 | 会话加载 | 判定 |
|---|---|---|---|---|
| M1 | `cmd /c start "" "<exe>"`（start 首参为空标题占位） | 窗口 ~10s 出现（pid 19316） | 三标签页恢复、「DLinear训练启动方法」内容完整渲染、输入框可用 | **达标** |
| M2 | `explorer.exe "<exe>"` | 窗口出现（pid 43156） | 与 M1 同画面、渲染一致 | **达标** |
| M3 | PowerShell `Start-Process -FilePath '<exe>'` | 见下 | — | **本体可行，包装不可靠** |

M3 细分：
- 直接调用与同步包装（node `spawnSync` + 消毒 env）均成功拉起并出窗（pid 30404 / 42552）；
- 但 `detached + stdio:'ignore'` 异步包装**可复现地**不执行命令——launcher 进程消失、
  连预先放置的日志文件都未写出（去掉 `-WindowStyle Hidden` 同样失败）；
- 首轮包装命令里 `try{}catch{}|Out-File` 还踩了 PS 5.1 语法坑（try/catch 语句不能直接接管道，
  需 `$( )` 包裹）——修正后同步路径全绿，detached 路径仍不执行，故该失败归因于包装而非 Start-Process。

## 结论与 gate

- **gate 达标**（至少一种方式实测达标）：M1 与 M2 均满足「双击等价 + 会话正常加载」→ 进 W4b。
- W4b 采用 **M1（`cmd /c start`）**：ShellExecute 语义与双击同路径、node 包装可靠、无 powershell 依赖；
  M2（explorer.exe）作备选记录。绝不恢复旧 `spawn` 直拉方式（F1 删除原因）。
- 如实记录两点：
  1. 「可发消息」仅核验到输入框就绪与内容渲染，**未实际发送消息**（避免消耗用户模型配额、污染真实会话）；
     实际收发由 jc 真机回执补验。
  2. 探测期间 OpenCode 均被 `Stop-Process` 终止（非用户主动退出）；末态与本轮开始时一致（未运行），
     会话数据未受影响（M1/M2 均完整恢复）。
