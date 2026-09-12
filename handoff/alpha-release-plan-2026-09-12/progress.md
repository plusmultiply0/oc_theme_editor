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
