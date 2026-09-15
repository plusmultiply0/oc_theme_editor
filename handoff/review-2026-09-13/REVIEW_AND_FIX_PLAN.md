# 2026-09-13审查：问题与可执行解决方案

项目：`D:\zjcfile\weblearn\vibecoding\OpenCode_Theme_Switcher`。
本轮基线：提交`40b2cfe`，版本`0.1.0-alpha.1`。
范围：源码与候选包审查、隔离复现、定向测试；不修功能、不重打包、不修改真实OpenCode、不发布。

## 一、结论

上一轮A1–A3不是没有执行：JFIF/JPE、固定图片副本、APNG拒绝、完整图片核验、HTML结构解析都已落地。当前重封的新候选也能通过30项包检查，不能把旧包的失败说成新包失败。

但是，仍有4项确认的问题和2类验收/交付问题。建议先修R1–R4，处理R5的测试失败并完成A5，再决定是否公开分发。A6据现有记录已决定跳过，应登记为风险接受/未覆盖，不应反复要求用户重做或声称已通过。

| 编号 | 优先级 | 问题 | 证据强度 |
| --- | --- | --- | --- |
| R1 | P1 | dist失败后发布脚本仍可输出ALL_GREEN并退出0 | 隔离执行原脚本主体复现 |
| R2 | P1 | 默认包检查指向旧坏包，重封新包不在默认发布链上 | 两个目录分别实测 |
| R3 | P1 | 缓存清理把在用缩略图当孤儿删除，后续预览失败 | 临时真实图片导入复现 |
| R4 | P2 | 私有副本与预览存在无界读取，体积/hash校验发生在分配内存后 | 4KiB限制却读取64KiB的受控复现 |
| R5 | 发布阻断待定位 | 定向测试49项中6项失败，含FILE_LOCKED与EPERM | 两种执行权限下均复现；根因未定 |
| R6 | P2/验收 | 候选来源与验收记录不完全一致；A5尚无真实闭环，A6跳过未统一落账 | 当前记录与发布物核对 |

P1表示影响核心行为或发布判定，应先修；没有证据表明本轮导致了真实安装损坏。

## 二、本轮验证事实

### 1. 构建产物

- `npm run typecheck`：退出0。
- 默认`node tools/verify-package.cjs`：检查旧`win-unpacked`，**30项中2项失败**：7个unpacked条目实体缺失、sharp无法正常加载出图。
- 显式指定`win-unpacked.new`：**30项0失败**。
- zip只读SHA256、内部app.asar SHA256与当前重新冻结清单一致；zip共84项。未解压运行zip、未验证真实GUI启动。

```text
旧包 app.asar:
3381173d21ac8f45039a42ade17a76611dde3a949d040a5524b713e9f5f4ac6f
新包 app.asar:
7ca56cc52318ce49193fe32100e195a4885aaac7681660846a180daab4efdce8
新分发 zip:
9212617177fa9bb7c8f46b5bd313f7c76484f26e2c646d5e9e9de598c7e81c6c
exe（新旧相同，不足以单独识别候选）:
99c02d6796bc2df00d7b16f8135ae9052b11bfb08384ee502b5044961756f46f
```

### 2. 定向测试

命令：

```powershell
node node_modules/vitest/vitest.mjs run tests/integration/image-content-fixed.test.ts tests/integration/stage-idempotence.test.ts tests/unit/image-animated.test.ts tests/unit/image-probe.test.ts --cache=false --maxWorkers=1
```

| 文件 | 本轮结果 |
| --- | --- |
| image-animated.test.ts | 11/11通过 |
| image-probe.test.ts | 9/9通过 |
| image-content-fixed.test.ts | 7/9通过；两项应用闭环失败 |
| stage-idempotence.test.ts | 16/20通过；两项应用闭环及两项受afterEach清理错误影响的测试失败 |
| 总计 | 43通过、6失败，退出1 |

初次与经批准在限制外重试的结果一致。观察到目标替换返回`FILE_LOCKED`，以及临时合成安装/运行目录的`EPERM`。不能据此断言图像固定功能本身回归，也不能忽略后声称全绿。本轮未重跑完整全量E2E或真实用户窗口闭环。

### 3. 额外复现

`reproduce-review.cjs`加载本项目已构建ImageStore并执行合成样本；发布脚本部分仅把npm换成函数桩，不运行任何真实npm构建命令。输出见`evidence/reproductions.json`和`evidence/mock-gate.log`。

- 模拟dist退出17：脚本继续verify:package、打印ALL_GREEN，最终退出0。
- 导入PNG后预览成功；传入保留imageId执行缓存清理，删除1个在用缩略图；原图副本仍在，但再次预览返回IMAGE_DECODE_FAILED。
- 配置读取上限4096字节，把自己的临时副本换成65536字节，readBytes实际先完整读入65536字节，再以IMAGE_CONTENT_MISMATCH拒绝。没有制造巨型图片或尝试内存耗尽。

## 三、逐项问题与修复方案

### R1：dist失败仍可全绿

定位：`tools/release-gate.sh:44–51`。其他步骤走run函数并检查退出码，dist却直接执行、仅echo `$?`；脚本没有自动在此退出。之后verify如果检查到旧的可用产物，整条链会错误成功。

最小修复：让dist也走同一个run路径，例如：

```bash
run dist env \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run dist
```

同时：

1. dist非0必须立即停止，保留该退出码，不执行verify，不打印ALL_GREEN。
2. 每次日志使用独立构建ID路径，避免固定`/tmp/a4-gate.txt`覆盖上次证据。
3. verify必须绑定本次生成的候选，而不是“某个仍然存在的旧目录”。
4. 增加脚本层测试：依次令每一步失败，断言后续步骤未执行；特别覆盖dist=17、旧包存在且校验可成功的情况。

验收：本轮同样的npm函数桩应得到退出17，日志中没有verify步骤和ALL_GREEN。不要实际破坏dist来做故障测试。

### R2：默认目标与真实候选脱节

定位：`tools/verify-package.cjs:17–19`默认拼接`win-unpacked`；`package.json`的build输出仍指向同一个候选根；文档实际指向`win-unpacked.new`。现有release-gate不传候选路径。

实测旧目录缺文件、新目录通过，说明这是候选选择错误，不是新包依赖仍缺失。现有记录的手工解包/换out/补依赖/重封也没有统一进入标准构建链。

修复步骤：

1. 引入单一候选manifest：version、sourceCommit、buildId、目录、exe/asar/zip hash、构建时间、打包方式。
2. 构建、包检查、GUI冒烟、压缩、hash生成、发布说明全从同一manifest/显式参数读取；验证目标不存在或身份不符则失败，不能自动退回旧目录。
3. 每次构建进入全新的buildId目录。输出目录被占用就明确失败或选择新的已登记候选，不能清理一半后继续复用；不要为了本轮修复强删旧被占用文件。
4. 把原生依赖收集、unpacked规则和运行时资源完整性检查固化进构建流程；若仍需手工重封，记录为尚不可重复构建，不能将普通dist通过视作该zip的生成证据。
5. 打包验证增加源码/构建输出与候选模块的内容比对及必要运行时资源检查，不只搜索几个特征字符串。
6. 保留旧目录用于取证，文档明确禁止分发旧包；经用户批准后再做清理。

临时正确的只读检查命令（不是永久修复）：

```powershell
node tools/verify-package.cjs 'candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1/win-unpacked.new'
```

验收：故意同时放置一个坏旧目录和一个新候选，默认发布流程只能选manifest指定的新包；生成zip与校验对象hash严格一致。仅exe相同不算候选相同。

### R3：在用缩略图被清理，预览误报图片损坏

定位：`src/main/services/image-store.ts:283–299`。

- keepSet加入的是imageId（img-...）。
- 缩略图用独立thumbnailId（thumb-...）命名，见`:338`。
- 文件名前缀比较无法把两者关联，故缩略图即使仍在records中被使用，也被当作孤儿删除。
- `previewDataUrl():259–260`只要thumbnailPath非空便直接读；读取ENOENT后不会从仍健康的私有原图副本回退，反而提示“图片可能已损坏”。

启动阶段在`src/main/index.ts:137–143`异步清理，同时创建窗口。因此用户在较慢的恢复扫描结束前已导入图片时存在触发窗口。本轮证明的是清理函数的错误行为，不宣称已观察到真实用户窗口中的该竞态。

修复步骤：

1. 分离content与thumbnail的保留集合，按完整、规范化的受控文件路径精确匹配；从每条活跃record同时收集copyPath和thumbnailPath，不用imageId前缀猜关联。
2. 持久准备记录的引用保护只针对其实际持久内容；如需保留缩略图，持久化清楚的关联，或允许安全重新生成。
3. thumbnail不存在/不可用时，从通过readBytes校验的固定副本重建；只有副本也丢失/改变时才要求重导入。
4. 处理清理与导入并发：要么在可导入前完成清理，要么给创建中/在用文件做准确保护，避免目录扫描和写文件交错。
5. 区分“缓存失效”和“原图损坏”提示。

测试：importData→preview成功→cleanOrphanCaches([imageId])→preview仍成功；同时断言活跃content与thumbnail保留、孤儿删除。另测thumbnail删除后的fallback、清理/导入交错、副本篡改后拒绝。现有缓存测试没有覆盖独立thumbnailId关联。

### R4：资源上限只覆盖初始导入，副本和回显可绕过

定位：`image-store.ts:228`整读copyPath后才比byteSize/hash；`:260/:264`回显也直接readFile；`:270/:346`的sharp调用未显式复用产品像素限制。`src/core/theme/image-probe.ts`完整raw解码同样没有产品级40MP限制参数。

这不意味着已确认用户受到攻击：私有副本不是远程入口，且hash检查最终仍拒绝错误内容。问题是拒绝之前已经读取/分配内存，无法履行资源上限承诺。确认的受控复现是4KiB上限读取了64KiB；更大文件只作风险推断，未实际测试。

修复步骤：

1. 将受限读取变成所有读图入口共用的函数；以min(record.byteSize, limits.maxBytes)等明确限额读取，超过即拒绝，再对同一Buffer做hash校验和后续使用。
2. 现有readCapped只调用一次handle.read；应循环处理短读直到EOF或max+1，不能把一次未读满当成文件结束。为此补模拟短读用例。
3. thumbnail读入也设自身尺寸/体积上限；回退路径必须使用已校验副本，不直接读任意旧源路径。
4. 初始分析、缩略图、fallback、完整核验共用像素/格式/帧数限制；在raw像素分配前拒绝超限尺寸，给解码任务设置超时/并发限制。
5. 错误码区分超限、内容改变、解码失败；细节不直接暴露不必要本机路径。

验收：小限额测试能观测到读取字节数不超过limit+1；所有图像路径对同一超限/动画/伪格式得到一致拒绝；无需生成真实巨型文件或OOM测试。

### R5：本轮应用闭环测试未通过，需要定位但不能掩盖

本轮两次测试均43/49通过，失败表现集中于合成归档替换FILE_LOCKED和afterEach删除临时目录EPERM。提升执行权限没有改变结果，不能简单归因于一次沙箱限制。

后续定位步骤：

1. 单独运行一个失败闭环，保留结构化Result的code/message/detail、文件操作的系统错误码、前后hash与临时路径。
2. 在本次新建、确认归属测试的临时目录做小文件创建/替换/删除健康探针，区分文件系统环境与业务流程；不可在真实安装目录试写。
3. 区分真实文件占用、权限拒绝、安全软件/运行环境干预、文件句柄未释放；不能把所有EPERM都默认当成“已知环境假红”。
4. 修改测试清理，使清理错误单独报告，不盖掉原始断言；保留测试现场和精确的后续清理清单。不能吞掉应用失败或把失败用例改成skip来变绿。
5. 如果代码句柄/等待/替换逻辑有缺陷，补回归再修；如果是环境问题，记录证据并在可支持的测试环境复验。不得关闭安全软件或强杀无关进程。

完成标准：本轮失败的应用闭环确实成功，或有明确外部阻断证据且发布状态仍标未完成；不复用历史273项绿灯。

### R6：验收与发布材料需要重新对齐

当前`docs/alpha-acceptance.md`仍有：前文A3/A4通过，但A8整表待执行；A7某处仍写82个zip条目，而当前为84；A6表仍写待执行，但执行记录已记载用户决定跳过。

另外，源码LICENSE/author在重新冻结后新增，当前候选并非完全对应最新源码元信息。该项不代表程序运行错误，但发布清单需区分源码与包的实际内容。

修复：

1. 依据R2候选manifest重填当前验收摘要和对应提交号，历史构建保留在历史区；不要将“见本条目提交”当作所有后续重封产物的来源。
2. A6按记录写“用户决定跳过/未验证，已知风险”，平台声明保持收窄；不要填通过，也不重复安排必须准备新机器。
3. A5仍只有只读准备，没有最新候选的真实应用/恢复/视觉结果。等用户保存退出并确认继续后才执行，不能引用历史授权自行替用户关闭程序或修改安装。
4. 记录新候选的GUI冒烟结果；Node模式sharp出图只证明该依赖可用，不代表renderer已正常启动。
5. 更新发布物元信息时重新生成hash，避免同版本同文件名下面悄悄更换不同字节；公开前完成资料/历史隐私范围确认。

完成标准：同一候选版本、来源、目录、zip、hash、测试范围与用户已接受限制可一一对应。A5与R5尚未闭环时，不给“已全面验收”的结论。

## 四、建议实施顺序

1. R1发布失败传播（小改动，先写函数桩测试）。
2. R2统一候选身份和可重复构建链，避免继续对错包验收。
3. R3修复缩略图保留与fallback，再补启动清理竞态。
4. R4统一读图/解码限制，补短读与超限测试。
5. 定位R5并重跑原有与新增测试；A5测试前冻结新的唯一候选。
6. R6更新验收记录与风险接受状态，用户决定实际验收和公开发布。

每项独立提交，保护已有A1–A3成果；不要为修这些问题回退ASAR隔离打包、非白名单校验、备份健康验证或原子替换。无需把更多图片格式列为本次前置。

## 五、交接内容与边界

- 本报告：问题定位、实测范围、修复步骤、验收要求。
- `reproduce-review.cjs`：三项问题的隔离复现；只在脚本旁新建自己的临时目录，内部清理只涉及该次合成缩略图。原发布脚本只在内存中替换cwd/log位置及npm函数，不写回项目。
- `evidence/reproductions.json`：三个断言为true意味着“成功复现缺陷”，不是产品已修好。修复后应更新期望，不能用旧故障断言作通过门禁。
- `evidence/mock-gate.log`：没有执行真正npm命令的故障传播日志。
- task_plan/findings/progress：基线、状态与失败记录。

本轮没有修改业务源码、真实安装或现有候选，没有重打包/发布；本轮测试创建的临时合成目录中有清理失败残留，未尝试强制删除或清理用户数据。
