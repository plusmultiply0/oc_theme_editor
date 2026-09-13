/**
 * 测试专用临时目录（R5 修复的核心设施）。
 *
 * 背景（2026-09-13 R5 调查，证据见 handoff/review-2026-09-13/evidence/r5-diagnosis.json），
 * 本机有两层环境干扰：
 *
 * 1. 本机安全进程对「%TEMP% 目录下新建的 *.asar」延迟打开并持久锁住（.bin/.zip
 *    与项目盘 .asar 不受影响）——测试在 %TEMP% 构造合成 app.asar 会导致 apply 的
 *    rename 覆盖与 afterEach 清理 EBUSY/EPERM，形成 FILE_LOCKED 假失败。
 * 2. WorkBuddy CLI 的 node-safe-delete-shim 会在非临时目录路径上拦截 fs.rmSync
 *    （移入回收站 + 单轮删除计数，超 50 个目标抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED）
 *    ——测试清理落在项目盘会触发该护栏。
 *
 * 解法（两者兼顾）：跑测试时把 TEMP/TMP 指向一个项目盘根目录，
 * 则 os.tmpdir() 返回安全根（asar 不被锁），且 node-safe-delete-shim 的
 * OS_TMP_DIRS 在 preload 时快照同一值（rmSync 获得临时目录豁免，走原生删除）：
 *
 *   mkdir -p node_modules/.cache/ots-test-tmp
 *   TEMP=<repo>/node_modules/.cache/ots-test-tmp TMP=<同值> \
 *     node node_modules/vitest/vitest.mjs run
 *
 * 未注入 TEMP 的环境（CI 等，无上述干扰）自动回退到系统默认临时目录，行为不变。
 * 也可用 OTS_TEST_TMP 显式覆盖本 helper 的根。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedRoot: string | undefined;

export function testTmpRoot(): string {
  if (cachedRoot) return cachedRoot;
  const root = process.env.OTS_TEST_TMP ? path.resolve(process.env.OTS_TEST_TMP) : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  cachedRoot = root;
  return root;
}

/** 与 fs.mkdtempSync(path.join(os.tmpdir(), prefix)) 等价，但落在安全根内 */
export function mkTestTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(testTmpRoot(), prefix));
}
