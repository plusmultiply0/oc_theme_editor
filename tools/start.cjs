#!/usr/bin/env node
/**
 * 开发启动器（2026-10-17 启动故障修复）。
 *
 * 故障：从 Electron 系宿主（如 WorkBuddy）派生的终端会继承 ELECTRON_RUN_AS_NODE=1，
 * 此时 `electron .` 以纯 Node 模式运行，require('electron').app 为 undefined，
 * 主进程在 app.whenReady 处 TypeError 退出——表现为「启动不了」。
 *
 * 本脚本在拉起 electron 前剥掉该变量（其余环境原样继承），参数原样透传。
 */
const { spawn } = require('node:child_process');
const electron = require('electron'); // 解析为 electron.exe 路径

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
