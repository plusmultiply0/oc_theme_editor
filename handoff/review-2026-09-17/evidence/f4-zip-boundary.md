# F4：ZIP 结构边界与隐式目录冲突取证

日期：2026-09-17
源码基线：`8b3b8f8` + 本轮前两项提交（`8a3a358` F1、`0631dbd` F2/F3）。
本轮只改 `tools/verify-release.cjs`（共享 ZIP 解析器）与其单测，**不动应用业务层**。

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 三个负例（改动前） | ❌ **全部 `0 problems`** —— 静默放过 |
| 三个负例（改动后） | ✅ 全部拒绝，且给出可诊断原因 |
| 真实候选 zip（`1df4c697…`） | ✅ `parseZip` / `deepVerifyZip` / `checkZipMatchesDir` **均 0 问题** |
| 正例（合法 zip） | ✅ 显式目录 / 隐式目录 / 反斜杠目录 / store / DEFLATE / 空文件 / 合法描述符 / EOCD 注释 全部通过 |
| 新增单测 | `tests/unit/zip-structure-boundary.test.ts` **20/20 通过** |
| 全量单测 | **313 passed / 17 files** |
| typecheck / lint / audit | 退出 0 / 0 / 0（FAIL 0 WARN 0） |

**边界（不夸大）**：最后一条（隐式父目录大小写冲突）只证明 deep 校验的缺口，
不代表 Windows 目录比较或整个发布门禁会通过 —— Windows 普通目录根本无法同时
合法保存 `a` 与 `A/file.txt`。**当前真实候选已通过只读校验，没有证据表明它包含
这些畸形结构**；这里没有解压写磁盘，**不能**说成「已证实的任意文件写入漏洞」。

## 1. 改动前的实测（A/B 对照）

用 `git show HEAD:tools/verify-release.cjs` 取出改动前的版本，与当前工作树
在**同一批夹具**上对跑：

```
=== 改动前（HEAD 版本）===
  [负例1 commentLen=65535]   parseZip 问题=0              deepVerifyZip 问题=0
  [负例2 缺 data descriptor] parseZip 问题=0              deepVerifyZip 问题=0
  [负例3 a 与 A/file.txt]    parseZip 问题=0              deepVerifyZip 问题=0
=== 改动后（当前工作树）===
  [负例1 commentLen=65535]   parseZip = THROW 中央目录第 1 项的变长字段（name/extra/comment）
                             越出中央目录范围（需要 65586 字节，剩余 51）      deepVerifyZip 问题=1
  [负例2 缺 data descriptor] parseZip 问题=1                                       deepVerifyZip 问题=1
  [负例3 a 与 A/file.txt]    parseZip 问题=1                                       deepVerifyZip 问题=1
```

即：这三个构造输入在改动前**同时骗过**了解析器与深度校验，
与复审报告 §F4 的表格一致。

## 2. 三处缺口与修法

### 2.1 EOCD 与中央目录的边界（负例一）

旧实现从 EOCD 只取 `count` 与 `cdOffset` 就直接开始遍历，逐项
`off += 46 + nameLen + extraLen + commentLen`，**从不检查**：

- EOCD 的磁盘号 / 本盘条目数 / 中央目录长度与范围是否自洽；
- 每项的 `name/extra/comment` 变长字段是否仍落在中央目录范围内；
- 遍历结束位置是否等于 `cdOffset + cdSize`。

于是最后一项声明 `commentLen=65535` 而实际没有注释时，遍历会越出中央目录
继续读后续字节，两个检查都「无问题」。

现在（`parseZip` 结构性错误 → 抛错，两个对外检查一律失败关闭）：

- 拒绝分卷（`disk` / `cdStartDisk` 非 0）；
- 校验 `entriesThisDisk === count`；
- 校验 `cdOffset + cdSize <= buf.length` 且 `<= eocd`（中央目录不得与 EOCD 重叠）；
- 校验 `eocd + 22 + commentLen <= buf.length`（EOCD 注释长度与实际一致）；
- 每项校验 `off + 46 + nameLen + extraLen + commentLen <= cdEnd`；
- **ZIP64 定位器**（`0x07064b50`，紧邻 EOCD 之前）显式拒绝，不再当下标读完；
- 遍历结束必须 `off === cdEnd`。

### 2.2 data descriptor（负例二）

旧实现只做了「bit 3 时不比较本地 CRC/大小」——**跳过**之后没有任何东西再核这段数据，
于是「声明了描述符但根本没写」也能通过。

现在新增 `checkDataDescriptor()`：描述符必须存在、落在文件内、且三个字段
（CRC / 压缩大小 / 解压大小）与中央目录一致。兼容两种合法形式——
有签名（`0x08074b50` + 12 字节）与无签名（12 字节）——两种都试，任一对得上即通过
（避免 CRC 恰好等于签名值时误判）。

> 注意没有倒退成「逐字比较所有本地字段」：bit 3 时本地零占位仍然合法、仍然不比。

### 2.3 隐式父目录的大小写冲突（负例三）

旧实现用**区分大小写**的 `Set` 比较文件路径与（显式目录 ∪ 文件路径隐含的父目录）：

```js
if (allDirs.has(k)) problems.push('…既是文件又是目录…');   // 'a' vs 'A' 判不出来
```

现在统一用 **Windows 冲突键（小写）** 比较，并把结论分成两种说法：

- `asDir === k` → 「同名条目既是文件又是目录」；
- `asDir !== k` → 「文件与目录大小写别名冲突」（如 文件 `a` / 目录 `A`）。

### 2.4 附带修掉：目录条目的异常元信息不再被略过

旧实现 `if (norm.isDir) continue;` 让**目录条目整段跳过**加密位 / 压缩方法 / ZIP64 检查。
异常元信息挂在目录条目上就查不出来。现在这些检查对所有条目生效；
只有 CRC/大小比较仍按「是否目录」区分（那里字段本身不适用）。

## 3. 正例：加严不能误伤合法 zip

新增用例显式保留这批正例，避免「加严」变成「把所有 zip 都拒掉」：

| 正例 | 结果 |
|---|---|
| 显式目录 + store + DEFLATE + 空普通文件 | 三项检查全过 |
| 隐式目录（只用文件条目表达父目录） | 通过（不要求磁盘每个目录都显式出现） |
| 反斜杠分隔的目录条目（PowerShell `Compress-Archive` 形态） | 仍识别为目录 |
| 合法 data descriptor（有签名形式） | 通过 |
| 合法 data descriptor（无签名形式） | 通过（兼容两种写法） |
| EOCD 带注释且 `commentLen` 与实际一致 | 通过 |
| 互不冲突的普通多级路径 | 通过（大小写检查不过宽） |

## 4. 真实候选未受影响（回归确认）

```
candidate-20260916114818-8b3b8f8-f4e1c6.zip
  parseZip            problems = 0     （82 条目，其中显式目录 3 个）
  deepVerifyZip       problems = 0
  checkZipMatchesDir  problems = 0     （对 candidate-…/win-unpacked）
  readZipCentral      条目 = 79
  zip 内 dataDescriptor 条目 = 0
显式目录 = ["resources/app.asar.unpacked",
            "resources/app.asar.unpacked/node_modules",
            "resources/app.asar.unpacked/node_modules/@img"]
```

只读发布核验 `verify:release --require-release-eligibility` 在**加严后**的结果：
18 项中**只剩 2 项绑定类失败**，且都是**预期的、正确的**：

```
[FAIL] 显式目标与登记绑定一致 | manifest.sourceCommit=8b3b8f88f91d ≠ 当前 HEAD 0631dbdcdfd7
[FAIL] 源码冻结 | 工作树已跟踪文件存在未提交改动（1 项）：M tools/verify-release.cjs
```

这两条正是「构建身份交叉校验 + 源码冻结」该有的行为：本轮改了工具但尚未提交，
且候选登记的是 `8b3b8f8`。**未**为了让它变绿而改登记、改 sourceCommit 或跳过检查。
zip 结构相关的检查在本次运行中全部通过。

## 5. 未做

- 未重写门禁架构，未为测试破坏真实候选 ZIP，未解压到磁盘；
- 未把「畸形 ZIP」夸大为「已证实的任意文件写入漏洞」；
- 未改应用业务代码，未放宽任何判据，未重打包。
