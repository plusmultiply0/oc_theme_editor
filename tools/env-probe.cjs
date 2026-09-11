/**
 * 一次性环境探针：Electron 主进程里 sharp 与物理 I/O 层是否可用。
 * 用完可删；结果落 tools/env-probe-result.json。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// GPU 进程在无显示会话下会反复重启并最终 FATAL，必须关掉硬件加速
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const res = { electron: process.versions.electron, node: process.versions.node };
  try {
    require('sharp');
    res.sharp = 'ok';
  } catch (e) {
    res.sharp = 'fail: ' + e.message.split('\n')[0];
  }
  try {
    const { physicalFsSource, physicalFs } = require(path.join(__dirname, '..', 'out', 'core', 'patch', 'physical-fs'));
    res.physicalFs = physicalFsSource();
    const asar = path.join(process.env.LOCALAPPDATA, 'Programs', '@opencode-aidesktop', 'resources', 'app.asar');
    res.wrappedStat = { isFile: fs.statSync(asar).isFile(), size: fs.statSync(asar).size };
    res.physicalStat = { isFile: physicalFs.statSync(asar).isFile(), size: physicalFs.statSync(asar).size };
  } catch (e) {
    res.physicalFs = 'fail: ' + e.message.split('\n')[0];
  }
  fs.writeFileSync(path.join(__dirname, 'env-probe-result.json'), JSON.stringify(res, null, 2), 'utf8');
  console.log('ENV_PROBE_DONE');
  app.quit();
}).catch((e) => {
  fs.writeFileSync(path.join(__dirname, 'env-probe-result.json'), JSON.stringify({ fatal: String(e) }, null, 2));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
