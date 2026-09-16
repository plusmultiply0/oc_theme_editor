# N5 分类取证与定向复测（复审 D 项）

执行时间：2026-09-16
执行基线：`bf4a68f`（A/B/C 修复之后的当前提交）
环境与版本：见 `evidence/n5-env-baseline.json`（Node v22.22.2 / vitest 3.2.7 / Electron 36.9.5 / TS 5.9.3）

## 1. 为什么不能只 grep EBUSY

历史日志（`node_modules/.cur-integration.txt`）里有 51 个失败测试、62 个错误块。
**错误块数不是失败用例数**：一个用例的业务断言失败与其 afterEach 清理失败各占一个
错误块，按错误块计数会把同一个缺陷算成两次。更危险的是反向误判 —— 只统计
「出现 EBUSY 的用例数」会把「业务断言通过、仅清理失败」与「业务断言真的失败」
混成一类，前者只是环境噪声，后者才是产品缺陷。

因此本项先把**分类口径**固化成工具，再用它取证：

```
node tools/n5-classify-integration.cjs --run
```

按用例身份（完整测试名）归并，每个用例只出一个结论：

| 类别 | 含义 |
|---|---|
| `setup` | 整文件收集/导入失败，用例没真正跑 |
| `business` | 用例体内的断言/调用失败，且无清理错误 |
| `business+cleanup` | 业务失败且同一用例还伴随清理错误 |
| `cleanup_only` | 仅有 hook/rmSync 清理错误，业务断言通过 |
| `incomplete` | pending/skipped/todo，未完成 |
| `passed` | 通过且无清理错误 |

并保留**原始错误码**（EACCES/EPERM/EBUSY/ENOENT…）：`commit.ts` 把若干错误码
统一归为 `FILE_LOCKED`，诊断不能继承这个归并 —— EACCES/EPERM 不等于「文件被锁」。

## 2. 当前提交的集成分类结果

命令（受控并发，与发布链同一组参数）：

```
node tools/n5-classify-integration.cjs --run
# 内部：vitest run tests/integration --pool=forks --maxWorkers=1 --no-file-parallelism
```

**修复前**（`evidence/n5-classification.json` 的历史版本）：

```
用例总数 179：通过 178 / 失败 1 / 未完成 0
分类：{"passed":178,"business":1}
原始错误码分布：{}          ← 本次没有任何 errno（EACCES/EPERM/EBUSY 全无）
需要关注（业务/启动/未完成）：1
仅清理失败（环境噪声）：0
```

**修复后**（`evidence/n5-classification.json` 当前版本）：

```
用例总数 179：通过 179 / 失败 0 / 未完成 0
分类：{"passed":179}
原始错误码分布：{}
需要关注：0
仅清理失败：0
numTotalTestSuites 58 / numPassedTests 179 / success true
```

**结论：本轮集成里没有出现任何文件锁类错误，且修复后全绿（179/179）。**
历史日志中的大量 `unlink EBUSY` 在本次执行中未复现，因此「清理失败掩盖业务断言」
这一担忧在本次证据下不成立，但也不能据此宣布锁问题已解决 —— 它只是本次没有发生
（见 §5 限制）。唯一那条失败项的真实性质见 §3。

## 3. 唯一失败用例：定性与归因

```
[electron-runtime.test.ts] 真实 Electron 主进程闭环（R1、R7、R8）
  AssertionError: Electron 闭环失败项：
  - 启动清理遗留准备区: cleaned=0
```

分类为 **business**（不是 cleanup_only）。这里有一个必须说明的判断：用例消息里
含「清理」二字，但它断言的是**产品启动时的清理行为**，不是测试自己的 afterEach。
分类工具最初按词面把「清理」当作清理错误的证据，因而把它误判为 `cleanup_only`
（等于把真实的产品覆盖缺失洗成环境噪声）。已收紧判据：只认 hook 归属
（afterEach/afterAll/beforeEach/beforeAll）与清理实现特征（safe-delete-shim、
夹具清理函数、rmSync / fs.unlink），不再按「清理」字面匹配。测试里补了正反两个
用例锁住这条边界（业务断言提到「清理」仍算 business；真正的 afterEach 失败仍算
cleanup_only）。

### 归因：断言依赖「同进程句柄已释放」，而 apply 的清理是故意异步的

> 这一节在取证过程中被**修正过一次**。第一版归因写成「harness 从不创建 stage
> 目录，所以断言恒假」，后续用诊断用例打出了 stage 的真实内容与 `rm` 的原始错误码，
> 证明那个说法是错的。下面是修正后的、有直接证据的归因。

Electron harness（`tools/electron-fixture-e2e.cjs`）在本次基线下的失败项来自：

```js
const cleaned = await core.recovery.cleanAllStages(runtimeRoot);
check('启动清理遗留准备区', cleaned >= 1, `cleaned=${cleaned}`);   // 旧断言
```

`cleanAllStages`（`src/core/patch/recovery.ts:118`）的计数口径是
「**确实删掉了一个存在的 stage 目录**」：

```ts
const stageDir = path.join(instancesDir, name, 'stage');
const exists = await physicalFsp.stat(stageDir).then(() => true).catch(() => false);
if (!exists) continue;          // 没有准备区 → 不计数
await cleanStage(stageDir);
cleaned += 1;
```

**证据 1：stage 目录其实是存在的，而且非空。** 在断言前插一个诊断用例，把
`layout.stageDir` 的目录树与直接 `rm` 的错误码写进结果：

```
tree=[ nested/ |   partial.asar | op-20260916T060721906Z-3i3pog/ |   app/ |
       node_modules/native/... |   out/main/... |   out/renderer/... |   package.json ]
nestedRm=ok            ← 我们自己刚造的小目录能删掉
stageRm=ERR EBUSY      ← 但整个 stage 删不掉
```

即 `stage/<opId>/app` 是**前面那次 apply 的真实遗留产物**（解包出来的应用目录），
不是「harness 没造出来」。

**证据 2：锁来自同进程。** `apply.ts:345-359` 的准备区清理是**故意异步、并且吞掉
错误**的：

```ts
/*
 * 准备区清理**不参与结果**（真机取证 2026-09-12）：递归删除上百 MB、上千个文件的
 * 准备区在部分 Windows 环境（安全软件逐文件扫描）会被阻塞几十分钟；...
 * 这里改为后台执行并吞掉错误 —— 残留的准备区由启动时
 * RecoveryService.cleanAllStages 清理。
 */
void (async () => {
  try { await physicalFsp.rm(workDir, { recursive: true, force: true }); } catch {}
})();
```

于是同一次进程运行里，asar 缓存仍持有 `stage/<opId>/app` 下的句柄，后台删除与
harness 的断言**在竞争**：断言跑得快，`rm(整个 stage)` 直接 `EBUSY`，而
`cleanAllStages` 把这个错误**按设计吞掉**（`catch { 下一次启动再试 }`）→ `cleaned=0`。
旧断言 `cleaned >= 1` 因此**恒假**，但它假的原因不是「没有 stage」，而是
「同进程里释放不掉」—— 这与产品行为无关，是断言选错了观察时机。

**证据 3：把进程隔离后，清理语义完全正确。** 用子进程扮演「下一次启动」：

```
A: 造出遗留 stage/op-LEFTOVER-from-previous-run/app/... = true
B(新进程) cleanAllStages = CLEANED=1     ← 真实场景正确
B 之后 opDir 还在吗 = false
B 之后 stage 还在吗 = false
同进程（无遗留 payload 时）cleanAllStages = 1, stage 还在 = false
```

**结论：这不是产品缺陷。** `cleanAllStages` 在它真正被调用的场景（**新进程启动**）
下行为正确；失败只出现在「同一进程刚 staging 完就立刻要求删掉」这个测试自造的
时序里。产品对此的处置（异步清理 + 启动兜底）是有意为之，且已在源码注释中记录
了真机理由。

### 处置

断言不能放宽阈值、也不能删掉，要改成**验证 `cleanAllStages` 的契约本身**，
并且避开与同进程句柄竞争：

```js
// 用一个本进程从未 staging 过的独立实例目录（因此没有残留句柄），
// 在里面造出「上一次运行遗留的 stage 产物」，然后确认：
//   1) 确实被删掉，且计数 >= 1（计数口径＝确实删掉的目录数）；
//   2) 再调一次返回 0（不会把「什么都没删」报成清理成功）。
```

第 2 条是这次改动里新增的产品语义覆盖：原断言只关心「有没有清理」，
新断言同时要求「没有可清理的东西时必须报 0」，防止清理函数退化成无脑返回 1。

修复后 harness 结果：**38/38 通过，exit 0；连续 3 次重跑均 38/38（稳定）**。

> 归因依据说明：以上结论来自**注入诊断用例打出的目录树与原始 errno**
> （`EBUSY` on `stage/<opId>/app`），以及**跨进程对照实验**（新进程 `CLEANED=1`），
> 不是靠「重跑一次好了」推断的。

## 3.1 由此产生的真实疑问（保留，未被本次证据解答）

上面证据 2 顺带暴露一个值得单独记录的边界：**如果上一次运行异常退出、留下
stage 遗留，而本次运行又恰好复用同一进程（例如应用没有真正重启）**，那么
`cleanAllStages` 的删除会因同进程句柄而 `EBUSY`，被静默吞掉。当前设计依赖
「启动时清理」，也就是依赖进程确实换过一次。这一点：
- 在正常「退出再启动」路径上成立（证据 3 已验证）；
- 但本次**没有**去验证「应用是否在所有情况下都会真正重启主进程」——
  这属于发布阻断诊断的范围，**保持未知**，不在此项下结论。

## 4. 定向复测

| 复测对象 | 命令 | 结果 |
|---|---|---|
| 格式轮换最小闭环 | `vitest run tests/integration/image-format-cycle.test.ts` | ✅ 通过（`.jfif → .png → .webp → no-op → 恢复上一主题 → 恢复首次接管`） |
| 应用/恢复最小闭环 | `vitest run tests/integration/main-recovery.test.ts` | ✅ 通过 |
| 打包完整性（真实 worker 派生） | `vitest run tests/integration/pack-integrity.test.ts` | ✅ 通过（以上三项合跑 16 passed / 3 files） |
| Electron 物理归档 | `vitest run tests/integration/electron-runtime.test.ts` | ✅ 通过（修复 harness 断言后） |
| Electron harness 直跑 | `node tools/run-electron-e2e.cjs` | ✅ 38/38，exit 0，连续 3 次稳定 |
| 全量集成（分类，修复后） | `node tools/n5-classify-integration.cjs --run` | ✅ 179/179，0 失败，0 errno |
| 跨进程清理语义 | `n5-crossproc.cjs`（新进程 `cleanAllStages`） | ✅ `CLEANED=1`，遗留被删；同进程无遗留时同样 `1` |

## 5. 限制与保持未知的部分

- 本次执行**没有观察到任何文件锁错误**（`errnoCounts` 为空）。这既不是「锁问题
  已修复」的证据，也不是「锁问题不存在」的证据 —— 只能说明在本次提交、本机、
  受控并发、项目盘临时根这组条件下未复现。评审报告里「共同问题」的说法仍成立。
- 未取得目标文件的句柄/文件系统事件（需要内核级工具或管理员权限），因此对历史
  日志里的 `unlink EBUSY` **不做持锁者归因**，保持「访问失败原因待定」。
- `EACCES` / `EPERM` 在历史日志中与 `EBUSY` 混用；本项诊断一律保留原始错误码，
  不接受把它们等价于「文件被锁」。
- 真实 OpenCode 应用→重启→恢复仍需**用户当次授权**，本项未执行。
