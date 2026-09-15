# 初始证据

- 当前40b2cfe，0.1.0-alpha.1；A1–A3已实现，候选后又经历手工重封。
- 最新记录推荐win-unpacked.new及zip，但package输出根未区分重封前后，待核对默认校验行为。
- A5仅前置只读准备，未完成真实闭环；A6用户决定跳过，不能声称干净环境验证。
- alpha-acceptance的摘要、A7条目数、A8状态仍混有旧结果，需与实际候选核对。
- git status无变更，用户级ignore读取权限告警，不视为业务缺陷。
- 默认verify-package检查旧win-unpacked：30项2失败（unpacked缺7条、sharp加载失败）。显式指定win-unpacked.new：30项0失败。
- release-gate.sh的dist脱离run函数，打印退出码后继续，存在失败后ALL_GREEN风险。
- cleanOrphanCaches保留imageId但缩略图使用不同thumbnailId；previewDataUrl已有thumbnailPath但文件缺失时直接失败，没有fallback。
- readBytes先fs.readFile整个副本再校验大小/hash，未复用受限读取；probeImageBytes/thumbnail解码也未传产品40MP上限。
