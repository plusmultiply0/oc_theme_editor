# 复诊证据摘要

基线55ba0e4。时间2026-09-14。本轮代码无修改。

| 文件 | 来源/结果 |
|---|---|
| historical-partial-integration.log | 原suite-2026-09-14T03-23-27-401Z-9390.log：7/15文件、84项、1RPC错误，原进程exit1 |
| candidate-focused.log | 本轮suite-2026-09-14T03-46-28-111Z-afeb.log：14/14、exit0、42.64秒 |
| integration-controlled.log | 本轮suite-2026-09-14T03-48-08-775Z-d8fa.log：15/15文件172/172、1RPC错误、exit1、100.59秒，candidate套件72.372秒 |

--root反证：本轮夹具p2-ok-0bE7Zq的manifest sourceCommit与git log均004d1f3ca95d9b383eae242d7c9880773ebb181d；主题均fixture init。

smoke隔离模拟结果（非真实启动）：

```json
{
  "blankBody": { "exit": 0, "SMOKE_OK": true },
  "bodyReadThrows": { "exit": 0, "SMOKE_OK": true }
}
```

Vitest本机3.2.7，birpc默认6e4毫秒；onTaskUpdate为任务更新RPC。未修改node_modules，未尝试提高超时。EPERM具体持锁进程未确认，不视为已定位到某安全软件。
