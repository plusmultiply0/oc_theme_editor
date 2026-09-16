#!/usr/bin/env node
/**
 * N5：按用例身份分类集成测试错误（复审 D 项取证）。
 *
 * 为什么需要它：历史日志里有 62 个「错误块」，但错误块数**不是失败用例数**。
 * 只 grep EBUSY 次数会得到两个错误结论：
 *   1) 把同一条业务失败伴随的清理失败算成两次失败；
 *   2) 把「清理失败但业务断言通过」与「业务断言失败」混为一谈 —— 前者只是
 *      环境噪声，后者才是产品缺陷。
 *
 * 本脚本把 vitest JSON 机器结果按**用例身份**（文件的完整名称）归并，每个用例
 * 只出一条分类结论：
 *   setup          —— 收集/启动阶段失败（beforeAll、导入错误），用例没真正跑；
 *   business       —— 用例体内的断言/调用失败，且**没有**清理错误；
 *   business+cleanup —— 业务失败且同一用例还伴随清理错误；
 *   cleanup_only   —— 仅有 afterEach/afterAll 清理错误，业务断言通过；
 *   incomplete     —— 未完成（pending/skipped/todo）或结果缺失。
 *
 * 同时保留原始 errno（EACCES / EPERM / EBUSY / ENOENT ...）：commit.ts 把若干
 * 错误码统一归为 FILE_LOCKED，诊断不能继承这个归并 —— EACCES/EPERM 不等于
 * 「文件被锁」，归因需要证据。
 *
 * 用法：
 *   node tools/n5-classify-integration.cjs <vitest-json> [--out <report.json>]
 *   node tools/n5-classify-integration.cjs --run        # 直接跑集成测试再分类
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** 原始错误码：从消息里提取，不做语义归并（保留 first errno + 全部出现过的） */
const ERRNO_RE = /\b(EACCES|EPERM|EBUSY|ENOENT|ENOTEMPTY|EEXIST|EMFILE|ENFILE|EAGAIN|EPIPE|ERR_IPC_CHANNEL_CLOSED|ERR_IPC_DISCONNECTED|EINVAL|ETIMEDOUT|ESRCH|UNKNOWN)\b/g;

function errnosIn(text) {
  if (!text) return [];
  return [...new Set(String(text).match(ERRNO_RE) || [])].sort();
}

/**
 * 清理阶段特征。判定「清理错误」必须依据**错误发生的位置**，不能只看词面：
 * 业务断言完全可能讨论「清理」「删除」这类概念 —— 例如 electron-runtime 的
 * 用例断言「启动清理遗留准备区: cleaned=0」，那是**业务**失败（产品在启动时
 * 没清掉遗留），把它归成 cleanup_only 会直接掩盖产品缺陷。
 *
 * 因此只认两类证据：
 *   1) vitest 的 hook 归属：错误块带 afterEach/afterAll/beforeAll 等 hook 名；
 *   2) 清理实现自身抛出的错误特征：safe-delete-shim / 夹具清理函数 / rmSync。
 * 纯粹的「清理」「删除」字眼不再算证据。
 */
const CLEANUP_MARKERS = [
  /\bafterEach\b/i, /\bafterAll\b/i, /\bbeforeEach\b/i, /\bbeforeAll\b/i,
  /safe-delete/i,
  /\bcleanupFixture\b/i, /\bdisposeFixture\b/i, /\bremoveFixture\b/i,
  /\bcleanupAll\b/i,
  /夹具清理/, /清理夹具/,
  /\brmSync\b/, /\bfs\.unlink/i,
];

function looksLikeCleanup(text) {
  if (!text) return false;
  return CLEANUP_MARKERS.some((re) => re.test(text));
}

/** 收集一个用例的全部错误文本（message + 失败断言 + 附加错误） */
function errorTextsOf(test) {
  const parts = [];
  if (test.message) parts.push(String(test.message));
  if (Array.isArray(test.failureMessages)) parts.push(...test.failureMessages.map(String));
  for (const a of test.assertionResults || []) {
    if (a.failureMessages) parts.push(...a.failureMessages.map(String));
    if (a.message) parts.push(String(a.message));
  }
  return parts.filter(Boolean);
}

/** 从一个 vitest JSON 机器结果生成分类报告 */
function classify(json) {
  const files = json.testResults || [];
  const cases = [];
  let totals = { total: 0, passed: 0, failed: 0, pending: 0, todo: 0, skipped: 0 };

  for (const f of files) {
    // 文件级失败（收集失败 / 导入错误）：整个文件没有可判定用例
    const fileFailed = f.status === 'failed' && (!f.assertionResults || f.assertionResults.length === 0);
    const fileMsgs = [f.message].concat(f.failureMessages || []).filter(Boolean).map(String);
    if (fileFailed) {
      const txt = fileMsgs.join('\n');
      cases.push({
        file: f.name,
        test: '(整个文件)',
        category: /afterAll|afterEach|清理|cleanup/i.test(txt) ? 'cleanup_only' : 'setup',
        status: 'failed',
        errnos: errnosIn(txt),
        cleanupErrors: errnosIn(fileMsgs.filter(looksLikeCleanup).join('\n')),        message: txt.split('\n').slice(0, 3).join(' | '),
      });
      totals.total += 1;
      totals.failed += 1;
      continue;
    }

    for (const a of f.assertionResults || []) {
      totals.total += 1;
      const st = a.status;
      if (st === 'passed') totals.passed += 1;
      else if (st === 'failed') totals.failed += 1;
      else if (st === 'pending') totals.pending += 1;
      else if (st === 'todo') totals.todo += 1;
      else if (st === 'skipped') totals.skipped += 1;

      const texts = errorTextsOf(a).concat(a.failureMessages ? a.failureMessages.map(String) : []);
      const businessTexts = texts.filter((t) => !looksLikeCleanup(t));
      const cleanupTexts = texts.filter((t) => looksLikeCleanup(t));
      const all = texts.join('\n');

      let category;
      if (st === 'pending' || st === 'todo' || st === 'skipped') category = 'incomplete';
      else if (st === 'failed') {
        if (cleanupTexts.length && businessTexts.length) category = 'business+cleanup';
        else if (cleanupTexts.length) category = 'cleanup_only';
        else category = 'business';
      } else {
        // 通过但有清理错误：清理失败不应被吞掉，也不能算业务失败
        category = cleanupTexts.length ? 'cleanup_only' : 'passed';
      }

      cases.push({
        file: f.name,
        test: a.fullName || a.title || '(unnamed)',
        category,
        status: st,
        errnos: errnosIn(all),
        cleanupErrors: errnosIn(cleanupTexts.join('\n')),
        message: all.split('\n').slice(0, 3).join(' | '),
      });
    }
  }

  const byCategory = {};
  for (const c of cases) byCategory[c.category] = (byCategory[c.category] || 0) + 1;

  const errnoCounts = {};
  for (const c of cases) for (const e of c.errnos) errnoCounts[e] = (errnoCounts[e] || 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim(),
    machineResult: {
      numTotalTestSuites: json.numTotalTestSuites,
      numTotalTests: json.numTotalTests,
      numPassedTests: json.numPassedTests,
      numFailedTests: json.numFailedTests,
      numPendingTests: json.numPendingTests,
      numTodoTests: json.numTodoTests,
      success: json.success,
    },
    counts: totals,
    /** 结论口径：四类 + 通过的用例，而不是「错误块数」 */
    byCategory,
    /** 原始错误码分布（未做 FILE_LOCKED 归并） */
    errnoCounts,
    /** 真正需要产品侧关注：business / business+cleanup / setup / incomplete */
    needsAttention: cases.filter((c) => ['business', 'business+cleanup', 'setup', 'incomplete'].includes(c.category)),
    /** 仅清理失败：环境噪声，需记录但不阻断业务结论 */
    cleanupOnly: cases.filter((c) => c.category === 'cleanup_only'),
    cases,
  };
}

function runIntegration() {
  const outJson = path.join(ROOT, 'node_modules', '.cache', 'n5-integration.json');
  const args = [
    path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/integration',
    '--pool=forks', '--maxWorkers=1', '--no-file-parallelism',
    '--reporter=json', `--outputFile.json=${outJson}`,
  ];
  console.log('运行集成测试（受控并发）...');
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (!fs.existsSync(outJson)) {
    console.error('未生成机器结果，集成测试可能未能启动');
    process.exit(1);
  }
  return { json: JSON.parse(fs.readFileSync(outJson, 'utf8')), exitCode: r.status };
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : path.join(ROOT, 'handoff', 'review-2026-09-16', 'evidence', 'n5-classification.json');

  let json;
  if (argv.includes('--run')) {
    ({ json } = runIntegration());
  } else {
    const input = argv.find((a) => !a.startsWith('--') && a !== argv[outIdx + 1]);
    if (!input) {
      console.error('用法：node tools/n5-classify-integration.cjs <vitest-json> [--out <report.json>]');
      console.error('      node tools/n5-classify-integration.cjs --run');
      process.exit(2);
    }
    json = JSON.parse(fs.readFileSync(input, 'utf8'));
  }

  const report = classify(json);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== N5 分类结论（按用例身份）===');
  console.log(`用例总数 ${report.counts.total}：通过 ${report.counts.passed} / 失败 ${report.counts.failed} / 未完成 ${report.counts.pending + report.counts.skipped + report.counts.todo}`);
  console.log('分类：', JSON.stringify(report.byCategory));
  console.log('原始错误码分布：', JSON.stringify(report.errnoCounts));
  console.log(`需要关注（业务/启动/未完成）：${report.needsAttention.length}`);
  for (const c of report.needsAttention.slice(0, 40)) {
    console.log(`  [${c.category}] ${path.basename(c.file)} :: ${c.test}`);
    if (c.message) console.log(`      ${c.message.slice(0, 150)}`);
  }
  console.log(`仅清理失败（环境噪声）：${report.cleanupOnly.length}`);
  for (const c of report.cleanupOnly.slice(0, 20)) {
    console.log(`  ${path.basename(c.file)} :: ${c.test} {${c.cleanupErrors.join(',')}}`);
  }
  console.log(`\n报告：${path.relative(ROOT, outPath)}`);
  process.exit(report.needsAttention.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { classify, errnosIn, looksLikeCleanup };
