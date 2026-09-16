#!/usr/bin/env node
/**
 * PowerShell 子进程统一入口（中文编码修复）。
 *
 * 问题：PowerShell 5.1 在 stdout 被重定向时，按**控制台输出编码**（OEM/ANSI，
 * 中文机器上通常是 cp936/GBK）写字节；而编排器自身的输出是 UTF-8。
 * 于是同一份日志里混了两种编码：Node 以 `encoding: 'utf8'` 读取 PowerShell 的
 * 中文输出会得到乱码（或 U+FFFD），把日志重定向到文件后用 UTF-8 打开也一样
 * 会看到乱码段。中文错误信息一旦乱码，排障证据就不可读。
 *
 * 修复：所有 PowerShell 调用都先执行前导语句把子进程的 stdout 钉成 UTF-8，
 * 再执行真正的脚本；调用方一律走本模块，不再裸调 `spawnSync('powershell', ...)`。
 */
'use strict';
const { spawnSync } = require('node:child_process');

/**
 * 让 PowerShell 的 stdout 以 UTF-8 写出。
 * `[Console]::OutputEncoding` 决定 PowerShell 自身写 console 时用的编码，
 * 设置它即可让重定向/管道下的中文字节与 Node 的解码方式一致。
 */
const PS_UTF8_PREAMBLE = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';

/**
 * 执行 PowerShell 脚本（自动带上 UTF-8 前导）。
 * @param {string} script 脚本正文（多语句用 `; ` 连接）
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding
 *   | import('node:child_process').SpawnSyncOptions} [opts]
 */
function runPowerShell(script, opts = {}) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `${PS_UTF8_PREAMBLE}; ${script}`],
    { windowsHide: true, ...opts },
  );
}

module.exports = { PS_UTF8_PREAMBLE, runPowerShell };