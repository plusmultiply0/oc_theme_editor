# 本轮验证记录

基线：85f6707b323c23ef8f57115a2d9529be2f655c44；2026-09-16。

- 隔离复现脚本：退出0，结果见reproduction-results.json。成功执行表示复现完成，并非项目检查通过。
- TypeScript：node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json，退出0。
- ESLint：node node_modules/eslint/bin/eslint.js . 多次轮询无输出，最后发送Ctrl+C的调用返回exit_code=0且无输出。因完成与终止请求的先后无法确认，本轮保守不把它计为独立确认的lint通过；不擅自归为代码错误或环境错误。
- 未运行完整测试、构建、GUI冒烟、真实安装操作、发布链。
- 工具读取时一次Select-Object参数误写forty，已终止并以整数35重新读取；一次尝试读取不存在tools/run-suite.cjs，未执行任何该脚本。不影响上述复现。没有改变安全配置或重定向临时目录以绕过保护。
