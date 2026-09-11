# 2026-09-12

- 使用 planning-with-files 技能保存证据与交接步骤。
- 已只读检查源码、事务、归档资源、官方主题写入逻辑；未改源码与安装。
- 读取 worker-client.ts 失败：文件不存在，实际是 pack.ts / pack-worker.ts。
- asar extractFile 使用正斜杠路径失败；改为从 listPackage 获得的原始路径成功读取（Windows 分隔符差异）。
- 初始受限浏览器运行未完成；加超时防止将未完成当成功。经批准在受限环境外运行，sandbox 保持启用。
- 最新成功夹具：verification-1789167107815。六项断言通过，CSS/图片读取正常、模拟动态覆盖完全挡图、两项修复恢复、动态重新插入后保持、安装 hash 未变。
- 复现使用官方静态 CSS 的已解析值模拟官方动态 :root 写入，没有执行官方业务 JS，不是真实窗口截图。
- verify-background.cjs / probe-live-background.js 通过 node --check。
- 未修改应用源码、安装或设置；未运行全量项目测试。方案要求修复 agent 补回归和真机验收。
- 交付：BACKGROUND_FIX_PLAN.md、两份脚本、工作记录、最新成功验证证据；不复制初次失败或旧版广域 token 实验的输出。
