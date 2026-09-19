# version-probe 真机只读验证报告（2026-09-19）

命令：\`THEME_SWITCHER_NO_REGISTRY=1 node tools/version-probe.cjs --discover\`（跳过卸载登记表读取，候选来自 LOCALAPPDATA\Programs；全程只读，零写入）。
提交基线：V1 \`9821928\` + V2 \`2e27f68\`。

## 人读报告（原样）

```

安装目录：C:\Users\ylzho\AppData\Local\Programs\@opencode-aidesktop
adapter：opencode-desktop-win-asar    版本：1.18.29    指纹前16位：e69578415b1012b5    白名单：supported
探测时间：2026-09-19T03:58:01.914Z → 2026-09-19T03:58:02.504Z
  [PASS] 1. 结构定位 —— exe 存在（OpenCode.exe）；归档 存在（resources/app.asar）
          判据：adapter.layout：exe + resources/app.asar 齐全
  [PASS] 2. 包名 —— 包名 @opencode-ai/desktop 与已适配目标一致
          判据：adapter.matches(pkg)（归档 package.json）
  [PASS] 3. 版本与指纹 —— 版本 1.18.29；指纹 e69578415b1012b5…；归档 150610357 字节
          判据：readAsar 快照（size + SHA256）
  [PASS] 4. 注入锚点 —— 恰好 1 次，注入位置唯一
          判据：统计「</head>」出现次数
  [FAIL] 5. 变更集合冲突 —— 已存在：out/renderer/oc-theme-custom.css、out/renderer/oc-theme-background.jpg——该安装打过补丁或有残留，先走恢复流程再评估
          判据：listAsarFiles 查 cssFile/imageFile
  [PASS] 6. unpacked 完整性（信息项） —— 存在，47 个文件
          判据：resources/app.asar.unpacked 存在与条目数
  [PASS] 7. 白名单比对（信息项） —— 版本 1.18.29 在已验证名单（supported）
          判据：adapter.supportedVersions
结论：FAIL    按上表 FAIL 项定位结构变化；probe 不做降级猜测，不改 supportedVersions。
exit=1
```

## JSON 报告（原样，可 JSON.parse）

```json
{
  "probe": "version-probe/1",
  "reports": [
    {
      "root": "C:\\Users\\ylzho\\AppData\\Local\\Programs\\@opencode-aidesktop",
      "startedAt": "2026-09-19T03:58:02.802Z",
      "finishedAt": "2026-09-19T03:58:03.352Z",
      "adapterId": "opencode-desktop-win-asar",
      "version": "1.18.29",
      "fingerprint16": "e69578415b1012b5",
      "support": "supported",
      "checks": [
        {
          "id": 1,
          "name": "结构定位",
          "status": "PASS",
          "basis": "adapter.layout：exe + resources/app.asar 齐全",
          "detail": "exe 存在（OpenCode.exe）；归档 存在（resources/app.asar）"
        },
        {
          "id": 2,
          "name": "包名",
          "status": "PASS",
          "basis": "adapter.matches(pkg)（归档 package.json）",
          "detail": "包名 @opencode-ai/desktop 与已适配目标一致"
        },
        {
          "id": 3,
          "name": "版本与指纹",
          "status": "PASS",
          "basis": "readAsar 快照（size + SHA256）",
          "detail": "版本 1.18.29；指纹 e69578415b1012b5…；归档 150610357 字节"
        },
        {
          "id": 4,
          "name": "注入锚点",
          "status": "PASS",
          "basis": "统计「</head>」出现次数",
          "detail": "恰好 1 次，注入位置唯一"
        },
        {
          "id": 5,
          "name": "变更集合冲突",
          "status": "FAIL",
          "basis": "listAsarFiles 查 cssFile/imageFile",
          "detail": "已存在：out/renderer/oc-theme-custom.css、out/renderer/oc-theme-background.jpg——该安装打过补丁或有残留，先走恢复流程再评估"
        },
        {
          "id": 6,
          "name": "unpacked 完整性（信息项）",
          "status": "PASS",
          "basis": "resources/app.asar.unpacked 存在与条目数",
          "detail": "存在，47 个文件"
        },
        {
          "id": 7,
          "name": "白名单比对（信息项）",
          "status": "PASS",
          "basis": "adapter.supportedVersions",
          "detail": "版本 1.18.29 在已验证名单（supported）"
        }
      ],
      "conclusion": "FAIL",
      "exitCode": 1,
      "nextStep": "按上表 FAIL 项定位结构变化；probe 不做降级猜测，不改 supportedVersions。"
    }
  ],
  "exitCode": 1
}
```

## 解读与结论

- **检查 5 的 FAIL 是当前安装的如实状态**：本机现在挂着本工具的主题（A5 轮之后 jc 继续使用），
  归档内自然存在 css/图片产物——这不是脚本缺陷，恰恰是检查项要报的信息（对已打补丁的安装，
  probe 的正确建议就是「先恢复再评估」）。对**全新版本**的适配探测应在未挂主题的安装上跑。
- 其余六项按预期 PASS。当前指纹 e69578415b1012b5… 与 A5 轮收尾登记（无主题态 1c53ca24…）不同，
  与检查 5 一致：A5 之后本机重新挂过主题，属预期状态变化，非异常。
- 全程只读：脚本仅 existsSync/statSync/readdirSync + readAsar 系只读 API，无任何写入路径。
- **probe PASS 不构成发布/白名单资格**：supportedVersions 未动（仍只有 1.18.29），
  进白名单必须走下方 compatibility.md「新版本适配流程」的完整闭环。
