/**
 * 首个兼容目标：OpenCode 桌面版（Windows 用户级安装）。
 *
 * 依据来自 docs/discovery.md 的只读取证：
 * - 归档 package.json：{"name":"@opencode-ai/desktop","version":"1.18.29","main":"./out/main/index.js"}
 * - 归档：resources/app.asar，152,395,856 字节 / 6,994 条目
 * - HTML 入口：out/renderer/index.html
 *
 * 只锁已验证版本；其他版本返回 unknown，不允许应用。
 */
import type { TargetAdapter } from './types';

export const OPENCODE_DESKTOP_ADAPTER: TargetAdapter = {
  id: 'opencode-desktop-win-asar',
  channel: 'windows-local-user-install',
  framework: 'electron-asar',
  installDirNames: ['@opencode-aidesktop'],
  packageName: '@opencode-ai/desktop',
  supportedVersions: ['1.18.29'],
  layout: {
    exe: 'OpenCode.exe',
    archive: 'resources/app.asar',
  },
  injection: {
    htmlEntry: 'out/renderer/index.html',
    cssFile: 'out/renderer/oc-theme-custom.css',
    imageFile: 'out/renderer/oc-theme-background.jpg',
    anchor: '</head>',
  },
  allowedChanges: [
    'out/renderer/index.html',
    'out/renderer/oc-theme-custom.css',
    'out/renderer/oc-theme-background.jpg',
  ],
  matches(pkg) {
    return pkg.name === '@opencode-ai/desktop';
  },
};
