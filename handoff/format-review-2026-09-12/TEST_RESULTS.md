# 本轮测试结果（2026-09-12）

源码基线：git a58613b。以下是本轮执行结果，而非复制历史changelog。

| 命令/检查 | 结果 |
| --- | --- |
| npm run typecheck | exit 0 |
| vitest run tests/unit/surfaces.test.ts tests/unit/theme.test.ts tests/integration/stage-idempotence.test.ts --cache=false | 3 files / 61 tests passed，6+46+9 |
| playwright test tests/e2e/background-cascade.spec.ts，输出置于隔离目录 | 8 passed (1.2m) |
| node tools/verify-package.cjs | release6，28项0失败 |
| node tools/verify-real-install.cjs --archive 真实app.asar --deep | 15项0失败；没有传expect-image-hash，因此不是历史16项 |
| node probe-formats.cjs PROJECT format-evidence.json | exit0，详见JSON |
| node --check probe-formats.cjs | exit0 |

## 解释限制

- 安装核验脚本含“图片可解码”的浅文件头判断；本轮格式探针另行做了完整解码弥补。
- 脚本解析统计：1293已解析，2776不支持，0跳过；不能宣称全部JS语法验证通过。
- E2E使用合成布局与图片、沙箱开启的临时Edge，不是实际OpenCode会话截图。
- 非全量测试；未重新执行完整205项、全部Electron主进程用例或真正用户窗口应用。
- 本轮不改业务源码/安装、不清用户缓存，不改变原图。
