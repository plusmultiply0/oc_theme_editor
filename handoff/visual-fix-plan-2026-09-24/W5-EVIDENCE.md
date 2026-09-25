# W5 证据：模拟预览背景图保真对齐（2026-09-25）

计划出处：`handoff/visual-fix-plan-2026-09-24/PLAN.md` §W5。
范围红线：只改 mock 呈现；token 同源、注入层、写入真机的参数零改动。

## 1. 逐项 diff 清单（注入层 `#root::before/::after` vs mock `.mock-bg-image/.mock-overlay`）

| # | 项 | 注入层 | mock（修复前） | 判定 |
|---|---|---|---|---|
| 1 | 层序 | 图片 z-2 → 遮罩 z-1 → 内容 | 同（`.mock-overlay` z-1） | 同构（F4-DIFF §1 已判） |
| 2 | 遮罩叠加 | `background: rgba(bg, overlayOpacity)` inset 0 | `--p-overlay` 同表达式 | 同构 |
| 3 | cover 三属性 | `background-size: cover; position: center; repeat: no-repeat` | 相同 | 同构 |
| 4 | 模糊 inset | `-blur*2 px` | `-blur*2 px`（同一表达式） | 公式同构，但输入未折算 → **本轮修复** |
| 5 | 模糊半径 | 真机窗宽（本轮参照 1219px）下的绝对 px | mock 容器宽（实测 700px）下的同一 px——**同 px 在小容器上相对更糊** | 差距源，**本轮修复** |
| 6 | 底图分辨率 | 全分辨率壁纸 | 512/320 缩略图（`image-store.ts` `previewDataUrl`，缓存命中时为 320 级） | 差距属实，但修它要动主进程数据链路，越 W5 边界 → **如实记录不硬凑** |
| 7 | cover 裁切区 | 以真机窗口宽高比裁中心 | 以 mock 容器宽高比（700×788，偏竖）裁中心——看到的不是同一块画面 | 缩比渲染物理极限，F4-DIFF §1.5 已标「限」→ 维持 |

## 2. 实现（第 4、5 项）

- `src/renderer/logic.ts`：新增纯函数 `mockBlurPx(blurPx, mockWidthPx, baseWidthPx=1280)`，
  按容器宽/基准宽线性折算、保留一位小数；宽度未测得（≤0）退回旧口径。
  基准取 1280（本轮真机参照 1219×766，误差 <5%，远小于观感敏感性）。
- `src/renderer/components/Preview.tsx`：`ResizeObserver` 实测 `.mock-window` 宽，
  `--p-blur`/`--p-blur-inset` 改用折算后半径（inset 随动 `-effBlur*2`）；
  残余差距（第 6、7 项）写进组件注释，不硬凑。

## 3. 实测证据

隔离临时实例（`--user-data-dir` + 临时 LOCALAPPDATA/数据目录，一次性脚本不入库）
拖入与真机同一张壁纸（`%TEMP%\ots-w2\wallpaper-1280.png`），滑杆设 0.42/0.65/4：

```
W5_STATE {"mockWidth":700,"cssFilter":"blur(2.2px)","declaredBlurVar":"blur(2.2px)","declaredInset":"-4.4px",…,"dpr":1.25}
```

4px × 700/1280 = 2.1875 → 2.2px，计算样式与注入变量一致，inset −4.4px 随动。

## 4. 验收：同图同参并排目检

- 预览侧：`w5-samples/preview-mock.png`（`.mock-window` 区域裁剪，入库；整窗图含本机安装路径，
  留 `%TEMP%` 一次性产物不入库，与 capture-ui 素材同口径）。
- 真机侧：`../w2-samples/real-after-w2.png`（op-20260924 真机 PrintWindow 截图，深色·0.42·0.65·4）。

结论：修复后预览的壁纸透出强度与真机同档（烟花光斑可见、不被糊死）；此前「mock 比真机明显更糊」消除。
可接受残差（对应清单第 6、7 项）：预览底图更软（缩略图）、裁切画面不同（cover 基准）。

## 5. 验证层级与遗留

- 单测：`tests/unit/ui-logic.test.ts` 新增「预览模糊缩比折算（W5）」3 用例（0 值、线性折算与取整、未测得回退）；全量 unit 与 lint、typecheck 见提交信息。
- 真机：本轮未动注入层与写入参数，真机留态（0.42·0.65·4）不变，restore 仍按攒窗口安排在 W4a 之后统一收尾。
- 文档截图 `docs/images/ui-preview.png` 由 `npm run capture:ui` 再生成（本地素材不入库），下次候选发布轮会带上新观感。
