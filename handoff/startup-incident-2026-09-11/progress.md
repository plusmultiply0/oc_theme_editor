# 进度

2026-09-11：已阅读技能、现有源码、最新事务与备份元数据。尚未运行 apply/precheck/restore、未启动 OpenCode、未修改安装。

## 完成取证

- 独立 parser 读取当前 app.asar 与两份 previous，验证完整 hash、按 header 读取实际字节、比较各条目。当前 hash 为 eea58d…，较新备份 aeab66…，候选早期快照 1c53ca…。
- jsonfile：早期 89 行完整，后两者103行末尾 catch 块截断，vm.Script 返回 Unexpected end of input（未执行脚本）。
- 新旧包完整性结果见 archive-evidence.json。较新备份 113 个 packed header-integrity 错误；当前重打包重算 hash 后为零，但坏脚本仍在，不能只看自校验。
- repro-stream-cwd.cjs 最终运行退出码0、bugReproduced=true；实际错误去重偏移共享也已核实。

## 恢复工具验证

- PowerShell Parser::ParseFile：PASS。
- Recover-OpenCode.ps1 默认模式：三个固定 hash 均通过；沙箱进程查询被拒绝后，正常提权只读重跑。
- 提权只读重跑退出码0：检测 OpenCodeThemeSwitcher.exe PID44384 仍运行，提示先关闭；不会写文件。PID只描述诊断时状态，执行时重新查询。
- 未运行 -Apply，未做真实恢复或启动检查，未重跑全套产品测试。

## 输出

RECOVERY_AND_FIX.md、Recover-OpenCode.ps1、两个 JSON 证据、两个只读/隔离诊断脚本、fixture-cwd 两个小文件与三份交接记录。仅复制这些文档/工具到目标项目 handoff；不复制应用归档、图片、密钥或完整用户数据。
