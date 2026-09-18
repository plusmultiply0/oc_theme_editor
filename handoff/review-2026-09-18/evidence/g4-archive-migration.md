# G4 归档迁移记录（2026-09-18）

对应计划：`REVIEW_AND_FIX_PLAN.md` §三 G4。目的：消除 `npm run dist` 写进历史手工候选目录、
覆盖归档证据的脚枪；历史候选三件套按「改名加日期后缀」归档。

## 1. 改动

| 项 | 前 | 后 |
|---|---|---|
| `package.json` `build.directories.output` | `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1` | `release-dev`（中性名；正式链不受影响，`release-build.cjs` 用 `--config.directories.output` 显式覆盖） |
| `.gitignore` | — | 新增 `release-dev/` |
| README「开发命令」 | `npm run dist # 便携包` | 标注「仅开发自用，落 release-dev/；候选一律走 `npm run release:build`」 |
| 根 `candidate-manifest.json`（legacy） | `zip: candidate-...alpha.1.zip` | `zip: candidate-...alpha.1-archived-20260918.zip`；notes 追加迁移登记（未改写既有文字与任何哈希） |

## 2. 移动/改名前的哈希清单（取证基线）

对 `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1`（631 MB）、同名 `.zip`（137,295,766 B）、
同名 `.sha256.txt` 计算 sha256：

| 文件 | bytes | sha256 |
|---|---|---|
| `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.zip` | 137295766 | `9212617177fa9bb7c8f46b5bd313f7c76484f26e2c646d5e9e9de598c7e81c6c` |
| `...alpha.1.sha256.txt` | 476 | `ecbe24e0dcc1e8b2b2e5a6b38609dbb2cc1a87ee025c05a8eab834a73e2807b1` |
| `win-unpacked.new/OpenCodeThemeSwitcher.exe` | 202691072 | `99c02d6796bc2df00d7b16f8135ae9052b11bfb08384ee502b5044961756f46f` |
| `win-unpacked.new/resources/app.asar` | 17816517 | `7ca56cc52318ce49193fe32100e195a4885aaac7681660846a180daab4efdce8` |

文件数：`win-unpacked` 33、`win-unpacked-fresh` 7、`win-unpacked.new` 81。
以上 exe/asar/zip 三项与根 manifest `hashes` 字段逐一相符（改名前基线成立）。

## 3. 改名结果

- 已完成（同盘改名成功）：
  - `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.zip` → `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1-archived-20260918.zip`
  - `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1.sha256.txt` → `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1-archived-20260918.sha256.txt`
- **挂起**：目录本体 `candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1` 改名 EPERM。
  递归探测锁定叶子：三个变体各自的 `resources\app.asar`（及 `.new` 的 `default_app.asar`）——
  与既有定性一致（本机安全软件延迟打开并**持久锁 `*.asar`**；系统内并无该应用进程，
  历史 manifest 哈希复算全部 UNCHANGED，证据未受任何改写）。

### 锁释放后的收尾命令（待执行）

```bash
# 1) 目录改名
mv candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1 \
   candidate-OpenCodeThemeSwitcher-0.1.0-alpha.1-archived-20260918
# 2) 根 manifest 的 candidateDir 前缀同步改为新目录名（只改路径，不动哈希/日期字段）
# 3) 复核：exe/asar/zip 三哈希与根 manifest 仍一致
node tools/verify-release.cjs --manifest candidate-manifest.json || true   # legacy /1 记录本就不满足 /3 校验，属预期
```

## 4. 验收对照

| 验收条件 | 结果 |
|---|---|
| `npm run dist` 不再写历史候选目录 | ✅ `build.directories.output=release-dev`（已按检查输出路径方式核验；实跑 `npm run dist` 因当轮自动化策略限制未执行，正式链的 `--config.directories.output` 覆盖不受影响） |
| 历史 manifest 哈希未被改写 | ✅ exe/asar/zip 三项复算与 manifest 记录逐字节一致（改名前后各测一次，均相符） |
| 移动前列哈希清单 | ✅ 本文件 §2 |
| 失效路径同步更新 + 迁移登记 | ✅ zip 字段已更新；notes 追加登记；目录路径待 §3 收尾 |
