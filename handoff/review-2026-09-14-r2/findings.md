# 发现

- A–F已有后续实现，当前进展涉及prepare:out、test:e2e文件占用及删除护栏记录。需核对证据，不能复用旧缺陷结论。
# 复核发现（持续更新）

- 静态检查：typecheck=0、lint=0。
- 发布链存在自引用：writeBuildRecord 先于 register/verify:release，记录恒缺末尾两步，核验拒绝；finalize 在核验后且不补缺失步骤。
- record.releaseRequiredSteps 可以缩小可信规则，最小 build-only 记录疑似通过，待纯函数复现。
- 完整性检查默认不检查预期文件数与 skip；即使传 expectedFiles 也比较分母而非完成数。
- prepare:out 仅检查 main/index.js 存在，未验证 worker 存在或编译产物与当前源码一致。
- 当前执行状态把安全删除护栏耗尽作为环境阻塞；不尝试重置或绕过，不执行构建/打包。
- R1–R4 已用当前源文件函数/内存夹具验证；stub 成功不作为真实发布证据。
- 三组发布相关单测 31 项通过；三组图片单测 34 项通过；仓库 audit 0 fail/0 warn。
- 服务 Running 不能确证目标文件锁；文档把策略审批拦截与 EPERM 混为同类根因，证据分级及安全处置需纠偏。
- 正式报告 REVIEW_AND_FIX_PLAN.md 已完成；详细命令、文件定位、正确/错误行为及验收均在报告中。
