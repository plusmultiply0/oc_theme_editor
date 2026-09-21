# 结构验证放行计划（2026-09-21）

> 目标：**版本白名单不再是唯一放行依据**。用户安装的 OpenCode 版本不在白名单时，
> 只要其代码结构通过只读验证（壁纸补丁确实适用），就允许应用，而不是一刀切只允许预览。
>
> 背景决策（jc 已确认方向）：壁纸补丁按「代码结构是否适用」放行；
> 白名单版本是快速通道，非白名单版本走结构验证通道。

## 现状与缺口（已核实）

- `inspectRoot`（src/core/patch/discover.ts:246-261）：`supportedVersions.includes(version)`
  不命中 → `support: 'unknown'` + 「只允许预览，不允许应用」；
- 应用门径三处硬卡：`apply.ts:97`、`operation-service.ts:114`、`operation-service.ts:289`，
  全部 `support !== 'supported'` 即拒；
- 结构验证逻辑已存在但只在工具层：`tools/version-probe.cjs` 检查 4（锚点出现次数）、
  检查 5（变更集合冲突）、检查 6（unpacked 完整性），**产品链路（core/main）完全没有**；
- probe 通过消费 `out/` 编译产物复用 `readAsar`/`ADAPTERS`——结构判据与产品判据同源，
  但「结构验证」这一层判定本身在 probe 里是独立实现，搬进 core 时必须保持单一来源。

## 核心设计

### 放行模型（两通道，一张门）

| 通道 | 判定 | support 值 | UI 呈现 |
|---|---|---|---|
| 白名单快速通道 | 版本 ∈ `supportedVersions` | `supported` + `verifiedBy: 'whitelist'` | 现状不变 |
| 结构验证通道 | 版本 ∉ 白名单，但结构检查全过 | `supported` + `verifiedBy: 'structural'` | 新增「结构验证通过（非名单版本）」徽章 + 应用前显式确认 |

`TargetInfo` 增加 `verifiedBy?: 'whitelist' | 'structural'` 字段；
`TargetSupportSchema`（shared/schema.ts:81）枚举**不变**（仍是三值），
应用门径的 `support !== 'supported'` 判断**一行不改**——门只有一扇，变的是谁发钥匙。

### 结构检查判据（与 probe 检查 4/5/6 逐项对齐，单一来源）

新模块 `src/core/patch/compat-check.ts`，导出 `verifyStructure(snapshot, adapter)`：

1. **锚点唯一**：`adapter.injection.anchor` 在 htmlEntry 内容中恰好出现 1 次
   （0 次 = 结构已变，拒绝；≥2 次 = 无法唯一注入，拒绝）；
2. **变更集合干净**：`allowedChanges` 中 cssFile/imageFile 尚不存在，或存在但为
   本工具产物（link 标签/css 标记可识别）——第三方占用即拒绝；
3. **布局一致**：htmlEntry 存在于归档内（注入目标真实存在）；
4. （信息项）unpacked 原生模块完整——同 probe 检查 6，不阻断。

任何一项不过 → 维持 `unknown`，拒绝原因写明哪项不过。**绝不猜测锚点、绝不模式匹配近似注入。**

### 必须防的竞态：OpenCode 自动更新

inspect 到 apply 之间用户可能恰好触发 OpenCode 自动更新（asar 被整个换掉，
锚点可能消失）。因此 **apply 入口必须重验**：`applyTheme` 拿 `target.fingerprint`
与当前归档实算 SHA256 比对，不一致则重跑 `verifyStructure`，重验不过即拒；
通过且 fingerprint 已变 → 同步刷新 target 记录再续行。这是本计划的安全核心，
不是可选项。

## 任务分解（一项一提交）

### S1：core 结构验证模块 + inspectRoot 接线

- 新建 `src/core/patch/compat-check.ts`（上述判据，纯函数、只读快照）；
- `inspectRoot`：白名单未命中时跑 `verifyStructure`，全过 →
  `support: 'supported', verifiedBy: 'structural'`，`rejectReason` 改为
  说明性文案（「非名单版本，结构验证通过」）；不过 → 维持 `unknown`，
  拒绝原因带具体检查项；
- **单一来源约束**：`tools/version-probe.cjs` 的检查 4/5/6 改为调用
  `out/` 里编译后的同一模块，删除工具内的独立实现（判据只允许存在一份）。

**验收**：`node --check` / lint / typecheck 0；单测全绿。

### S2：apply 竞态重验

- `applyTheme`（apply.ts）：fingerprint 比对 + 结构重验逻辑（见上）；
- `operation-service.ts` 两处门径同步：放行条件不变（`supported` 即可），
  但 structural 通道要求**应用前显式确认标志**入参，缺省拒绝（防 GUI 误触）；
- 白名单通道行为零变化。

**验收**：单测补竞态场景（inspect 后 asar 被换 → 重验拦截）；lint/typecheck 0。

### S3：renderer 呈现 + 确认

- 目标面板：`verifiedBy: 'structural'` 显示独立徽章（非绿色「已验证」同款，
  用提示色并附文案「此版本未列入白名单，已通过代码结构验证」）；
- 应用按钮对 structural 目标弹出确认框（列三项检查结论 + 「应用后若 OpenCode
  更新，主题可能被覆盖」提示）；
- 模拟预览层（mock-*/--p-*）与报告一致性：零改动。

**验收**：e2e 选择器兼容（现有 `.badge` 等类名不动，新增类名）；单测/e2e 绿。

### S4：测试补齐

- compat-check 单测：合成 asar 夹具 × 场景（锚点 0/1/2 次、css 被第三方占用、
  自身产物再应用、htmlEntry 缺失、unpacked 缺项）；
- inspectRoot 集成：非名单版本结构通过 → `supported + structural`；
  结构破坏 → `unknown` 且原因含检查项名；
- 回归：白名单 1.18.29 行为逐字节不变（verifiedBy=whitelist）。

**验收**：新增用例全过 + 全量单测无回归。

### S5：文档口径更新

- `docs/compatibility.md`：两通道模型、结构验证判据、自动更新竞态说明、
  「结构验证 ≠ 完整真机验证」的如实边界（UI 能看 ≠ 全部功能验过）；
- README 使用说明同步一句：非名单版本现在会提示「结构验证通过」，可选应用；
- probe 的 `PLAN.md` 计划文件追加一句「检查 4/5/6 已并入 core 单一来源」。

**验收**：文档与代码行为一致；`doc-candidate-entry.cjs --check` 不受影响的确认。

## 时序与依赖

```
S1 ──→ S2 ──→ S3 ──→ S4 ──→ S5
（核心）  （安全）  （界面）  （测试）  （文档）
```

S1 是自包含第一步；S2 依赖 S1 的模块；S3/S4 可并行但按序提交更稳；S5 收尾。
全部在本机可完成（不依赖显示会话机器；无 GUI 验收项）。

## 明确不做（边界）

- 不改 `TargetSupportSchema` 三值枚举、不改应用门径的 `supported` 判断形状；
- 不猜锚点、不做模糊/正则近似注入；结构检查不过的一律维持预览-only；
- 不改 `supportedVersions` 白名单内容（结构验证是**新增通道**，不是名单扩张）；
- 不动模拟预览样式与生成 token 的一致性；
- structural 通道**不宣称**「已完整验证」——文案必须如实写「结构验证通过」，
  与真机全量验证的白名单版本区分呈现。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 结构兼容但运行时有隐性差异（注入后 OpenCode 行为异常） | UI 确认框如实告知边界；恢复上一主题/原版入口保持一键可用；文档写明「结构验证不覆盖运行时行为」 |
| 自动更新竞态（inspect 后 asar 被换） | S2 强制重验，fingerprint 不一致必须重过结构检查 |
| probe 与 core 判据漂移 | S1 单一来源约束：probe 删独立实现，直接消费编译产物 |
| 单测夹具与真机结构失真 | 夹具条目名/布局严格取真实 app.asar 只读取证（docs/discovery.md 口径），不虚构结构 |
