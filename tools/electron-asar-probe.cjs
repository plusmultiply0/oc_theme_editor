/**
 * 只读诊断：真实 Electron 运行时下 asar 路径的 fs 语义。
 *
 * 背景（P0 审查 R1）：Electron 主进程的 `require('fs')` 被包装过，
 * 路径里出现 `.asar` 会被当成虚拟目录 —— statSync().isFile 为 false、size 为 0，
 * Node 里正常的识别逻辑跑到 Electron 里就「找不到归档」。
 *
 * 本脚本只读取归档元信息，不写入、不解压、不改动任何安装。
 * 结果落 JSON 文件（Electron 是 GUI 子系统进程，stdout 不一定回传终端）。
 *
 * 用法：
 *   npm run build:main
 *   node tools/electron-asar-probe.cjs            # 用默认（真实）安装归档
 *   node tools/electron-asar-probe.cjs <asar路径>
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const OUT = path.join(__dirname, 'asar-probe-result.json');

const defaultAsar = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  '@opencode-aidesktop',
  'resources',
  'app.asar',
);

function safe(label, fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: `${e && e.code ? e.code + ': ' : ''}${e && e.message}` };
  }
}

function statShape(st) {
  return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size };
}

async function main() {
  const asar = process.argv[2] || defaultAsar;
  const result = {
    electron: process.versions.electron,
    node: process.versions.node,
    asar,
    asarExists: fs.existsSync(asar),
    noAsarInitially: process.noAsar === true,
  };

  // 1) 包装后的 fs（Electron 主进程默认拿到的那个）
  result.wrappedFsStatSync = safe('wrapped', () => statShape(fs.statSync(asar)));
  result.wrappedFsStat = await (async () => {
    try {
      return statShape(await fs.promises.stat(asar));
    } catch (e) {
      return { ok: false, error: String(e.message) };
    }
  })();

  // 2) node:fs/promises 与 fs/promises 是不是同一个被包装的对象
  const fsPromises = require('node:fs/promises');
  result.fsPromisesIsWrapped = await (async () => {
    try {
      const st = await fsPromises.stat(asar);
      return statShape(st);
    } catch (e) {
      return { ok: false, error: String(e.message) };
    }
  })();
  result.fsPromisesSameAsFsPromises = fsPromises === fs.promises;

  // 3) original-fs（Electron 提供的未包装 fs）
  const originalFs = safe('original-fs', () => require('original-fs'));
  result.originalFsLoadable = originalFs.ok;
  if (originalFs.ok) {
    const ofs = originalFs.value;
    result.originalFsHasPromises = Boolean(ofs.promises);
    result.originalFsStatSync = safe('ofs', () => statShape(ofs.statSync(asar)));
    result.originalFsStatAsync = ofs.promises
      ? await ofs.promises
          .stat(asar)
          .then(statShape)
          .catch((e) => ({ ok: false, error: String(e.message) }))
      : { ok: false, error: 'original-fs.promises 不存在' };
  }

  // 4) @electron/asar 在包装 fs 下的行为
  const asarLib = safe('asar-lib', () => require('@electron/asar'));
  if (asarLib.ok) {
    result.asarLibWrapped = safe('asar-wrapped', () => {
      const header = asarLib.value.getRawHeader(asar);
      return { hasFiles: Boolean(header && (header.files || (header.header && header.header.files))) };
    });

    // 5) 临时打开 process.noAsar 能否让 asar 库与 fs 回到物理语义
    const prev = process.noAsar;
    process.noAsar = true;
    try {
      result.withNoAsar = {
        wrappedFsStatSync: safe('w', () => statShape(fs.statSync(asar))),
        asarLib: safe('a', () => {
          const header = asarLib.value.getRawHeader(asar);
          return {
            hasFiles: Boolean(header && (header.files || (header.header && header.header.files))),
          };
        }),
      };
    } finally {
      process.noAsar = prev;
    }

    // 6) 恢复后是否回到原语义（确认改回来没有副作用）
    result.afterRestoreNoAsar = process.noAsar === true;
    result.wrappedFsStatSyncAfter = safe('wrapped-after', () => statShape(fs.statSync(asar)));
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log('ASAR_PROBE_RESULT ' + OUT);
  app.quit();
}

app.whenReady().then(main).catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack) }, null, 2), 'utf8');
  app.quit();
});
app.on('window-all-closed', () => app.quit());
