# 工作记录

2026-09-12：使用planning-with-files技能分离计划、证据与执行状态。

- 完整读取技能并运行session-catchup，无需要恢复的输出。
- 核对项目路径、当前提交、package以及JFIF实现记录。
- 本轮只生成计划文件；没有修改业务源码、依赖、版本、安装或发布任何内容。
- RELEASE_ALPHA_PLAN.md包含A0–A8、测试矩阵、构建命令、GO/NO-GO和实施agent交接指令。

后续agent请在此追加每项执行结果，禁止把计划中的预期结果当作已通过。

## A0 固定基线与验收模板（2026-09-12，wb 执行）

现场（开工时实测）：

| 项 | 值 |
|---|---|
| 起点提交 | `8e6bd04`（tag `v0.1.0`） |
| 未提交改动 | 仅本计划目录未跟踪；源码无未提交改动 |
| package | version `0.1.0`、`private: true`、`build.directories.output` = `release7` |
| 既有 release 目录 | `release` ~ `release7`（全部过期；`release7` 曾为候选） |
| 候选版本名 | 待 A4 确认未占用后定（建议 `0.1.0-alpha.1`） |

产出：

- `handoff/alpha-release-evidence/`（私有证据目录）：只把 `README.md` 与
  `.gitignore` 入库，其余原始日志/截图/探针输出全部本地保留；
  摘要写进验收文档，不把本机路径带进仓库。
- `docs/alpha-acceptance.md`：按 A0 要求给出「候选版本/提交/包 hash/平台/执行人/时间/
  步骤/期望/实际/结论/证据」的表，初始**全部标「待执行」**，不预填成功。
- 明确 A5（真实安装）、A6（干净环境）、A8（GO/NO-GO）在授权前保持待执行；
  当前结论按计划口径记为 **NO-GO**（缺真机与干净环境证据）。

测试机器与 OpenCode 版本信息待填（不为了匹配白名单自行降级 OpenCode）。

## A3 核验可信度与 HTML 边界（2026-09-12，wb 执行）

新增 `src/core/theme/image-probe.ts`：把「文件头识别」与「完整解码」分成两件事，
解码走 `sharp(buf).raw().toBuffer()`（metadata 只读头部，不算解码）；
SVG 在这里也拒绝（本机 sharp 自带 SVG 解码器，只看解码成功会把矢量图判成可用背景）。

`tools/verify-real-install.cjs`：
- 图片检查拆成「文件头可识别」「完整解码成功」「不是多帧动图」；
  新增 `--expect-image-format`、`--expect-image-size`；失败即非 0 退出。
- 明确输出「实际格式 X（条目名后缀不代表内容）」——适配器固定写 .jpg，
  内容可能是 PNG/WebP，不能靠后缀推断。
- deep 模式把脚本解析写成「解析成功 N；跳过 X、不支持 Y（这两类未验证，不计入成功）」。

HTML 门禁（`verifyStagedHtml`）改为真实结构解析：
先按等长抹掉注释（伪标签不参与）、解析 `<link>` 属性（单双引号 / 无引号 / 大小写 /
多余空白）、要求本工具链接恰好一个且**完整落在 `<head>`…`</head>` 区间内**。
新增正反例 13 项：注释伪 link、单引号重复、大小写、无引号、去 ./、head 之前、
body 里、缺开头 head、标记冲突等。

### 过程中抓到的真实缺陷（已修）

`injectLink` 清除上一次注入时按「整行」删除：`lastIndexOf('\n', marker)` 找不到前导换行时
`lineStart` 退化为 0，于是**把文档开头到标记之间的内容整段删掉**。
真实安装的 `</head>` 自成一行，所以一直没暴露；单行/压缩过的 HTML 会被静默损坏，
而旧测试只数 link 数量，正好把它盖住。现在只精确定位并删除上一次注入的 `<link>` + 标记，
其余一个字符不动；新增「单行 / 多行 HTML 各连续注入三次」回归。

### 测试与门禁

| 命令 | 结果 |
|---|---|
| `npm run typecheck` / `npm run lint` | 0 / 0 |
| `npm run test:unit` + `test:integration` | 273 项通过（21 文件） |
| `npm run test:e2e` | 见 A4 记录 |
| 新增用例 | `tests/unit/image-probe.test.ts`（8）、`tests/integration/verify-real-install.test.ts`（4）、`stage-idempotence` 扩到 20 |

真机只读核验（当前安装）：背景 jpeg 1000×714、pages=1，HTML 链接唯一，
CSS 为 html:root + stronger rgba + 外壳规则。**未写入真实安装**。
