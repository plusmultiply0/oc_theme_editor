# 发现

HEAD8b3b8f8，工作树干净。R1–R6均已有修复提交，另有PowerShell编码修复和Playwright回归修复。须检查实质正确性，不能照搬旧问题。

ZIP已统一规范化并真实解压/hash；worker exit非0和kill抛错已失败关闭。新疑点：smoke保留禁GPU参数但声称默认配置；错误监听的注册时机；ZIP隐式父目录大小写冲突、EOCD边界/descriptor验证是否漏检，需判风险不堆砌。新增候选20260916114818-8b3b8f8-f4e1c6须读原始记录。

关键实证：playwright-core本地1.63.0，coreBundle.js:44249–44250在options.chromiumSandbox未true时自动unshift('--no-sandbox')。smoke launch未传chromiumSandbox，日志仅检查传入args，因此R5仍未真正修好。官方Electron.launch文档确认默认false。候选新record的12步passed、releaseEligible=true且receipt已存在；这是较旧版的进展，但不能证明其smoke运行安全条件正确。

重要纠正：上述自动no-sandbox受上一行platform()===linux限制；本项目Windows不命中，因此撤销Windows关闭沙箱判断，已告知用户。正式报告不列该错误。真正剩余smoke风险为禁GPU与默认启动条件不一致、错误监听注册晚。

本次typecheck/lint均exit0；4文件80单测80通过。新候选发布级只读verify18项失败0，RELEASE_GREEN。旧反例Windows目录、坏DEFLATE、重复别名、exit1、kill抛错均按修复后预期工作。新夹具：中央目录commentLen越界/缺descriptor被两检查放行；隐式目录大小写冲突deep未报；smoke早期pageerror事件丢失且judge通过（假页面模拟，非真实崩溃）。

确认P1交付指引过期：README链接的docs/release-checklist.md“当前候选”仍要求分发旧manual-repack zip/sha921261...；docs/alpha-acceptance.md标识仍871703、schema1；新候选8b3b8f8已完成schema3+receipt。容易把新测试结论配给旧包，必须先修当前入口与历史归档边界，不改旧manifest事实。
