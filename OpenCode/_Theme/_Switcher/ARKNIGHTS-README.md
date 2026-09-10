# OpenCode 明日方舟暖金主题

使用 `OPENCODE_THEME_IMAGE` 指定的原图，暖金按钮、奶油白文字、深棕灰半透明面板与少量青绿色辅助色。保留之前布局和功能，错误/警告/成功及代码差异颜色不变。

当前适配本机 OpenCode Desktop 1.18.29。此为非官方本地资源定制，更新可能覆盖；不要把旧资源包覆盖到新版本。

## 查看效果

正常启动 OpenCode。图片用 cover 居中铺满，窗口比例不同时边缘会裁切；遮罩保证文字可读。资源校验不代表实际界面视觉检查，有遮挡或过暗可提供截图再微调。

## 恢复到上一版雪景主题

先保存任务并完全退出 OpenCode，在 PowerShell 或 CMD 执行：

```powershell
node "arknights-tool.cjs" restore
```

恢复入口会检查进程、当前资源哈希及备份哈希；软件已更新或资源另被修改时拒绝覆盖。

## 恢复最初无壁纸的原版

先完全退出 OpenCode，再执行：

```powershell
node "theme-tool.cjs" restore
```

两个恢复命令按需求选择一个，不必连续执行。备份位置与哈希见 `arknights-manifest.json`、`backup-manifest.json`。原始图片、OpenCode.exe、用户设置、API 配置、聊天记录均不改动。

## 检查范围

仅替换归档内 `out/renderer/snow-theme.css` 和 `out/renderer/snow-background.jpg`；沿用旧资源名避免重复插入样式。其余 6,991 个条目的字节和元数据保持一致。独立 Electron 原生读取验证通过。具体颜色与指定组合的对比度记录见 `arknights-palette.json`，实际桌面视觉仍需重开查看。
