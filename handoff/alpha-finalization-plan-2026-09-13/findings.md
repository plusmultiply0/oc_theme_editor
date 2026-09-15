# 方案依据

- 基线eed1f45，实际项目D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher；嵌套路径不存在。
- 上轮实测typecheck/lint通过、25文件323测试通过；当前旧候选发布核验7项2失败。
- 已确认新发布工具存在out清单路径前缀不一致、manifest登记与Git冻结自冲突。
- 候选源仍为871703d，不含两轮修复；真实闭环A5未执行；A6用户已决定跳过。
- 新门禁用verify-release替代verify-package，下一实现需保留完整性/原生依赖可用性检查，不能只核对身份。
