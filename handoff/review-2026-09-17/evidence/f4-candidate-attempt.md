# 新候选构建尝试（§5 第 4 项）：两次受阻，均非代码问题

日期：2026-09-18
源码：`b43dc44`（F1 `8a3a358` + F2/F3 `0631dbd` + F4 `b43dc44` 全部已提交，工作树已冻结）

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 发布链第 1 次（`20260917085913-b43dc44-41e0c8`） | typecheck/lint/unit **313** 通过 → ❌ 停在 `test:integration` |
| 停因 1 | **safe-delete 护栏耗尽**（环境，轮次级），非测试失败 |
| 发布链第 2 次（`20260918013040-b43dc44-a0a453`） | unit **313** / build / integration **179** / e2e **16** / e2e:electron 全 OK / audit / dist **全过** → ❌ 停在 `smoke:gui` |
| 停因 2 | **当前会话没有可用的独立 GPU 进程**（环境），非包缺陷 |
| 新候选 | `candidate-20260918013040-b43dc44-a0a453/`（已产出 `win-unpacked`，**未**打包 zip、**未**登记） |
| `ALL_GREEN` | **未产出** |
| 回写旧记录 | **没有**（不回写、不冒充） |

## 1. 发布链第 2 次的实际进度（这是本轮最有价值的一段）

```
RELEASE_BUILD buildId=20260918013040-b43dc44-a0a453
EXIT typecheck        = 0 (10.6s)
EXIT lint             = 0 (18.0s)
EXIT test:unit        = 0 (14.6s)    files=17/17  tests=313/313  failed=0
EXIT build            = 0 (24.9s)
EXIT test:integration = 0 (173.8s)   files=15/15  tests=179/179  failed=0
EXIT test:e2e         = 0 (42.4s)    16/16
EXIT test:e2e:electron= 0 (8.9s)     全部 [OK]（含 D 项三条准备区清理断言）
EXIT audit            = 0 (8.0s)     FAIL 0 / WARN 0
EXIT dist             = 0 (130.8s)
EXIT smoke:gui        = 1 (20.0s)    SMOKE_FAIL: Target crashed
STOPPED at smoke:gui
```

**注意**：`test:integration = 0`、`test:e2e = 0` 是本轮改动后**首次**在同一 buildId 下跑通的
完整测试链。上一轮（E 项）卡在 e2e 间歇失败，这一轮 16/16 通过。

## 2. 停因 1：safe-delete 护栏（环境）

`test:integration` 报 91 项失败，错误原文：

```
Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
  {"count":305,"threshold":300,"scope":"turn","targets":["C:\\Users\\ylzho\\AppData\\Local\\Temp\\ots-rtmp\\ots-install-RuiNY3"],"targetCount":1}
```

这是 WorkBuddy CLI 的删除护栏（测试清理自己的临时目录时累计计数超阈值），
**发生在测试的 afterEach/afterAll 清理阶段**，不是断言失败。

**判定为环境、非本改动回归的三条证据**：

1. 同一提交、同一 `OTS_TEST_TMP` 下，`tests/integration/transaction.test.ts`
   单独跑 **29/29 通过**（该文件正是链上失败的文件之一）；
2. 换临时根到**系统 Temp 根**（`C:/Users/ylzho/AppData/Local/Temp`）仍然触发，
   且计数**恒为 305/304**（与 `ots-rtmp` 时完全相同）→ 与临时根位置无关；
3. 下一轮（新对话轮次）用**完全相同**的命令跑整套集成 → **179/179 通过，exit 0**。

→ 护栏计数是**轮次级**的，同一轮里前面的命令已把预算用掉，之后任何大规模删除都会失败。

## 3. 停因 2：当前会话没有可用的独立 GPU 进程（环境）

`smoke:gui` 报 `SMOKE_FAIL: Target crashed`。逐层定位：

### 3.1 直接 spawn 两个候选（不经 Playwright）

| 候选 | 结果 |
|---|---|
| 新 `candidate-20260918013040-b43dc44-a0a453` | ❌ `exit=2147483651` |
| 旧 `candidate-20260916114818-8b3b8f8-f4e1c6` | ❌ `exit=2147483651` |

两者的 stderr 完全相同：

```
ERROR:content\browser\gpu\gpu_process_host.cc:956] GPU process exited unexpectedly: exit_code=1
（重复约 9 次）
FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:416] GPU process isn't usable. Goodbye.
```

**新旧候选行为一致** → 不是新包坏了，是这台机器当前的会话起不了独立 GPU 进程。

> 自我更正：中途我用 Playwright 做过一次「新候选崩、旧候选过」的 A/B，一度怀疑新包坏了。
> 直接 spawn 后证明**两者同样崩**，那次「旧候选过」是时序侥幸。结论已按此更正。

### 3.2 参数矩阵（同一候选，直接 spawn，观察 7 秒是否存活）

| 启动参数 | 存活 | GPU FATAL |
|---|---|---|
| **空参数（双击等价）** | ❌ | 是 |
| **仅 GPU workaround**（`--disable-gpu --disable-gpu-compositing --disable-software-rasterizer --disable-dev-shm-usage`）——**即 F2 改动前的旧默认** | ❌ | 是 |
| 仅 `--in-process-gpu` | ✅ | 否 |
| `--in-process-gpu --disable-gpu` | ✅ | 否 |
| 全诊断（含 `--no-sandbox`） | ✅ | 否 |

**两条关键结论**：

1. **旧默认参数现在也崩溃** → 这条链**无论 F2 改不改**都会停在 `smoke:gui`。
   F2 不是本次阻断的原因。
2. 只有把 GPU 拉进主进程（`--in-process-gpu`）才能在本会话起窗口。

## 4. 与 F2 要求的关系（为什么**不**刷绿）

复审 F2 明确要求：

> 正式产品启动冒烟默认不加 GPU workaround（应用自有 args 为空）；
> 若正常环境不可用，标注「未验证」，不要降级后刷绿。

本机的现实正是「正常环境不可用」。因此正确行为就是**如实失败**，
而不是把 `--in-process-gpu` 塞回默认参数让链变绿——那样做会把
「关闭/降级渲染路径后能起窗口」重新当成「用户默认环境可启动」的证据，
也就是 F2 要修掉的那个错误。

F2 的机制在这种情况下表现符合预期：

- `smoke:gui` **exit 1**，未打印 `SMOKE_OK`；
- `--diagnostic-gpu` / `--diagnostic-degraded` 只作诊断，且**不构成发布资格**（退出码非 0），
  不会污染发布结论。

## 5. 因此本轮的准确边界

| 层 | 状态 |
|---|---|
| F1 文档/机器核对 | ✅ 已提交，`--check` 退出 0，单测覆盖 |
| F2/F3 冒烟工具 | ✅ 已提交，夹具 4/4，单测 31/31；**真实 GUI 正常配置在本机「未验证」** |
| F4 ZIP 边界 | ✅ 已提交，A/B 对照坐实三处缺口；真实候选加严后仍 0 问题 |
| 全量单元 | ✅ **313/313** |
| 全量集成 | ✅ **179/179**（本轮独立复跑 + 链上各一次） |
| e2e / e2e:electron | ✅ **16/16** + 全部 `[OK]` |
| audit / dist | ✅ 通过 |
| **smoke:gui（正常配置）** | ❌ **本机环境下不可用 → 标记「未验证」** |
| 新候选登记 / 回执 / 发布核验 | ⛔ 未执行（链在 smoke:gui 即停） |
| 真实安装闭环 | ⛔ 需用户当次授权，未执行 |

**未做**：未改产品代码、未放宽判据、未为凑绿回填 workaround、未回写旧候选记录、
未把旧候选的 green 套给新构建。

## 6. 待用户决策

1. **GUI 正常配置的验收怎么处理**（推荐其一）：
   - 等会话恢复（有可用 GPU/显示会话）时再跑 `smoke:gui`，之后重跑发布链生成候选；或
   - 认可「本机正常配置不可验证」，把该项如实登记为**未验证的环境限制**
     （需在分发说明里写明；不得声称已在默认环境验收）。
2. **本机是否需要 `--in-process-gpu`** 作为**已文档化的环境前提**（而非产品修复）
   —— 若要，应写进 `docs/acceptance.md` 的「本机环境注意事项」，且**不得**进入默认参数。
3. 是否授权我继续跑完剩余链步骤（zip 打包 → register → verify:release）。

> 无论选哪条，`ALL_GREEN` 都只能由链在真实通过后输出一次；
> 现在没有产出，也不应人为补上。
