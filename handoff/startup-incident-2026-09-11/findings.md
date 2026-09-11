# 取证

- 错误截图是主进程 JavaScript 解析失败，非 renderer CSS 错误。
- 当前 stage.ts 在重打包前比较解包目录哈希，重打包后仅核对条目名和 unpacked 集合，没有比较归档内所有不可变文件字节。
- archive-io.ts insideWindow 对返回 Promise 的 fn 未 await 就 finally 恢复 process.noAsar，异步窗口存在缺陷；是否为这次文件损坏直接原因待独立复现。
- 新工具 fixture 的主进程只写 console.log(1)，没有验证大型 JS 的字节完整性和真实启动。
- 当前 jsonfile/index.js 与 11:10 previous 备份相同，2014 字节/103 行，终止在 catch 块内部；02:15 previous 的同路径为完整 2014 字节/89 行，语法通过。
- 当前与 11:10 previous 仅三个主题资源内容不同；与 02:15 previous 额外有 jsonfile/index.js、semver/range.bnf 两项非主题内容不同。不能用最新 previous 恢复本次启动错误。
- 已安装 @electron/asar 4.3.0 的 Filesystem.insertFile 小文件快路径读取相对 cwd 的 p，而 createPackageFromStreams 传入逻辑归档路径；若 cwd 恰好有同路径 node_modules，会用另一份文件计算完整性/去重。正在用独立两文件 fixture 复现。
- 两文件 fixture 已复现：stream a=AAA、b=BBB，但 cwd 同名文件相同，打包后 b 读成 AAA，两条目 offset=0。
- 实际较新备份中的 nested jsonfile（2838 字节）与 top-level jsonfile（2014 字节）共享 offset 53281426 / integrity hash，截断直接成因已确认。
- 较早 02:15 previous 的 packed 完整性均通过，jsonfile 语法通过；外部 unpacked OpenConsole.exe 存在一处先前 hash 差异，恢复后终端需人工验证，本轮不修改该实体。
- 诊断初版曾用 CJS 包装解析 ESM 主入口导致 import 报错；已移除该不适用检查。主入口三包字节完全一致，最终证据只对 jsonfile 做无执行语法解析。
