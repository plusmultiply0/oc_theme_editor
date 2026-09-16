# 发现

900f7f3已包含S1–S6提交与S5集成回归补丁，工作树干净；不重复列已修复的问题。需核对全量测试报告与最新发布链。

- 执行记录新增：9/15集成51failed/128passed/179，全套55failed/334passed/389；基线55failed/122passed/177。需区分错误数与失败测试数，不能简单差值推出全部失败根因。
- 归档窗口全局depth>0即判“嵌套”，异步窗口开始后的独立并发调用可能绕过队列并泄漏noAsar；需内存状态机复现，不将其直接归因为用户现有崩溃。
- pack worker finish收到成功消息就kill并resolve，不等待exit；可能与清理竞态相关，需分级为候选原因，不贸然确证。
- 本轮全量单元严格模式13文件212项通过，无skip/todo/pending/Unhandled；typecheck/lint=0。
- 内存夹具已确认：独立B在A的异步窗口内绕队列进入；A退出时B仍活跃但noAsar=false，最终depth=0却noAsar=true。使用独立假process，不影响真实进程/安装。
- 内存夹具确认Node worker error事件监听数0，异步EAGAIN从EventEmitter逸出，try/catch派生不能兜住；收到success后在exit前resolve且kill。后者暂不作为历史文件锁根因。
- 公开npm verify脚本仍在build前跑integration（release:build已修，但普通入口漏改）；干净out时electron-runtime明确要求out/main/index.js，依赖不满足。
- release-gate.sh仅检查GATE_MANIFEST/GATE_CANDIDATE_DIR非空，不比较也不传给下层；第三及以后参数也未透传。与声明的显式绑定接口不符。
- 历史cur-integration包含真实业务失败：electron-runtime恢复FILE_LOCKED、image-format-cycle应用失败，不能仅改afterEach清理来获得有效绿色结果。
