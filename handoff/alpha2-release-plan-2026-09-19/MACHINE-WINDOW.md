# Alpha.2 换机窗口执行清单（A2-2 + A2-3）

> **2026-09-19 状态：换机已取消，本清单未被使用。**「本机 G1 结构性阻塞、不得跑发布链」
> 的前提被实证推翻：崩溃仅发生在 **agent 自动化会话**；jc 在**本机桌面 cmd 会话**手动执行
> `npm run release:build` 已产出 `ALL_GREEN buildId=20260919055321-f8bb4fb-e00e50`
> （空参数 `smoke:gui` 真过）。A2-2 关闭，证据见 `handoff/alpha2-release-evidence/`、
> 结论修订见 `docs/acceptance.md` §8.1。下文保留：若将来需要真·换机（如 A6 干净环境）
> 仍照单执行；侧车脚本（§3）与 doc 入口命令（§4）已在本机实测有效。

> 用途：在**有显示会话的 Windows 机器**上照单执行，全程不需要回头翻 PLAN 与旧文档。
> 前提：本机（开发机，G1 结构性阻塞）**不得**跑本清单第 2 步的发布链。
> 基线提交：`684895f`（origin/main，含 A2-1 的 `f37b10c`）。执行中若仓库有新提交，以实际 HEAD 为准并登记。
> 命令口径：本文所有 shell 命令按 **Git Bash** 书写；改用 PowerShell/cmd 时逐条换算，不要整段照抄。

## 0. 机器要求（开始前逐项确认）

- [ ] Windows x64，**交互式登录会话可见桌面**（`smoke:gui` 空参数真过的唯一硬条件）；
- [ ] Node ≥ 22（`node -v` 核实）；npm 可联网或本地缓存齐备（`npm ci` 需要）；
- [ ] 磁盘富余 ≥ 4 GB（win-unpacked 约 325 MB + zip + 冗余）；
- [ ] OpenCode Desktop 1.18.29 用户级安装**仅 A2-3 需要**；A2-2 纯构建不需要真机目标。

## 1. 同步仓库到基线

任选其一：

```bash
# A) 目标机能访问私有仓库
git clone https://github.com/plusmultiply0/oc_theme_editor.git
cd oc_theme_editor && git checkout 684895f

# B) 不能访问：在开发机导出受管文件（不含 node_modules/out/release*，git archive 只导受管内容）
git archive --format=tar 684895f -o ots-alpha2-src.tar   # 拷到目标机后 tar -xf 解包
```

然后：

```bash
npm ci
npm run build
```

## 2. 发布链（一条命令，含登记与核验）

```bash
npm run release:build
```

- 内建 12 项发布事实（typecheck → lint → unit → integration → build → e2e →
  e2e:electron → audit → dist → **smoke:gui（空参数）** → verify-package → zip），
  随后自动 `register` + `verify:release` + 写 `release-receipt/1`。
- **禁止参数**：`--skip-gui`、`--skip-e2e`、`--strict` 之外的任何诊断开关、
  `OTS_STEP_STUB` 等环境变量——一个都不加。
- 输出落 `candidate-<buildId>/`（登记与证据）与根目录 `candidate-<buildId>.zip`。

**验收判据（全部要真实看到）**：
1. 最后一行 `ALL_GREEN buildId=<buildId>`（仅此一次，非 0 退出不会打印）；
2. manifest `publishable=true`；
3. `verify:release` 终检退出 0。

## 3. zip 侧车哈希（**先生成，后谈分发**，不重蹈 alpha.1）

```bash
B=<buildId>
node -e "const c=require('crypto'),f=require('fs'),p=require('path');\
const b='candidate-'+process.argv[1];\
const zip='candidate-'+process.argv[1]+'.zip';\
const exe=p.join(b,'win-unpacked','OpenCodeThemeSwitcher.exe');\
const asar=p.join(b,'win-unpacked','resources','app.asar');\
const h=(x)=>c.createHash('sha256').update(f.readFileSync(x)).digest('hex');\
const m=[];for(const x of [exe,asar,zip]){const s=f.statSync(x);\
m.push(h(x)+'  '+p.basename(x)+'  ('+s.size+' bytes)');}\
fs.writeFileSync(zip+'.sha256.txt',m.join('\n')+'\n');console.log(m.join('\n'))" $B
```

- 产物：`candidate-<buildId>.zip.sha256.txt`（exe / app.asar / zip 三行，与 alpha.1 格式一致）；
- 若脚本因路径不存在报错（布局与上述不符时），以 `release:build`
  结束行打印的 zip/exe 实际路径为准，用 `certutil -hashfile <文件> SHA256` 逐条核对后手写同一格式；
- **该文件与 zip 一同分发，不在 zip 内**；gitignore 已排除，无需提交。

## 4. 文档入口更新（哈希只维护一处）

```bash
# 1) 打印规范块
node tools/doc-candidate-entry.cjs --manifest candidate-<buildId>/candidate-manifest.json
# 2) 用打印结果整体替换 docs/release-checklist.md §1 的 CURRENT-CANDIDATE:BEGIN/END 块
#    （§1 标题、产物表、第 3 节门禁表同步换成本轮 buildId 的数字）
# 3) 机器核对
node tools/doc-candidate-entry.cjs --manifest candidate-<buildId>/candidate-manifest.json --check
```

**验收**：`--check` 打印 `DOC_ENTRY_OK`（文档块 / manifest / 磁盘实算三方一致）。
**提交一个**：`chore(release): alpha.2 候选 <buildId> 登记`（连同 release-checklist 更新；
证据归档 `handoff/alpha2-release-evidence/`：`ALL_GREEN` 输出、`verify:release` 结果、
manifest 摘要、侧车内容）。

## 5. 失败处置（红线）

- `smoke:gui` 在目标机也崩 → **停**。归档 stdout/stderr 与该机 GPU/会话信息回读判环境；
  **不得**降级 `--skip-gui` 出「可发布」产物——skip-gui 产物永远不可发布。
- 任一步非 0 → 链会停在当场（不续跑），保留原始退出码与日志，按步骤名登记，不重跑刷绿。
- 未到 `ALL_GREEN`：不登记、不改文档入口、不 tag、不上传。

## 6. A2-3（与 A2-2 同窗口，需 jc 当次授权）

**A5 快速复验**（重点看新 UI 在真机的渲染）：
1. [jc 已保存工作] 完全退出 OpenCode（含托盘进程）；
2. 正常启动换肤助手（本轮 win-unpacked 产物）→ 导入图片 → 应用；
3. 完全退出并重启 OpenCode → 逐页视觉检查：首页 / 会话 / 侧栏 / **输入区** /
   **拖放区** / **滑杆（自定义样式）** / 菜单 / 弹层；
4. 恢复（上一主题 + 首次接管两条都走一遍）→ 再重启确认回到接管前。

**T65 干净环境 probe**（只读，随时可做）：

```bash
node tools/version-probe.cjs --discover --json
```

**验收**：A5 取证到 `handoff/alpha2-release-evidence/a5-round-<date>.md`（不预填结论）；
probe 报告归档。**提交一个**：`docs(acceptance): alpha.2 A5 复验证据 + T65 干净环境记录`。

## 7. 收尾（回传开发机）

- 目标机若可直接推：`git push origin main`；否则 `git format-patch` 回传后由开发机代推
  （GitHub 外发口径仍按 jc 约定）。
- A2-4（tag + Release 三件套 + 9.5 落账）等 jc 签核后执行，届时用第 3 步已生成的
  `.zip.sha256.txt`，不再补做。
