# 发现

- P1、P2、P3已有实现提交；当前P4记录为集成测试并行假失败/onTaskUpdate超时。尚需复核，不能将提交标题当结论。
- 原串行日志仅7/15文件、84项（历史全量172），存在8文件未完成/未汇总；不能证明16失败全部假失败。EPERM只能确认访问被拒，尚无具体锁持有进程证据。
- candidate-manifest.cjs使用let ROOT，applyRoot会更新ROOT；原诊断把cwd:ROOT判成宿主仓库是误读，需实际夹具核对主题。
- Vitest本机3.2.7，onTaskUpdate是任务更新RPC，非独立心跳；测试夹具大量同步spawn/exec会阻塞worker事件循环，需异步化和定量诊断而不是仅延长超时。
- 新编排器提供skip-e2e/skip-gui，缺步骤仍会写构建记录并打印ALL_GREEN；verify-release只查记录hash，未检查必需步骤完成。需发布/开发状态分离。
- smoke-packaged依赖npx tsx，但package依赖与本地node_modules无tsx，运行可触发未锁定网络下载；只看标题/文本且吞innerText错误，UI空白可能也SMOKE_OK。
- 实测candidate单worker14/14通过，exit0，42.64秒；完整单fork受控并发15/15文件172/172断言通过，仍1个onTaskUpdate，exit1，100.59秒，其中candidate套件72.372秒。并发限额并不足以单独修复。
- 本机RPC依赖DEFAULT_TIMEOUT=6e4（60秒），fork RPC未覆盖该值。同步夹具连续阻塞与超时高度相关，但没有事件循环采样证明唯一根因，报告将保留此边界。
- 读取本轮夹具manifest与git log：主题均fixture init，SHA004d1f3ca95d9b383eae242d7c9880773ebb181d相同；原cwd:ROOT误判已被实际反证。
- 本轮probe-smoke隔离mock：空body及innerText抛错两场景均exit0/SMOKE_OK，无真实Electron启动。
