# 修复执行审查与多图片格式支持：后续计划

审查日期：2026-09-12。实际项目：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。
基于提交 `a58613b`（release6）。本轮只做审查、隔离测试和计划，未实现新功能、未应用主题到真实安装。

## 1. 目前执行得如何

结论：上一轮 F1–F4 已落实，不能再按“尚未修复”安排重做；但真机视觉验收仍未闭环，多格式输入目前也没有实现。

| 上轮事项 | 当前证据 | 状态 |
| --- | --- | --- |
| 动态主题覆盖 | css.ts 使用 html:root，安装内 CSS 同样已更新 | 已实现 |
| 正文不透明/外壳多一层 | stronger 使用 rgba，限定 NewLayout 外壳透明规则存在 | 已实现 |
| 连续换图幂等 | stage.ts 改为 verifyStagedHtml；A→B→C、C→C 测试通过 | 已实现，结构校验仍有小边界待补 |
| 气泡 alpha 重复计算 | bubbleLayerAlpha 与累计 bubbleAlpha 分离；对应单测通过 | 已实现 |
| 真机写入 | changelog/git 记录 A→B→A；本轮独立核验当前归档与资源 | 写入结果可确认，操作历史仅据执行记录 |
| 发布包 | 当前 release6，verify-package 检查28项通过 | 当前可用构建，不应再测试旧 release4 |
| 真机所有页面视觉/Portal | changelog 明确仍缺真实截图与 DOM 探针 | 未完成，不得宣称全量验收 |

### 本轮实际执行的检查

- `npm run typecheck`：退出码0。
- 定向 Vitest：`surfaces.test.ts` 6项、`theme.test.ts` 46项、`stage-idempotence.test.ts` 9项，共61项通过。
- `node tools/verify-package.cjs`：28项，0失败。
- `node tools/verify-real-install.cjs --archive <真实app.asar> --deep`：15项，0失败；逐条完整性6949条、共享 offset 无冲突。脚本解析1293条，另有2776条“不支持解析”，这些不能算已解析通过。
- 格式探针使用项目安装的 sharp 0.35.4：JPEG/PNG/WebP 的 analyzeImage 成功；GIF/TIFF/AVIF 可解码，但被应用格式白名单拒绝；JFIF 的选图与拖拽入口均拒绝。
- 当前背景另行通过 sharp 完整像素解码，不只看文件头。
- 隔离背景 E2E：`background-cascade.spec.ts` 8项全部通过，耗时1.2分钟；不要把隔离浏览器等同真实 OpenCode 页面。
- 本轮没有重跑完整205项集成/单测，也没有重新执行全部Electron真窗口用例；changelog中的这些历史结果不得写成本轮结果。

当前安装指纹：

```text
app.asar:
072a92856daff8d84c32b7e4e0b540df7899eaabce34d2f8db6f3e270a64572f
background:
b89f8f8d83b98a1a078169745d61908a93590d1cfbbed515b2a6fd232d36afb5
```

## 2. 为什么 .jfif 现在打不开，难不难做

很适合作为下一批的小改动。它应作为 JPEG 扩展名别名接入，不需要开发新的 JFIF 解码器。

实际阻断位置：

1. `src/main/index.ts:73`：系统选择框 extensions 只有 png/jpg/jpeg/webp，文件可能不显示。
2. `src/main/services/image-store.ts:20`：ALLOWED_EXTENSIONS 没有 .jfif/.jpe。pick 和 importData 都在读图/解码前拒绝；只改选择框不够。
3. `src/core/theme/validate.ts:14`：内容格式 jpeg 已经存在；JPEG magic 检测不依赖 .jpg 后缀，别名不需要新增 `ImageFormat='jfif'`。

本机 `sharp.format.jpeg.input.fileSuffix` 明确包含 `.jpg/.jpeg/.jpe/.jfif`；同一份有效JPEG字节直接分析成功，经 `.jfif` 文件名导入失败。这是入口支持不完整，不是图像编码不支持。

### 建议支持范围

| 格式/扩展名 | 本机证据 | 建议 |
| --- | --- | --- |
| JPEG：.jpg .jpeg .jfif .jpe | JPEG decoder现成，后两项被应用拒绝 | 第一批直接补齐 |
| PNG、WebP | 当前可导入，需回归透明度与动画策略 | 保留并加强测试 |
| GIF | 合成静态GIF完整解码成功 | 第二批支持，动画固定第一帧并明确提示 |
| AVIF | 合成图完整解码成功，metadata.format为heif | 第二批；按容器/压缩类型区分AVIF与HEIC |
| TIFF：.tif .tiff | 合成单页TIFF完整解码成功 | 第二批；固定第一页，限制页数/像素/解码成本 |
| BMP | 当前未取得可用解码器/样本验收证据，magick输入关闭 | 后续单独适配，不只增加后缀 |
| HEIC/HEIF | heif loader存在不等于HEVC内容可解；本机suffix只声明avif | 暂不承诺，先在发行包验证真实样本 |
| SVG | 项目明确拒绝，属于不同处理面 | 继续拒绝，不因sharp能读就开放 |

本机小样本成功仅证明基础解码能力，不代表所有位深、色彩空间、编码变体和多帧文件都已支持。不要自动把 sharp.format 能识别的所有类型都放进UI白名单。

## 3. 扩展前还需要解决什么

### A. 当前把原图原样放入 .jpg 文件

`ImageStore.readBytes()` 返回原图；`operation-service.ts:309` 应用时再次从 imagePath 读字节；适配器固定写入 `oc-theme-background.jpg`。

本轮真实安装的这个 `.jpg` 实际解码为 **PNG，691×591**。当前能够解码不代表这一设计适合继续扩展。TIFF、动画、多页、EXIF方向和色彩空间加入后，必须避免“预览经过转换，安装直接用原图”的两条不同路径。

建议第二批建立唯一的规范化静态图片：选定帧/页→EXIF方向纠正→sRGB→统一编码；取色、缩略图、预览和安装均由这份图片生成。

### B. 分析之后原文件仍会被重读

原生选择的文件在分析、确认、应用间可能被用户替换。当前 stage record存路径，apply重读后重新算hash，并不确保它就是用户预览过的内容。规范化时同时生成应用私有、内容固定的副本；确认阶段绑定该副本hash，应用前核对，变化就拒绝并要求重新分析。不能把新读到的图默默套上旧取色参数。

### C. 解码核验名不副实

`tools/verify-real-install.cjs` 的“图片可解码（JPEG/PNG 魔数）”实际只检查首字节0xff或PNG字符片段，没有执行decode。JPEG只剩头部也可能得到该项OK。

应使用完整decoder并核对实际格式、尺寸和预期hash；将“文件头识别”“完整解码成功”分成两个检查项。本轮已另行完整解码，当前图片本身没发现损坏。

### D. HTML门禁的剩余边界（较低优先级）

`verifyStagedHtml` 只验证link在 `</head>` 前，没有确认在 `<head>` 之后；匹配自身href只支持特定双引号拼法。补充“head之前的link”“注释中的伪link”“单引号重复link”测试，完善结构读取；不要为通过测试恢复“HTML必须变化”的旧逻辑。

## 4. 分批执行任务（其他agent可照此实施）

### 第一批：JFIF/JPE兼容，小步发布

**T1：统一格式声明，先写失败测试。**

- 新建 `src/shared/image-formats.ts`，维护纯数据的格式与扩展名别名映射；不能从renderer导入sharp或Node fs。
- jpeg别名包含 jpg/jpeg/jfif/jpe；png/webp保持。
- `main/index.ts` 文件对话框、ImageStore校验、UI支持范围说明从同一份声明生成，避免分别手写。
- 文件扩展名大小写不敏感；内容必须通过允许格式识别及真实解码。扩展名仅用于筛选，不是安全凭证。
- 明确策略：允许“受支持后缀、实际内容是另一受支持格式”时，应显示实际格式或提示命名不一致；无论如何不能接受损坏/非图片内容。

**T2：补入口与回归。**

- 验证 .jfif/.JFIF/.jpe 的原生pick→import和拖拽importData→预览→生成。
- 用有效JPEG字节构造不同别名fixture，不要求用户把原文件改名。
- 至少一个真实JFIF样本验证；测试工程同时保留可程序生成的样本，避免仅有私人图片。
- 非JPEG文本伪装jfif、截断JPEG、空文件、SVG伪装、超限图片均应返回中文错误且不产生可应用状态。
- 对话框/拖拽给出相同支持范围，取消选择不破坏已有主题。
- 运行JPEG/PNG/WebP原有测试；格式枚举仍为jpeg，不迁移旧ThemeSpec/备份数据。

**T3：完成真机视觉走查并发布第一批。**

- 在临时合成安装完成 .jfif→.png→.webp→同图no-op，以及恢复闭环。
- 获得用户明确授权后才把新构建应用到真实OpenCode。
- 确认当前官方主题反复切换、首页/会话/侧栏/输入/菜单/Portal/旧新布局都能显示；保存真实截图与只读DOM探针。
- 更新 README/CHANGELOG，构建新版本并核对实际输出目录，不沿用过期release4/5。至少独立提交“格式声明与入口”“回归与发布”两部分。

第一批不依赖GIF/TIFF等实现，不需要改ASAR打包算法，不应因架构重构推迟JFIF兼容。

### 第二批：规范化静态背景 + GIF/AVIF/TIFF

**T4：创建规范化服务。**

- 新建 `src/core/image/normalize.ts` 或等价模块，输入Buffer、限制与帧/页策略，输出规范化bytes、实际sourceFormat、outputFormat、纠正后尺寸、warnings、sourceHash和normalizedHash。
- 建议先统一为静态PNG：透明通道保留、输出确定、与浏览器显示兼容；不允许只把TIFF原字节改名为PNG。
- 明确第一帧/第一页策略；GIF、动画WebP/APNG、多页TIFF一致处理。UI展示“已使用第1帧/页”，本轮不实现动态壁纸。
- EXIF方向只纠正一次，输出尺寸取纠正后的结果；统一sRGB并处理灰度/CMYK/16bit输入，去除不必要EXIF隐私元数据。
- 保留现有20MiB输入与40MP单图限制，另设输出体积、选定帧像素、页数/帧数检查、超时与并发上限；不可只在解码结束后才判断资源超限。
- 透明像素不应扰乱主色和亮度；预览与报告需考虑透明内容落到背景底色后的效果。必要时提供明确的透明底合成策略，而不是静默变黑。
- 对AVIF使用可靠容器识别+decoder校验；metadata.format=heif时核对compression=av1/实际支持能力，不能顺带把HEIC开放。

**T5：存储固定副本并统一所有消费者。**

- ImageStore登记source信息与normalized文件，原图只读；readBytes改为读取已固定的规范化副本。
- analyzeImage、thumbnail、preview、prepare、apply复用规范化内容，不重复读取用户源路径。
- stage record绑定normalizedHash；文件变更/缓存失效返回可恢复错误，不能应用未预览内容。
- 图片哈希语义显式区分源文件hash与规范化hash；no-op根据规范化内容、CSS、规范化算法版本判定，避免EXIF变化或升级导致混淆。
- 失败导入及时清理自己创建的临时副本，不删除用户源文件；处理进程退出后的残留清理。

**T6：适配输出路径与兼容迁移。**

- 新主题写 `out/renderer/oc-theme-background.png`，CSS引用同步更新。
- 更新adapter允许变更列表、verify-real-install、测试fixture、图片引用验证及相关硬编码；通过rg全仓搜索旧.jpg路径逐处判断。
- 兼容旧备份/事务：旧.jpg仍是历史合法工具条目，恢复旧主题不得因白名单变化被误拒绝。先明确基线迁移，不能直接丢弃旧hash校验。
- 首次迁移可保留归档中旧.jpg但不再引用，避免当前“不得删除条目”门禁冲突；以后清理需单独设计，勿顺手删除。
- 不改打包worker、非白名单基线、unpacked保留和原子替换的安全约束。

**T7：按能力逐个开放新格式。**

- 顺序建议：GIF静态化→AVIF→TIFF首页。每格式独立fixture与提交。
- 入口格式注册表增加对应项，解码能力从主进程提供给renderer，但产品允许列表必须独立保留。
- 在实际发行包中加载sharp并decode样本，不只在开发目录通过。若某格式依赖缺失，UI不宣称支持，错误说明缺少该解码能力。
- BMP/HEIC另立任务，先证明Windows发行包可用解码器、资源限制及测试样本，再选实现；不自动安装外部程序或引入大依赖。

### 第三批：补验证可信度与维护性

**T8：修正图片核验脚本与HTML结构边界。**

- 安装核验完整decode、hash、outputFormat、width/height、动画/页数策略；损坏头部样本必须失败。
- HTML验证以真实head区间和link属性为准，忽略注释；单双引号和大小写处理一致，重复链接仍拒绝。
- 测试报告明确“解析成功/不支持/跳过”的数量，不把不支持的ESM解析说成已验证。
- 更新旧handoff/progress的过时状态：恢复安装、release6、仍缺真机截图等分开记录。

## 5. 必须交付的测试矩阵

| 类别 | 最少覆盖 | 成功标准 |
| --- | --- | --- |
| JPEG别名 | jpg/jpeg/jpe/jfif、大小写、中文名 | 两个入口均可导入，实际格式jpeg |
| 旧格式回归 | PNG透明、静态WebP、EXIF旋转JPEG | 预览与规范化背景一致 |
| 新格式 | GIF首帧、AVIF、TIFF首页 | 标准PNG输出完整decode，提示帧页策略 |
| 色彩与尺寸 | 灰度/CMYK/透明/16bit/旋转 | 色彩合理、尺寸正确、取色确定 |
| 异常与限制 | 假后缀/截断/空/SVG/超大/多帧 | 拒绝或按明确策略处理，安装hash不变 |
| 文件变更 | 分析后替换源图，缓存副本被改 | 使用已确认固定副本或拒绝，不静默错配 |
| 应用闭环 | A→B→C、C→C、恢复旧.jpg主题 | link唯一、正确图片hash、no-op、恢复成功 |
| 真实窗口 | v1/v2、切主题、重启、Portal | 背景可见、对比度可读，无新启动错误 |
| 发行包 | 干净环境对每种承诺格式解码 | 不依赖开发node_modules或本机外部工具 |

建议增加 `tests/unit/image-formats.test.ts`、`tests/unit/image-normalize.test.ts`、`tests/integration/image-import-formats.test.ts`；扩展现有main-services、theme-switcher、stage-idempotence测试。不要只断言Promise resolve，必须检查返回success、真实图像内容与错误情况下安装未变。

## 6. 执行命令与交接要求

以下是实施agent修改后执行的门禁，不代表本轮全都执行：

```powershell
Set-Location -LiteralPath 'D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher'
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
npm run test:e2e
npm run test:e2e:electron
npm run dist
npm run verify:package
```

每条命令非0即停，先处理失败再继续。涉及真实安装或关闭用户进程时须再次取得用户授权；以上合成测试通过并不自动授权真机应用。

本目录 `probe-formats.cjs` 可复查本机decoder与已构建应用格式检查，它不实现新功能；修改源码后要先构建才能反映变化。

```powershell
node .\handoff\format-review-2026-09-12\probe-formats.cjs
```

最终交付：修改文件清单、逐项测试结果、实际发布包路径及hash、格式能力表、真机截图/DOM探针、已知限制。先交付JFIF/JPE小版本，第二批再承诺新增编码格式。

## 7. 参考依据

本机源码和运行探针是本报告的直接证据。元数据API可区分format/pages/pageHeight/compression/alpha/orientation等，但metadata读取不等同完整像素解码，参见[sharp Input metadata](https://sharp.pixelplumbing.com/api-input/)；转换输出与元数据处理选项参见[sharp Output options](https://sharp.pixelplumbing.com/api-output/)。实际能力以发行包运行结果为准。
