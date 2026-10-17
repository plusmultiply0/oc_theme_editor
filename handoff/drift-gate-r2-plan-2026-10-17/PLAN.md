# 基线漂移判据重构计划（Y1–Y4）：结构可行即放行，版本陌生不再否决

- 日期：2026-10-17
- 基线：`9aef530`（v1.0.0 正式版已发布：GitHub Release + zip + 哈希侧车落位；工作树干净）
- 来源：jc 真机报错——「目标疑似被官方更新（1081 条与接管基线不一致），但未满足自动放行条件」，要求：**只要还能用图片背景就允许应用，哪怕版本号没见过**。
- 性质：正式版发布后的第一个缺陷修复轮（→ v1.0.1）。

## 已核实的代码事实（本轮实读，行号为 9aef530 现场）

| 判定点 | 位置 | 现状 |
|---|---|---|
| 五条件裁决 | `src/core/patch/archive-verify.ts:593` `classifyDrift` | ①版本变化(597) ②锚点唯一(613) ③变更集合净(620) ④量级达标(627, 常量 554-555: 0.5/100条) ⑤unpacked 集合一致——**五条 AND 才判 official-update** |
| 拒绝分支 | `src/core/patch/apply.ts:582-601` | suspicious → `ARCHIVE_CORRUPT`，文案分「疑似官方更新但未达条件 / 疑似第三方改动」两类 |
| 结构验证（单一判据源） | `src/core/patch/compat-check.ts:50` `verifyStructure` | anchor / changeSet 是 FAIL 硬判据，unpacked 完整性只是 WARN 不阻断；`compatible = 无 FAIL` |
| structural 通道 | `src/core/patch/discover.ts:249-260` | 白名单未命中 → verifyStructure 过 → supported(verifiedBy='structural')——**S 轮已确立「版本陌生不否决」** |
| apply 入口重验 | `src/core/patch/apply.ts:156` | S2 竞态重验：写入前再跑一次 verifyStructure，不过直接拒 |

**根因**：B 轮给 drift 场景单独加严了 ①④⑤ 三条（版本可比、量级、unpacked 集合一致），而 S 轮的 discover 通道同场景只用 verifyStructure。本次 1081 条差异量级远超阈值仍被拒，未过项必在 ①②③⑤ 之中（④必过）——无论具体哪条，①⑤ 都是把「版本陌生/模块增减」本身当否决理由，与 S 轮原则直接冲突。**同一件事两扇门两套口径，这正是判据单一来源约束要防的漂移。**

另核实一个可观测性缺口：`transactions/` 目录为空——本次拒绝的判据明细只进了错误消息 detail 参数，没落事务记录，用户侧拿不到「下方明细」（文案承诺了但没兑现）。

## 设计

**drift 放行判据降维为与 discover structural 通道完全同源：`verifyStructure(snapshot).compatible`（无 FAIL 即放行）。** 版本号变化、差异量级、unpacked 集合差异全部转为提示信息，只进文案不进闸门。

放行后沿用 B1 机制不变：自动重新接管（旧基线归档、`store: true`、`previousVersion/newVersion`、以新归档重建基线）。

安全性不降的三道既有防线：① drift 门放行只是「允许继续」，apply 入口 S2 重验在写入前再跑一次 verifyStructure；② 备份链路原样（original/previous/pre-restore 三语义）；③ 恢复入口零改动。减少的只是「版本陌生」这层误伤。

## 任务（一项一提交）

### Y1：判据重构（一提交）

1. `classifyDrift` 入参去掉五个独立布尔，改为收 `structure: CompatReport` + 版本/量级/unpacked 作提示字段；`verdict` 计算改为 `structure.compatible ? 'official-update' : 'suspicious'`（kind 名可改 `'injectable'`，内部注释更新）；
2. `DriftConditionResult`/`conditions` 留痕结构保留——明细仍逐条记录，只是角色从「闸门」变「证据」；
3. `apply.ts:568-580` 接线改为直接传 `structure` 报告；
4. 单测钉子用例（B 轮 7 场景改口径 + 新增）：
   - **未知版本 + unpacked 集合变化 + 锚点在 + 变更集合净 → 放行**（本次 1081 场景的钉子）；
   - 基线无 version 记录（legacy 基线）但结构可行 → 放行；
   - 锚点 FAIL → 拒；变更集合被第三方占用 → 拒；归档读不出 → 拒；
   - 官方整体更新放行回归不变；正常重应用（driftCount=0）回归不变。

### Y2：文案与留痕（一提交）

1. 放行结果明示「目标已更新至 X.Y.Z（未在白名单，经结构验证放行）」——沿用 structural 徽章口径，提示色、不写「已验证」；
2. 拒绝文案：去掉「请优先把本工具升级到适配新版本后重试」（本轮之后这句不再成立），保留恢复入口指引；
3. **补可观测性**：suspicious 拒绝时把判据明细（✗/✓ 逐条）写入操作记录/txlog——文案承诺的「下方明细」必须真的可查；
4. e2e/集成中依赖旧文案的断言同步。

### Y3：全量回归（并入 Y1/Y2 或单独一提交）

typecheck / lint / unit / integration（合成 asar 夹具各场景）全绿。

### Y4：文档 + 发布轮（一提交 + 发布流程）

1. `compatibility.md`：两通道统一口径——「注入可行性」一个判据，覆盖未知版本与官方更新两场景；
2. `CHANGELOG` 登记缺陷（2026-10-17 真机 1081 拒绝）与修复；
3. 验收文档台账补记；
4. v1.0.1 发布轮：版本 bump → 门禁 → 候选登记 → tag/Release（按正式版先例流程，上传授权单独确认）。

## 边界

- verifyStructure 的 FAIL 判据一个不减——本轮只减「版本陌生」层误伤，注入安全判据原样；
- 结构放行的版本不进 `supportedVersions`（转正仍需真机闭环，流程不变）；
- 恢复链路、备份语义、IPC 契约零改动；
- 不加确认框：drift 场景用户已在「应用」这个显式动作里，且写入前有 S2 重验兜底。

## 执行顺序

Y1 → Y2 → Y3 → Y4。全部本机可完成（合成夹具测试）；真机复验（OpenCode 更新后重应用走通）随 v1.0.1 发布验收，需 jc 在场取证。
