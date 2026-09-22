# UI 精简与启动按钮计划（2026-09-21）

> 来源：jc 截图反馈两点——
> （1）顶栏白条太大，不需要 125% 和 150% 缩放档；
> （2）增加一个「启动 OpenCode」按钮。
> 基线：HEAD `3c37369`（alpha.3 已发布，structural 通道已上线）。

## 现状（已核实）

- 缩放钮：`App.tsx:35-40` 定义 100/125/150 三档（T56 为 125%/150% DPI 加），
  截图确认顶栏因此又高又空，是「白条太大」的直接成因；
- 布局本身全部 rem/弹性（styles.css:3），**去掉缩放档不影响 125%/150% 系统缩放下
  不裁切的既有能力**——那是 CSS 的职责，不是这组按钮的职责；
- `localStorage['ots.ui-scale']` 可能存着 125/150，需处理旧值；
- 启动通道：preload 白名单（src/preload/index.ts）现无 launch 类方法；
  主进程 handler 统一在 `src/main/ipc.ts` 注册；
- 进程检测已存在：`precheck.ts` 的 `probe(exePath)` 返回 idle/running/unknown，
  可复用做按钮状态；
- renderer 按安全基线**只拿 targetId 不拿路径**——启动必须按 ID 解析，不得把
  安装路径透传给渲染层。

## 任务分解（一项一提交）

### U1：顶栏精简 + 移除缩放档

- 删 `SCALE_OPTIONS` 的 125/150 两项及顶栏缩放按钮组（App.tsx 整段 `.scale` 渲染、
  `scale` state、`loadScale`/`SCALE_KEY` 写入逻辑）；
- 旧值处理：启动时若读到 localStorage 非 100 值，直接忽略并覆写为 100
  （不弹提示，静默收敛）；
- 顶栏样式收紧：`padding` 降一档，`.sub` 副标题与标题合并为一行区域，消除大片留白；
- styles.css:3 注释改为「尺寸用 rem/弹性布局，跟随系统缩放不裁切（T56），
  界面内不再提供手动缩放档」。

**验收**：lint/typecheck 0；单测无回归；真实窗口截图对比顶栏高度下降、无缩放钮。

### U2：「启动 OpenCode」按钮（IPC 全链路）

- **shared/ipc.ts**：`ThemeSwitcherApi` 增加
  `launchTarget(targetId: string): Promise<Result<{ launched: boolean }>>`；
- **preload/index.ts**：白名单加一行 `launchTarget`（只透 ID，不扩其他面）；
- **src/main/ipc.ts**：`ipcMain.handle('launchTarget', ...)` 走既有 `wrap` 模式；
- **target-service**（或新建小服务）：按 targetId 解析目标记录 → 用 adapter 声明的
  `layout.exe` 拼接安装根（**不从渲染层收路径**）→ 物理层确认 exe 存在 →
  `spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()`；
- exe 不存在 / 目标无记录 → 返回干净错误（错误码 + 恢复提示），不抛裸异常；
- renderer：顶栏放按钮（主按钮样式），无目标时禁用；已检测 running 时
  复用 `precheck.probe` 口径把文案变为「打开 OpenCode」（单机实例下二次
  spawn 会聚焦已有窗口，语义不变）。

**验收**：lint/typecheck 0；单测覆盖「exe 缺失→干净错误」「未知 targetId→拒绝」；
真机点按钮 OpenCode 拉起。

### U3：测试与文档收尾

- 单测：launch 服务路径解析（只认 adapter 声明的 exe 名、拒绝路径逃逸输入——
  虽然入口只有 ID，仍测拼接逻辑只在安装根内）；
- e2e 选择器兼容确认：`.scale` 删除后若有测试引用需同步；
- README 傻瓜向使用说明加一句「启动 OpenCode」按钮的用途说明；
- 截图留存 before/after 到临时目录（含临时路径，不入库）。

**验收**：全量单测绿；e2e 不因删 `.scale` 断裂。

## 时序与依赖

```
U1（界面）──→ U3（收尾）
U2（功能，独立）──→ U3
```
U1 与 U2 互不依赖，可任意顺序；各一个提交。

## 边界（写死）

- 不向渲染层暴露安装路径或通用 shell/spawn 能力——launch 只按 targetId 走
  adapter 声明的固定 exe 相对路径；
- spawn 必须 `detached + unref + stdio:'ignore'`，不等待、不占用句柄；
- 不动模拟预览层（mock-*/--p-*）任何样式与 token；
- 缩放档移除是产品决定（jc 拍板），但 rem 弹性布局保留，系统级缩放适应能力不降级。

## 执行记录（2026-09-21）

- U1 顶栏收紧 + 缩放档移除：`ded5175`
- U2 launchTarget 全链路（shared→preload→main IPC→TargetService.launch→顶栏按钮）：`958d0c1`
- U3 守卫单测两例 + README 第 4 步按钮说明：`4d11f43`
- 门禁：lint/typecheck 0；unit 342/342；playwright e2e 16/16；DOC_ENTRY_OK（README 改动后复验）。
- 如实注记：`npm run test:e2e:electron` 本轮未单跑（automode 拦，先例同；留发布全链或桌面会话）；
  before/after 截图在临时目录 `%TEMP%\ots-ui-shots\after-u1u2.png`，不入库；
  新顶栏观感与「启动 OpenCode」真机点击归 jc（G1 视觉观察职责）。
- 已推送：origin/main = `4d11f43`（3c37369..4d11f43 三提交）。

### 追加：2026-09-22 全门禁复验

- typecheck/lint 0；unit 342/342；playwright e2e 首跑 3 例级联失败
  （265 点「应用到 OpenCode」后 15s 确认框未出现，286/294 为其级联），
  原样复跑 16/16（48s）。期间代码零变更（仅文档提交），按环境争用偶发处理、未改代码，
  与 docs/acceptance.md §8.2 同类口径；若后续再现再立案诊断。
