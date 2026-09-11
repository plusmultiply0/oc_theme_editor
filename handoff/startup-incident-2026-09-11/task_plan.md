# OpenCode 启动故障诊断

目标：只读确认 Unexpected end of input 原因，输出可执行恢复方案与开发修复交接到实际 D 盘项目。不得在诊断中修改安装或执行恢复。

- 已完成：定位工程、最新操作记录及备份。
- 已完成：独立解析归档，比较非主题脚本字节、完整性与备份；确认 jsonfile 截断来自前一轮产物。
- 已完成：两文件隔离 fixture 复现已安装归档库的 cwd hash 污染/错误去重。
- 已完成：编制 RECOVERY_AND_FIX.md 与默认只读 Recover-OpenCode.ps1；哈希和脚本语法检查通过。
- 交付位置：D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher/handoff/startup-incident-2026-09-11。
- 未执行且不属于本轮诊断：实际恢复、源码修复、重打包、真实应用启动验收。

已知：最近操作 op-20260911T110935948Z-k8dfu2 标 applied；before aeab66…，after eea58d…；保留 02:15 与 11:10 两份 previous 备份。
错误：git status 警告无法访问全局 ignore；不改 git 配置。会话恢复脚本无输出。

复现脚本首次用绝对包目录 require 失败（包只有 exports 没有 main）；改用目标 package.json 的 createRequire 解析依赖，不安装或修改依赖。

默认只读检查在沙箱内查询进程被拒绝；正常请求提升权限重跑，只读检查成功读到换肤助手尚在运行，正式恢复必须先关闭。没有强制结束进程。
