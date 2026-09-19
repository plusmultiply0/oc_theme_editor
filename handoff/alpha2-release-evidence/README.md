# alpha.2 候选 20260919055321-f8bb4fb-e00e50 构建证据（2026-09-19）

**结论先行**：`npm run release:build` 在本机**桌面 cmd 会话**由 jc 本人手动执行，
末行 `ALL_GREEN buildId=20260919055321-f8bb4fb-e00e50`，登记后核验
`stage=final publishable=true`。G1「必须换机」结论就此修订（见
`docs/acceptance.md` §8.1）。

## 证据文件

| 文件 | 内容 |
|---|---|
| `release-build-round3-20260919.log` | 第 3 轮（成功轮）完整日志，从 `D:\zjcfile\release-build-manual.log` 原样复制 |

- SHA256（日志副本）：`b085476cbd981d40640363ff992fd1676b3c87857f49a74cff01a0e5251d17b6`
- 日志以 `>` 重定向写入同一文件，**第 1、2 轮日志已被第 3 轮覆盖**，
  其拦停现场以会话摘录形式记录在下文，不冒充独立存档。

## 三轮时间线

| 轮 | buildId | 结果 |
|---|---|---|
| 1 | `20260919054303-6154fc0-ebedb9`（未登记） | 停在 `test:unit`：编码自检误扫 `release-dev/` 下 `LICENSES.chromium.html`（G4 改名后豁免正则漏配）。修复：`7eff0b6` |
| 2 | `20260919054633-7eff0b6-7b9983`（未登记） | 前 10 步过，`smoke:gui` 首次以默认空参数真过（`SMOKE_OK`，20.8s）；停在 `verify-package`：归档顶层白名单缺 `LICENSE`（与 A2-1 包内 LICENSE 决定冲突）。修复：`f8bb4fb` |
| 3 | `20260919055321-f8bb4fb-e00e50`（**当前候选**） | 12 步全绿 + register + verify:release（发布级 18 项 0 失败 `RELEASE_GREEN`）+ receipt，`ALL_GREEN` |

第 1 轮停在 `dist` 之前未生成候选目录；第 2 轮目录仍在磁盘。两者均无 manifest
登记与 receipt，**不可发布**，处置待决策（已登记于 `docs/release-checklist.md` §2.3）。

## 候选权威值（与 manifest/文档入口一致，机器核对通过）

- version `0.1.0-alpha.2`，sourceCommit `f8bb4fb0cc2a485856dc7c8d72f32ae7fff1e5de`
- schema `candidate-manifest/3`，packMethod electron-builder（reproducibleBuild=true）
- zipSha256 `68e47fd18f200621f5f12c6af7f6b9b8075cd4347545ba7ae1992e1fb0e46eaf`
- exeSha256 `c60b32d008783fed18f48c51dccae06c34ea845a14a646a1948aff57ad3f4fae`
- asarSha256 `1399191aee072d16c5f7f601a37fcce30976068b204744ee2fefd24ab1dd5d46`
- 侧车 `candidate-20260919055321-f8bb4fb-e00e50.zip.sha256.txt` 已按 MACHINE-WINDOW §3
  在上传/外发**之前**生成（产物目录内，不入库）

## 关键通过证据（第 3 轮日志内）

- `test:unit`：`strict=files=18/18 tests=321/321 failed=0`
- `test:integration`：`strict=files=15/15 tests=179/179 failed=0`
- `test:e2e`：`16 passed`
- `test:e2e:electron`：`Electron 36.9.5：38/38 通过`
- `audit`：`FAIL 0 项，WARN 0 项`
- `smoke:gui`：`SMOKE_MODE default`、`SMOKE_ARGS []`、`SMOKE_OK`、21.1s——
  默认空参数等价真实双击，这是 G1 修订的直接证据
- `dist` 后 `verify-package`：核对 30 项失败 0 项（含 `LICENSE` 白名单修复生效）

## 未包含在本证据内（仍待执行）

- A5 真实安装复验（本轮在 alpha.2 候选上**未做**，需 jc 当次授权且 OpenCode 完全退出）
- A6/T65 干净环境验证
- tag `v0.1.0-alpha.2` 与 Release 外发（等 jc 签核，A2-4）
