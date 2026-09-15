# 证据记录

- R1–R6 均已有独立修复提交，必须按当前代码复审，不复用旧结论。
- 工作树已有上轮未跟踪 handoff/review-2026-09-13，保留不动。
- typecheck=2（3条错误），lint=1（2条错误），均来自新诊断测试文件。
- 默认 verify:package=0，37项全过；候选源提交871703d，归档缺少当前 ImageStore 的 keepContentIds/readThumbnail。只抽查三个入口产物无法证明最新源码入包。
- 当前源码内存转译复现：清理暂停在 readdir，再完成新导入后继续清理，删除副本及缩略图2个，readBytes=IMAGE_CONTENT_MISMATCH。
- 当前源码复现：缩略图截到16字节，预览success=true但图片解码失败，健康私有副本未用于恢复。
- r5-run-suite真实脚本注入子进程status=23（屏蔽旧证据写入），外层仍status=0。
- dist失败17的隔离mock验证：整体17、STOPPED、不出现ALL_GREEN；旧R1已修复。
- test-release-gate.cjs第48行直接覆盖共享/tmp/a4-gate.txt；未执行原始脚本，避免破坏历史证据。
- D盘项目专用临时目录，全量单元/集成23文件295测试通过，16.48秒。C盘本轮专用目录同套测试64失败/231通过，主要FILE_LOCKED/EPERM，属于路径相关环境干扰证据，不能直接当成64个产品缺陷。
