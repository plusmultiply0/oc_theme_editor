# E2E：真实 Electron 窗口的闭环测试

`npm run test:e2e` 现在跑的是**真实窗口**的用例（`theme-switcher.spec.ts`），
不再是空的占位目录。命令不再带 `--pass-with-no-tests`——零用例会让门禁失败。

## 跑什么

一个 Electron 进程 + 一份**临时目录里的合成安装**（里面预置了一层原型时代的
snow-theme），走完整的用户路径：

1. 窗口与渲染进程起来，默认选中的目标必须落在临时目录内（隔离保险）；
2. 未选图片时「应用」按钮禁用，并给出可行动的原因（不是把按钮强行点亮）；
3. 拖拽导入图片（真实 drop 事件 + 真实 IPC）→ 生成配色 → 可读性报告覆盖
   非 default 状态与多点采样；
4. 点「应用」→ 确认框里必须列出「会撤下的旧主题层」→ 确认后**真的改写**合成归档，
   `snow-theme.css` 的链接被撤下、`oc-theme-custom.css` 生效；
5. 恢复面板区分「原版 / 首次接管快照」，没有出厂证据时**不出现**「恢复原版」按钮；
6. 「重新检测」「选择安装目录」入口存在（识别失败时不是死路）；
7. 无未完成事务时「待恢复」面板明确说「没有」。

## 为什么必须跑真实窗口

Node 下的测试抓不到两类缺陷：

- **fs 语义不同**：Electron 包装过的 `fs` 会把 `app.asar` 当虚拟目录，
  识别逻辑在 Node 里全绿、在真机上一跑就「找不到归档」（P0 审查 R1）；
- **状态与界面不一致**：按钮禁用条件、报告覆盖范围、确认框披露内容
  只有真的把界面跑起来才能证伪（P0 审查 R4、R6）。

## 本机跑不起来时

Electron 是 GUI 子系统进程，无显示会话时 GPU 进程会反复重启并 FATAL。
spec 里已经带上 `--disable-gpu --no-sandbox --disable-gpu-compositing
--disable-software-rasterizer --in-process-gpu --disable-dev-shm-usage`，
本机（Windows，无交互桌面）实测可跑通。

如果实在起不来，**不要**用 `--pass-with-no-tests` 把门禁糊过去：

- 主进程侧的真实 Electron 覆盖仍然由 `npm run test:e2e:electron` 与
  `tests/integration/electron-runtime.test.ts` 提供（不建窗口也能验事务与物理 I/O）；
- 界面侧则应记为「未执行」，并在验收记录里如实写明。

## 隔离保证

用例永不触碰用户的真实安装：

- `LOCALAPPDATA` 指向临时目录，`THEME_SWITCHER_DATA_DIR` 指向临时运行目录；
- `THEME_SWITCHER_NO_REGISTRY=1` 关掉注册表扫描；
- 开工前断言选中目标的安装路径在临时目录内，不满足就直接失败。
