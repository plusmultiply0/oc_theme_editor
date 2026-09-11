# 进度

2026-09-11：已阅读技能、现有源码、最新事务与备份元数据。尚未运行 apply/precheck/restore、未启动 OpenCode、未修改安装。

## 完成取证

- 独立 parser 读取当前 app.asar 与两份 previous，验证完整 hash、按 header 读取实际字节、比较各条目。当前 hash 为 eea58d…，较新备份 aeab66…，候选早期快照 1c53ca…。
- jsonfile：早期 89 行完整，后两者103行末尾 catch 块截断，vm.Script 返回 Unexpected end of input（未执行脚本）。
- 新旧包完整性结果见 archive-evidence.json。较新备份 113 个 packed header-integrity 错误；当前重打包重算 hash 后为零，但坏脚本仍在，不能只看自校验。
- repro-stream-cwd.cjs 最终运行退出码0、bugReproduced=true；实际错误去重偏移共享也已核实。

## 恢复工具验证

- PowerShell Parser::ParseFile：PASS。
- Recover-OpenCode.ps1 默认模式：三个固定 hash 均通过；沙箱进程查询被拒绝后，正常提权只读重跑。
- 提权只读重跑退出码0：检测 OpenCodeThemeSwitcher.exe PID44384 仍运行，提示先关闭；不会写文件。PID只描述诊断时状态，执行时重新查询。
- 未运行 -Apply，未做真实恢复或启动检查，未重跑全套产品测试。

## 输出

RECOVERY_AND_FIX.md、Recover-OpenCode.ps1、两个 JSON 证据、两个只读/隔离诊断脚本、fixture-cwd 两个小文件与三份交接记录。仅复制这些文档/工具到目标项目 handoff；不复制应用归档、图片、密钥或完整用户数据。

## 人工恢复执行记录（2026-09-11 22:xx，jc 授权「恢复安装」）

1. 只读预检通过：目标/可执行文件/恢复快照三哈希与事故证据一致。
2. 事故安装的 6 个 OpenCode.exe（错误对话框僵死进程）先优雅关闭、残留强制结束，remaining=0。
3. `Recover-OpenCode.ps1 -Apply` 执行成功：
   - `RECOVERY FILE REPLACEMENT VERIFIED`
   - 恢复后归档 SHA256 = `1c53ca2472698a9e5ea1162ccb917a98b4e3f8d99ddd427b488dd063ddee6fc2`
   - 损坏归档保留为 `resources/app.asar.failed-218e45cae34b43e3a03ad41fb1fa4126.bak`
4. 用修复后的三层校验对恢复后归档做内容级体检（`tools/post-restore-health.cjs`）：
   **6/6 通过**（6947 条完整性全对、无 offset 冲突、1293 脚本解析通过、jsonfile 完整）。

### 恢复后体检发现校验器三处误报（已修，见主 CHANGELOG）

真实安装里存在三类**合法**形态被旧校验器误判：
- 空文件（size=0，integrity hash=sha256(空)）与相邻文件共享 offset —— 打包器给空文件
  分配当前 offset 且不推进数据区；verifyIntegrity 的分块比较与 findSharedOffsetConflicts
  均已排除 size=0 条目。
- 顶层 `return` 的 CJS（mkdirp/bin/cmd.js）—— 裸 vm.Script 误判，改为先按 Node 模块
  包装器解析。
- 行中 `export`（注释后跟 export，httpApiSwagger.js）—— 旧 isEsm 正则只认行首，
  现在解析失败后回落 ESM；ESM 能力不可用时按「无法判定」跳过并计数，绝不误判。

回归：`tests/integration/archive-verify.test.ts` 16/16（新增 3 项合法形态用例），
全量 190/190，lint 0。
