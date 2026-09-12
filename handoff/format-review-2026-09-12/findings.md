# 初始发现

- CHANGELOG 声明上一轮 F1–F4 已修复，并在真机归档完成 A→B→A；明确未完成真实窗口 DOM/截图验收。
- 当前 package 构建输出已经有 release6，需要核对实际包与源码。
- 原生图片选择器与 ImageStore 白名单仅 png/jpg/jpeg/webp；未列 jfif。
- validate.ts 内容格式只接受 png/jpeg/webp。
- git status 无变更条目，但读取用户级 git ignore 有权限告警；不把告警当成项目错误。
- 实测：typecheck 退出0；当前 release6 包校验28项全过；真实安装只读深核验15项全过（1293脚本已解析，2776不支持的脚本解析不能视作通过）。
- 当前安装归档 072a92856daff8d84c32b7e4e0b540df7899eaabce34d2f8db6f3e270a64572f，图片 b89f8f8d83b98a1a078169745d61908a93590d1cfbbed515b2a6fd232d36afb5。
- 图片完整解码为PNG 691×591，却保存在 oc-theme-background.jpg；目前未做统一格式转换。
- sharp0.35.4声明JPEG扩展名 .jpg/.jpeg/.jpe/.jfif；合成jpeg/png/webp均通过 analyzeImage。
- 同一JPEG buffer经 .jfif/.JFIF导入被入口拒绝；GIF/TIFF/AVIF合成图可由sharp解码，但被 analyzeImage 的格式白名单拒绝。
- verify-real-install 的“图片可解码”仅检查首字节/PNG片段，不能替代真正decode；本轮另行完整解码成功。
