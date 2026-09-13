/**
 * 合成安装 fixture（T30–T42 故障测试的基础设施）。
 *
 * 全部在临时目录内构造，不触碰任何真实安装。
 * 归档由 @electron/asar 真实打包，保证识别逻辑面对的是合法 ASAR 结构。
 */
import fs from 'node:fs';
import { testTmpRoot } from './test-tmp';
import path from 'node:path';
import { createPackageWithOptions } from '@electron/asar';

export interface SyntheticInstallOptions {
  pkgName?: string;
  version?: string;
  main?: string;
  /** 归档内额外文件，键为归档内相对路径 */
  files?: Record<string, string>;
  withExe?: boolean;
  /** 需要保留为 unpacked 条目的 glob，用于验证重打包不破坏原生模块标记 */
  unpack?: string;
}

export interface SyntheticInstall {
  root: string;
  srcDir: string;
  archivePath: string;
  exePath: string;
  cleanup(): void;
}

const DEFAULT_HTML = '<!doctype html><html><head><title>t</title></head><body></body></html>';

export async function makeSyntheticInstall(
  opts: SyntheticInstallOptions = {},
): Promise<SyntheticInstall> {
  const base = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-install-'));
  const srcDir = path.join(base, '_src');
  const root = path.join(base, 'install');

  const pkg = {
    name: opts.pkgName ?? '@opencode-ai/desktop',
    version: opts.version ?? '1.18.29',
    main: opts.main ?? './out/main/index.js',
  };

  write(path.join(srcDir, 'package.json'), JSON.stringify(pkg, null, 2));
  write(path.join(srcDir, 'out/main/index.js'), 'console.log(1);');
  write(path.join(srcDir, 'out/renderer/index.html'), DEFAULT_HTML);
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    write(path.join(srcDir, rel), content);
  }

  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const archivePath = path.join(resources, 'app.asar');
  await createPackageWithOptions(srcDir, archivePath, {
    ...(opts.unpack ? { unpack: opts.unpack } : {}),
  });

  const exePath = path.join(root, 'OpenCode.exe');
  if (opts.withExe !== false) write(exePath, 'MZ-placeholder');

  return {
    root,
    srcDir,
    archivePath,
    exePath,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
