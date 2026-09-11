# 审查发现

- 用户截图：预览侧栏呈低对比灰色文字；应用按钮禁用，文案无已验证目标。
- 项目真实路径为单目录 OpenCode_Theme_Switcher，内部存在旧原型目录 OpenCode/_Theme/_Switcher。
- App.tsx 展示单目标，没有发现目标选择/手动定位入口；按钮取决于 support === supported。
- npm test:e2e 配置 --pass-with-no-tests，需要检查实际 E2E 数量。
- 初步观察 reducedTransparency 仅为 React 状态，需要追踪是否传到生成与应用。
- 以上为源码初查，尚未运行新产品或操作用户安装。
- 已确认 Preview.tsx 28 的 surface alpha 比 spec.panelOpacity 少 0.06；styles.css 383 设置文字 opacity 0.6；报告只按单点 panel 合成计算，不含这些效果。
- css.ts 50–60 将 panel 合成为 HEX 实底，136 应用不透明色，预览采用 RGBA；reducedTransparency 未进入 ThemeSpec/后端。
- 发现 Electron ASAR 虚拟目录语义疑点：discover.ts 302 的 stat.isFile 检查及 asar.ts 45 相同检查与 Electron FS 包装可能冲突；官方文档确认存在虚拟目录行为，正在只读复现。
- apply.ts 163 只检查自有 CSS 判断 alreadyPatched；backup.ts 172 pristine 取反。历史验收记录明确首次安装已含 snow-theme.css，因此无法据此证明原版。
- E2E 目录只有 README，验收明示零用例；真实流程只有一次 CLI 应用，后续观察/换主题/恢复未完成。
