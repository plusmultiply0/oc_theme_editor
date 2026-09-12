# 工作记录

- 2026-09-12：本轮为审查与执行计划，不实现功能。采用 planning-with-files 留下证据。
- 已读 skill、执行 session catchup（无恢复输出）、核对目录和 changelog。
- 未改源码/安装；准备读取测试与图片导入链。
- 已验证类型检查、release6包检查、真实安装深核验；执行内存格式探针确认jfif入口拦截与codec能力。
- 一次长node -e未返回输出，改用独立probe-formats.cjs加超时，成功获取结果。
- 一次Select-Object参数误写为forty，命令读取尾段失败；相关内容已通过rg定位，不影响诊断。
- 定向Vitest完成61/61；背景隔离E2E完成8/8，耗时1.2分钟，未触碰真实OpenCode窗口。
- 第二次读取行范围也误填英文thirty，已停止该写法，使用已有rg定位与源码证据。没有产生文件变化。
- 格式探针成功写入format-evidence.json；node --check退出0。
- NEXT_EXECUTION_PLAN.md包含8项分批任务、格式能力矩阵、源图变化风险、规范化与旧备份迁移及验收用例。
- 真实窗口视觉验收仍待执行；本轮没有实现JFIF兼容，也未重新发布应用。

## 第一批执行记录（2026-09-12，jc 指示：完成一项提交一项）

按本目录 `NEXT_EXECUTION_PLAN.md` 的 T1 → T2 → T3 顺序执行。

| 提交 | 事项 | 内容 |
|---|---|---|
| `46af497` | T1 格式声明与入口 | 新增 `src/shared/image-formats.ts`，三处消费方（对话框 / 主进程校验 / 界面文案）改为同源 |
| `f9a61f0` | T2 入口回归 | 程序生成的样本 + 15 项入口/异常回归 |
| 本提交 | T3 闭环与发布 | 合成安装 A→B→C→no-op→恢复闭环、README/CHANGELOG、release7 |

### T1 关键决定

- 只登记**内容格式**（jpeg/png/webp），别名（jpg/jpeg/jfif/jpe）挂在 jpeg 下；
  不新增 `jfif` 这类伪枚举，旧 ThemeSpec / 备份数据无需迁移。
- `.jpe` 一并补齐（计划表里同属第一批；本机 sharp 的 `jpeg.input.fileSuffix` 包含它）。
- 后缀与实际内容不一致且都属于受支持格式时：按实际内容处理并如实提示，不静默按后缀解释。
- 一条结构性断言守住边界：这份声明不得 import sharp / node:fs / node:path / electron
  （界面会引用它）。

### T2 覆盖

- 选图入口：`.jpg/.jpeg/.jfif/.JFIF/.jpe/中文名.JFIF` 全部可选中并导入，格式 jpeg；
- 拖拽入口：四个别名可导入，预览副本可用，并一路跑到真实的 `generateTheme`（不是只断言 resolve）；
- 两入口对同一份字节结论一致（格式、尺寸、hash）；
- 异常（文本伪装 / SVG 伪装 / 截断 / 空文件 / 超限）在两个入口都拒绝，错误与建议均为中文；
- 取消选择不作废上一张图；PNG / WebP 原有路径不回归。
- JFIF 样本按规范构造（SOI 后插入 APP0/JFIF 段），因为**sharp 自身不输出 JFIF 标记**——
  这一点也写成断言，将来 sharp 改变行为时会立刻暴露。

### T3 闭环与门禁

合成安装上跑通：`.jfif → .png → .webp → 同图 no-op → 恢复上一主题 → 恢复到首次接管`，
判据是归档内背景条目**字节等于当次图片**、HTML 链接始终唯一、
no-op 不改盘不新增事务且复用同一操作记录、恢复后指纹逐级回退。

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 |
| `npm run lint` | 0 |
| `npm run test:unit` | 122 项通过 |
| `npm run test:integration` | 114 项通过（10 文件） |
| `npm run test:e2e` | 16 项通过 |
| `npm run test:e2e:electron` | Electron 36.9.5：35/35 |
| `npm run dist` | release7 |
| `npm run verify:package` | 28 项 0 失败（964 条目，包内含 jfif/jpe 声明） |

顺带修掉一处**环境导致的假红**：`electron-runtime.test.ts` 原本靠删除结果文件来判定「结果已生成」，
在本机执行环境里删除会被守卫拒绝（本轮删除次数封顶），于是用例变红而产品其实没问题。
现在改为按报告里的 `ranAt` 判断「结果是否新鲜」：删不掉旧文件也不会读到陈旧成功。

### 未完成（需要 jc）

1. **真机应用与视觉走查（T3 第 2、3 步）**：需要你明确授权，才能把 release7 应用到真实 OpenCode；
   之后要确认官方主题反复切换、首页/会话/侧栏/输入/菜单/Portal/旧新布局都能显示背景，
   并保存真实截图与只读 DOM 探针（`probe-live-background.js`）。本轮**没有**触碰真实安装。
2. 第二批（T4–T7：规范化静态图 + GIF/AVIF/TIFF）与第三批（T8：核验脚本改为真实完整解码、
   HTML 结构边界）尚未动，按计划顺序留待后续。
3. 当前已知设计：背景条目在归档里固定叫 `oc-theme-background.jpg`，
   非 JPEG 内容也落在这个名字下（按原图字节写入），改名与统一编码属第二批 T4/T6。
