# 发现

- 实际存在路径 D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher；嵌套目录不存在。
- 新增提交 4ddf644（R1+R2）、33925dd（R3）。两个编排/门禁文件有未提交改动，可能仍有其他 agent 正在实施，复核期间必须检测漂移。
- R1/R2 已引入不可变 build-record/2、可信 policyVersion 和独立 receipt；旧问题不能直接照搬。
- R3 已接入 vitest list 与 JSON reporter，待验证真实调用/错误传播及机器结果 schema 边界。
- 工作树 R4 已将 build 提前到集成之前，并加入 out 快照复核，待检查新链路与当前测试。
- 本轮类型/lint=0；严格入口运行3文件43测试通过。
- 新疑点：core 与发布终检均输出 RELEASE_GREEN，core 不检查回执/全部必检；测试明确锁定该错误命名。
- 新疑点：登记允许给同一 record 换 buildId；需验证新 manifest/receipt 配套后是否把旧构建记录冒充新 buildId。
- 新疑点：严格机器结果检查把 assertionResults 缺失当空数组，可能接受零用例的畸形结果；CLI 严格开关默认 expectNoSkip=false。
- 已用微型合成 asar/zip、真实 CLI 复现：record buildId=original-build，manifest/receipt=renamed-build，register 和发布级 verify 均 exit0。详见 evidence-run-TNl7jK/results.json。
- 同一真实夹具缺 receipt 时 core 输出 RELEASE_GREEN exit0，而完整核验 exit1；证实阶段成功标记混淆。shell 薄入口另会对任何0退出打印 ALL_GREEN。
- 严格机器结果缺 assertionResults 且测试总数0会被当前纯函数接受。收集器去掉两段式 --reporter/--outputFile.json 的键却留下值当过滤器，已复现派生参数。
- release-build 的真实 builder 登记未传 --pack-method，登记器默认为 manual-repack/reproducibleBuild=false，来源元数据与真实链路不符（静态定位，未执行真实打包）。
- 旧环境诊断及 RUNBOOK 未同步 R1–R4，仍包含换会话重置护栏/全仓库信任区等建议；仅记录问题，不执行。
