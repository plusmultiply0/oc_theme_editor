# OpenCode 雪景蓝灰背景

适配本机 OpenCode Desktop 1.18.29，使用原始雪景图片，蓝灰主色来自图中：`#404558`、`#787e9f`、`#a0a7c9`、`#abb1d0`。

聊天区半透明，输入框、代码区、弹出菜单采用较实的底色以保证可读性。未更改字体、快捷键、API 配置、聊天记录或安全设置。

## 路径配置

脚本不硬编码任何本机路径，全部按环境变量解析：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENCODE_APP_DIR` | `%LOCALAPPDATA%\Programs\@opencode-aidesktop` | OpenCode 安装目录 |
| `OPENCODE_THEME_IMAGE` | 无，必填 | 壁纸原图路径，仅 `apply`/`update` 需要 |
| `ASAR_STAGE` | `%USERPROFILE%\.codex\skills\image-theme-styler\scripts\asar_stage.cjs` | asar 打包依赖脚本 |

```powershell
$env:OPENCODE_THEME_IMAGE = "$env:USERPROFILE\Pictures\wallpaper.jpg"
node "theme-tool.cjs" apply
```

`restore` 不需要图片。

## 查看效果

完全退出后重新打开 OpenCode。此定制覆盖内置主题的基础界面颜色；要恢复内置主题，请先撤回补丁。

## 恢复原样

先保存任务并退出 OpenCode，再在 PowerShell 中运行：

```powershell
node "theme-tool.cjs" restore
```

若读取进程或写安装目录被 Windows 拒绝，在同一账户的管理员终端执行。脚本不结束进程。

原始资源保存到本文件夹 `backups/<时间>/app.asar`，`backup-manifest.json` 记录位置与 SHA256。恢复前校验备份及当前文件；若软件已升级则拒绝用旧版覆盖新版。

## 重新应用

仅适用于 1.18.29，先恢复原样、修改本目录中的 `snow-theme.css`，然后运行：

```powershell
node "theme-tool.cjs" apply
```

## 注意

### 配色扩展版

在保持背景不变的基础上，主按钮、链接、选中边框、输入焦点、图标、标签和滚动条采用图中雾蓝 `#A0A7C9`、雪灰 `#ABB1D0`、灰紫 `#787E9F`。主按钮使用深色文字保证对比度。错误/警告/成功与代码差异色保留原有语义。

已有背景补丁时，修改 CSS 后可直接关闭桌面端并运行 `node theme-tool.cjs update`。这会额外备份当前版本，而 `restore` 仍然恢复最初未定制的原版。更新不会重复添加背景或改变背景透明度。

- 本地界面资源定制，不是官方桌面主题接口，更新/重装可能覆盖。
- 图片复制进入安装资源后，移动原始图片不会影响已应用背景。重新应用时仍需原图。
- 只改变 HTML 中的样式引用，并新增 CSS 和图片；不修改原有 JavaScript、EXE、安装器、配置和会话数据。
- 若系统启用减少透明度偏好，样式会降级为蓝灰纯色背景。
