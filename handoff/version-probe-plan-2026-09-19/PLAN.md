# 版本探测脚本计划（version-probe）

日期：2026-09-19。来源：多版本策略讨论的落地第 3 项。
目的：把「新 OpenCode 版本适配」从人肉检查变成**跑脚本 + 一次真机闭环**的流程。

## 0. 背景与定位

- 兼容策略已定：壁纸补丁只支持白名单内已验证版本（当前 `1.18.29`），不做多版本通用匹配；
  「通用」由路线 A（官方主题 JSON）承担，不在本计划内。
- 现有 `inspectRoot`（`src/core/patch/discover.ts:167`）只查到「结构 + 版本白名单」为止，
  版本不在白名单就停在 `unknown`，**不做补丁可行性的深查**。
- 本计划补一个**只读探测脚本**：对任意版本（含未验证版本）回答
  「补丁机制在这个版本上能不能用、哪里变了」。

## 1. 硬性边界（不可违反）

1. **只读**：不写安装目录、不写归档、不启动 GUI、不启动 OpenCode。
2. **不自动进白名单**：脚本输出 PASS 也不改变 `supportedVersions`——进白名单仍是
   「代码改动 + 真机闭环 + 提交」的人工决策。
3. **判据同源**：检查逻辑必须复用编译产物 `out/` 里的生产模块
   （`readAsar` / `readAsarPackage` / `listAsarFiles` / `ADAPTERS` 声明），
   禁止在脚本里重抄一份布局/锚点定义——两套判据必然漂移（S 系列已修过同类问题）。
4. 退出码约定：`0` = 可适配（含 WARN）；`1` = 不可适配；`2` = 用法/结构错误。

## 2. 任务分解（一项一提交）

### V1：`tools/version-probe.cjs`（提交 1）

CLI：

```
node tools/version-probe.cjs <安装目录> [--json]
node tools/version-probe.cjs --discover     # 复用发现逻辑列出候选（只读），逐个探测
```

检查项（全部只读，逐项输出 PASS/WARN/FAIL 与依据）：

| # | 检查 | 判据来源 | PASS | WARN | FAIL |
|---|---|---|---|---|---|
| 1 | 结构定位 | `adapter.layout`（exe + `resources/app.asar`） | 齐全 | — | 缺任一 |
| 2 | 包名 | `adapter.matches(pkg)`（`@opencode-ai/desktop`） | 匹配 | — | 不匹配 |
| 3 | 版本与指纹 | `readAsar` 快照（version + SHA256） | 读到 | — | 读不到 |
| 4 | 注入锚点 | `readAsarText(htmlEntry)`，数 `</head>` 次数 | 恰好 1 次 | >1 次（需人工确认位置） | 0 次（结构变了） |
| 5 | 变更集合冲突 | `listAsarFiles` 查 `oc-theme-custom.css` / `oc-theme-background.jpg` | 两文件均不存在（干净） | — | 已存在（打过补丁/残留，提示先恢复） |
| 6 | unpacked 完整性（信息项） | `resources/app.asar.unpacked` 存在与条目数 | 存在 | 不存在 | — |
| 7 | 白名单比对（信息项） | `adapter.supportedVersions` | 版本在列 → 标 `supported` | 不在列 → 标 `unknown`（**不中断，继续出完整报告**） | — |

输出：默认人读报告（逐项 + 总结论 + 建议下一步）；`--json` 机器可读
（供后续接入文档或自动化）。报告必须包含 build 探测时间、安装路径、版本、指纹前 16 位。

实现约束：
- 直接 `require('../out/core/patch/...')`，跑之前要求 `out/` 为最新构建
  （脚本启动时校验 `out/main` 存在，不存在则提示先 `npm run build`，退出 2）。
- 中文输出走 UTF-8（PowerShell 子进程编码坑已有先例，见 `da01855`）。

验收：对本机真实安装目录跑 `--discover` 出完整报告，全程零写入；
`--json` 输出可被 `JSON.parse`。

### V2：单元测试 `tests/unit/version-probe.test.ts`（提交 2）

夹具：测试内用 `@electron/asar` 现构造最小归档（不依赖真实安装）：

1. 正常归档（锚点 1 次、无补丁文件）→ 全 PASS，退出 0；
2. `</head>` 缺失 → 检查 4 FAIL，退出 1；
3. `</head>` 两次 → WARN 但退出 0，报告注明需人工确认；
4. 已含 `oc-theme-custom.css` → 检查 5 FAIL，退出 1；
5. 包名不符 → 检查 2 FAIL，退出 1；
6. 版本不在白名单 → 检查 7 标 `unknown`，**其余检查照常执行**，退出 0。

注入缝：脚本需支持从环境变量/参数注入归档目录与 adapter 声明（测试不碰真实安装）。

验收：`node --check` / lint / typecheck / `vitest run tests/unit/version-probe` 全绿。

### V3：真机只读验证 + 流程文档（提交 3）

1. 对本机真实 OpenCode 1.18.29 跑 `version-probe --discover`，报告原样归档到
   `handoff/version-probe-plan-2026-09-19/evidence/`（含指纹、条目数、各检查项）。
2. `docs/compatibility.md` 追加「新版本适配流程」一节：

   ```
   OpenCode 出新版 →
   1. 装新版（或更新后）→ node tools/version-probe.cjs --discover
   2. 全 PASS → 跑一轮真机闭环（导入→应用→重启→视觉→恢复，授权后执行）
   3. 通过 → adapters/opencode-desktop.ts 的 supportedVersions 加版本号，提交
   4. 任一 FAIL/WARN → 不改代码，按报告定位结构变化，先评估再动手
   ```

3. 明确写入：**probe PASS 本身不构成发布资格**，白名单更新必须带真机闭环证据。

验收：evidence 报告在库；文档流程可照做；不动 `supportedVersions`。

## 3. 明确不做

- 不改 `supportedVersions`、不加新版本；
- 不做「自动匹配新结构」的模糊探测（锚点没了就是 FAIL，不做降级猜测）；
- 不启动 GUI、不写任何文件（除自身 evidence 归档）；
- 路线 A（官方主题 JSON 输出）另立计划，不混入。

## 4. 验证与提交约定

- 每任务一提交，格式沿用：`feat(probe): …` / `test(probe): …` / `docs(probe): …`。
- 每提交前跑：`node --check` → lint → typecheck；V2 后加单测；
  不需要跑全量集成（不碰业务代码，`out/` 之外的产物不变）。
- 本计划不依赖 A5（真实安装闭环）完成；probe 是只读工具，可先行。
