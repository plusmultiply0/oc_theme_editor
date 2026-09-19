/**
 * 中文编码自检。
 *
 * 仓库的源码/文档/工具输出统一是 UTF-8；有两类会让中文变成乱码的失效，必须能被自动发现：
 *   1. **文件写坏**：以非 UTF-8 编码写入（带 BOM、解码出 U+FFFD，或留下 GBK↔UTF-8 误解码字）；
 *   2. **子进程输出编码不一致**：PowerShell 5.1 在 stdout 被重定向时按 OEM/ANSI 代码页
 *      （中文机器常为 cp936/GBK）写字节，而编排器其余输出是 UTF-8 —— 同一份日志里混两种
 *      编码，Node 以 utf8 读取或人用 UTF-8 打开都会看到乱码。工具侧统一改走
 *      `tools/ps-run.cjs`（把 PowerShell stdout 钉成 UTF-8），本文件同时验证该入口
 *      与「不再裸调 spawnSync('powershell', …)」这条约束，避免以后再悄悄回归。
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

interface PsRunApi {
  PS_UTF8_PREAMBLE: string;
  runPowerShell: (
    script: string,
    opts?: Record<string, unknown>,
  ) => { status: number | null; stdout: string | null; stderr: string | null };
}

const requireCjs = createRequire(import.meta.url);
const { PS_UTF8_PREAMBLE, runPowerShell } = requireCjs('../../tools/ps-run.cjs') as PsRunApi;

const ROOT = path.resolve(__dirname, '..', '..');
const EXTENSIONS = new Set(['.ts', '.tsx', '.cjs', '.mjs', '.js', '.json', '.md', '.css', '.html']);
/** 第三方/生成物/证据目录不属于「项目自身源码」，不参与编码自检 */
const SKIP_DIRS = new Set([
  'node_modules', 'out', 'dist', '.git', '.workbuddy', 'handoff', 'OpenCode',
  'test-results', 'playwright-report',
]);

/**
 * 典型 GBK↔UTF-8 误解码残留字符（用 \u 转义书写，避免本文件被自己扫描时误判）。
 * 单个这类字符在正常中文里极少见，但仍可能出现在正常词汇（作坊/浠水/宸）中，
 * 因此要求**连续两个以上**才判定为乱码。
 */
const MOJIBAKE_CHARS =
  '\\u951b\\u934f\\u93c2\\u93c3\\u5bb8\\u6d93\\u6d60\\u9473\\u935c\\u9428\\u52ec\\u574a';
const MOJIBAKE_RUN = new RegExp(`[${MOJIBAKE_CHARS}]{2,}`, 'u');

/** 列出项目自身的文本文件（跳过第三方、构建产物、证据目录与锁文件） */
function listProjectTextFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // release / release2…release7（历史候选目录）与 release-dev（G4 改名后的 electron-builder 默认输出）同为构建产物
    if (SKIP_DIRS.has(entry.name) || /^candidate-/.test(entry.name) || /^release(-dev)?\d*$/.test(entry.name)) {
      continue;
    }
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listProjectTextFiles(p, acc);
      continue;
    }
    if (entry.name === 'package-lock.json') continue;
    if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) acc.push(p);
  }
  return acc;
}

describe('中文编码自检', () => {
  it('项目自身文本文件都是无 BOM 的合法 UTF-8，且没有乱码残留', () => {
    const files = listProjectTextFiles(ROOT);
    expect(files.length).toBeGreaterThan(50);
    const problems: string[] = [];
    for (const file of files) {
      const buf = fs.readFileSync(file);
      const rel = path.relative(ROOT, file);
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push(`带 UTF-8 BOM：${rel}`);
      const text = buf.toString('utf8');
      if (text.includes('\uFFFD')) problems.push(`含替换字符 U+FFFD（说明不是合法 UTF-8）：${rel}`);
      if (MOJIBAKE_RUN.test(text)) problems.push(`含 GBK↔UTF-8 误解码乱码：${rel}`);
    }
    expect(problems).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('PowerShell 子进程输出按 UTF-8 写出并可正确解码', () => {
    const r = runPowerShell("Write-Output '中文编码检查：通过'", { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect((r.stdout || '').trim()).toBe('中文编码检查：通过');
  });

  it('PowerShell 统一入口带 UTF-8 前导，工具不再裸调 spawnSync(powershell)', () => {
    expect(PS_UTF8_PREAMBLE).toContain('OutputEncoding');
    for (const rel of ['tools/release-build.cjs', 'tools/test-release-gate.cjs']) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text).not.toMatch(/spawnSync\(\s*'powershell'/);
      expect(text).toContain("require('./ps-run.cjs')");
    }
  });
});
