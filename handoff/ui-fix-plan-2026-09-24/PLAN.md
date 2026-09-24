# 四项修复实施计划（2026-09-24）

> 来源：jc 四项反馈——
> 1. 「启动 OpenCode」按钮能打开但加载不了对话 → 删除，让用户自己双击；
> 2. 新增「自动调整」按钮（按图片自动设 背景遮罩/面板不透明度/背景模糊）；
> 3. 删除 Electron 默认顶部菜单栏；
> 4. 模拟预览效果比真实差很多 → 修预览保真度。
>
> 进度标注截至 2026-09-24 15:28。

## F2：删除默认菜单栏（✅ 已完成，`0694937`）

- `src/main/index.ts`：`win.setMenu(null)`，typecheck/lint 0。

## F1：删除「启动 OpenCode」按钮（⚠️ 改完未提交，单测未验证）

理由：spawn 方式拉起的 OpenCode 加载不了对话（子进程环境残缺），不如用户双击。

已做改动（工作树未提交，7 改 1 删）：
- `src/renderer/App.tsx`：状态栏按钮 + `launchedId` state + `launchTarget` callback 删除；
- `src/preload/index.ts` / `src/shared/ipc.ts`（通道 + 类型）/ `src/main/ipc.ts`（handler）
  / `src/main/services/target-service.ts`（`launch()` 与 `launchIo` 注入点）删除；
- `src/shared/errors.ts`：`LAUNCH_FAILED` 删除；`styles.css`：`.status-launch` 删除；
- `tests/unit/target-service-launch.test.ts` 删除。

待办：单测验证（本机 vitest 连跑三次 SIGTERM——已知「项目盘 TEMP → vitest 不退出」
环境坑，`OTS_TEST_TMP` 绕法本轮未生效，需换一轮会话重跑）→ typecheck/lint 已过（0）→ 提交一个。

## F3：新增「自动调整」按钮（待实现）

- 位置：三个滑杆上方，与「选择图片」同级；
- 逻辑（确定性，不随机）：读图片代表色/亮度 →
  - **背景遮罩**：按合成后有效底色亮度反推，深图低遮罩、浅图高遮罩（0.55–0.85）；
  - **面板不透明度**：默认 0.85（减少自由度，不做独立推导）；
  - **背景模糊**：图片边缘密度高才给 4–8px，否则 0；
- 推完复用 `analyzeContrast` 自检，不达标则遮罩步进上调（有上限，
  仍不过保留最优并如实提示）；
- 只改三个 `spec` 值，不触发应用；
- 验收：单测（深浅两图断言参数区间 + 对比度达标）→ lint/typecheck 0 → 提交一个。

## F4：修复模拟预览保真度（待诊断）

1. **取证（一小提交）**：真实注入 CSS（core/theme 生成）与 mock 预览样式逐项 diff——
   层叠顺序、模糊 inset、面板圆角/边框/阴影、遮罩叠加位置、背景图 cover 方式，
   产出差异清单入 handoff；
2. **对齐（一提交）**：按清单逐项修 `.mock-*`，让预览与注入 CSS 的三层模型
   （图片→遮罩→面板）逐层同构；
3. **验收**：同一张图真实应用截图 vs 预览截图并排对比（截图留临时目录不入库）。

## 执行顺序

```
F1 验证+提交 → F3 → F4（诊断 → 对齐）
（F2 已完成）
```

边界：F3/F4 不动服务层与 IPC；F4 对齐的是 mock 样式的**外观同构**，
token 与透明度参数仍与生成层同一来源，不得为好看偏离。
