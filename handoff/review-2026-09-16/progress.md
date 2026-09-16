# 进度

已读取planning-with-files技能，确认实际项目目录为D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher。开始复核修复和失败证据。

已核对900f7f3上轮S1–S6修复及S7回归。完成typecheck/lint、自定义audit，均exit0；完整单元严格入口13文件212项通过。当前源码内存夹具确认归档窗口错峰并发状态泄漏与Node worker异步error无监听，早于exit结算的现象仅记录为待查生命周期问题。静态确认普通verify仍在build前集成、shell忽略绑定路径/尾部参数。历史日志确认业务断言和清理失败并存，未重跑全量集成或真实安装。报告已完成，正在保存到项目新handoff目录。

已交付：10份文档/脚本/证据复制到实际项目handoff/review-2026-09-16，逐份哈希一致；HEAD/已跟踪源码未改变，两个内存复现对应源文件hash未漂移。同步本轮规划文件为完成状态，不改历史报告。

## 修复执行（按 §5 拆分，一项一提交）

基线核对：执行时 HEAD=900f7f3 与计划基线一致，工作树仅 handoff/review-2026-09-16/ 未跟踪 → A–E 五项全部成立。

- **A（N1 归档窗口所有权）已完成，提交 4a1bbda**。用 AsyncLocalStorage 携带所有权令牌判定真嵌套（令牌在窗口退出时先失效、再还原开关）；窗口内重入直接进入，外部错峰调用排队。单测 6→13 项；完整单测 219/219；严格包装器 files=13/13 tests=219/219 failed=0。复现脚本 reproduce-runtime.cjs 的归档段断言已翻转为修复后预期（进入不并发、结束后零泄漏、时间线串行）。
- **B（N2 worker 错误契约 + 成功不得早于回收）已完成，提交 0b84381**。fork 后立即挂 error 监听；child.send 完成回调承担 EPIPE；成功回执后等 exit 再交付，30s unref 有界兜底（结果仍成功）；worker 侧 reply 改 Promise，等发送完成再 exit。新增 tests/unit/pack-worker-lifecycle.test.ts 10 项（含 forkOverride 注入缝复现 EAGAIN）；build 通过、含真实派生的集成用例全绿。
- **C（N3 顺序 + N4 绑定/参数）已完成，提交 bf4a68f**。详见 REVIEW_AND_FIX_PLAN.md §5。
      - N3：新增 tools/verify-entry.cjs（步骤表即数据 + 运行时自检 + --list/--from），package.json 的 verify 指向它。build 恰好一次且在所有 requiresOut 步骤之前；integration/e2e 不再排在构建前。顺带修掉入口在 Windows 下 spawn npm.cmd 的 EINVAL（shell:true，与 release-build 同处置）。
      - N4：工具层与 shell 层分开修——shell 把 GATE_MANIFEST/GATE_CANDIDATE_DIR 与剩余参数真正下传（新增 OTS_NODE_BIN 测试缝）；Node 层 parseArgs 收紧（未知参数/缺参数值 exit 2，支持 --x=value），verify 模式拒绝 --strict，assertExplicitBinding 规范化比较后在核验前 exit 2。
      - 测试：tools/test-release-gate.cjs 新增断言，含 N3 端到端（npm 桩记录真实执行顺序 + build 非零阻断集成）与 N4 端到端（注入解释器桩断言下层 argv）。
      - 验证：typecheck exit 0、lint 干净、单测 229/229（14 文件）；门禁行为测试 297 PASS / 0 FAIL / 0 SKIP。
- **D（N5 分类取证与定向复测）已完成，本轮提交**。产出：
      - 新增 tools/n5-classify-integration.cjs：按用例身份（文件+完整测试名）归并为 setup/business/business+cleanup/cleanup_only/incomplete/passed；保留原始 errno 不归并为 FILE_LOCKED。
      - 新增 tools/n5-crossproc-cleanup.cjs（npm run test:cleanup-semantics）：跨进程验证 R7 清理语义，6/6 通过。
      - 取证结论：当前提交集成 179/179 全绿、errnoCounts 为空（本轮未复现任何文件锁错误）；唯一曾失败项 `启动清理遗留准备区: cleaned=0` 经注入诊断（`rm` 原始 errno=EBUSY，锁在 `stage/<opId>/app`）+ 跨进程对照（新进程 CLEANED=1）定性为**断言选错时序**，非产品缺陷；已把 harness 断言改为验证 cleanAllStages 契约本身（独立实例遗留→删掉计 1；无遗留→计 0）。
      - 证据：handoff/review-2026-09-16/evidence/{n5-env-baseline.json, n5-classification.json, n5-forensics.md}；harness 38/38 通过、连续 3 次稳定。
      - 保持未知：未取得内核级句柄/文件系统事件，对历史 unlink EBUSY 不做持锁者归因；「应用是否在所有情况下都会真正重启主进程」未验证。
- **E（当前提交全量验证及新候选）未开始**。
