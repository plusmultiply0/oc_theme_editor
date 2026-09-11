# 已确认事实

- 最新 applied 事务：op-20260911T223541015Z-xpbuz9，主题 314827.jpg，遮罩 .59、面板 .31。
- 当前 app.asar SHA256：4c697b25348617d11bd46fdb38df3f420bc63bc453377b7ca3f8253bc417e969，与 afterHash 一致。
- HTML 已加载 oc-theme-custom.css，图片 oc-theme-background.jpg 存在，JPEG 4106×2310、4,947,909 字节。
- 官方 ensureThemeStyleElement 将 style#oc-theme 追加到 head；applyThemeCss 写入 :root 变量。这发生在静态 link 之后。
- 助手 css.ts 依赖“head 最后加载”的前提不成立；动态官方变量可覆盖自定义半透明变量。
- 官方大面积根布局使用 bg-v2-background-bg-deep；助手对该 token 设置 .6 alpha，额外削弱背景。
- stronger 被设为 HEX 实色，隔离夹具在提高选择器优先级后该正文依然完全挡图。
- html:root + 半透明 stronger + 限定外壳透明，夹具中背景恢复；再插入官方 :root 仍保持。
- injectLink 本机连续三次结果：1269→1267→1267→1267，后两次 HTML 不变。stage 要求 touched 包含 HTML 的条件不合理。
- 预览将累计气泡 alpha 再叠在面板上，p=.31 时实际累计 .671491，模型却用 .5239。

尚未读取正在运行的真实窗口 DOM；隔离夹具不能代替完整真机验收。
