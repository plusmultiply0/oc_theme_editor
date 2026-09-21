/**
 * 版本探测脚本（version-probe，计划 handoff/version-probe-plan-2026-09-19/PLAN.md V1）。
 *
 * 对任意 OpenCode Desktop 安装回答「补丁机制在这个版本上能不能用、哪里变了」。
 * 全程只读：不写安装目录、不启动 GUI；PASS 也**不**改变 supportedVersions——
 * 进白名单仍是「代码改动 + 真机闭环 + 提交」的人工决策。
 *
 * 判据同源：布局 / 包名取自 out/adapters 的生产声明；结构验证（检查 4/5/6）
 * 直接消费 out/core/patch/compat-check——与产品链路同一把尺子，本文件不留第二份判据。
 * 归档读取复用 out/core/patch/asar。
 *
 * 用法（先 npm run build）：
 *   node tools/version-probe.cjs <安装目录> [--json]
 *   node tools/version-probe.cjs --discover [--json]
 *
 * 退出码：0 = 可适配（含 WARN）；1 = 不可适配；2 = 用法/结构错误。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
if (!fs.existsSync(path.join(OUT, 'main', 'index.js'))) {
  console.error('未找到 out/main，请先执行 npm run build');
  process.exit(2);
}

const { ADAPTERS } = require(path.join(OUT, 'adapters', 'registry'));
const asar = require(path.join(OUT, 'core', 'patch', 'asar'));
const compat = require(path.join(OUT, 'core', 'patch', 'compat-check'));
const discover = require(path.join(OUT, 'core', 'patch', 'discover'));

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';

function check(id, name, status, basis, detail) {
  return { id, name, status, basis, detail: detail || null };
}

/**
 * 探测单个安装根目录。opts 为测试注入缝：
 *   opts.adapters  替代 ADAPTERS 声明（默认生产注册表）
 *   opts.fs        替代 node:fs（仅 existsSync/statSync，测试用合成环境）
 */
async function probeInstall(root, opts = {}) {
  const adapters = opts.adapters ?? ADAPTERS;
  const fss = opts.fs ?? fs;
  const startedAt = new Date().toISOString();
  const checks = [];

  if (!fss.existsSync(root) || !fss.statSync(root).isDirectory()) {
    return {
      root,
      startedAt,
      finishedAt: new Date().toISOString(),
      version: null,
      fingerprint16: null,
      adapterId: null,
      support: 'error',
      checks: [check(0, '安装目录', FAIL, '参数指定的目录不存在或不是目录', String(root))],
      conclusion: FAIL,
      exitCode: 2,
      nextStep: '确认路径拼写；或用 --discover 列出候选安装。',
    };
  }

  // 布局定位：按 adapter.layout.archive 找归档，取第一个存在的（与 inspectRoot 同策略）
  let adapter = null;
  let archivePath = null;
  for (const a of adapters) {
    const p = path.join(root, a.layout.archive);
    if (fss.existsSync(p)) {
      adapter = a;
      archivePath = p;
      break;
    }
  }
  if (!adapter) adapter = adapters[0];
  const exePath = path.join(root, adapter.layout.exe);
  const exeOk = fss.existsSync(exePath);
  const archiveOk = archivePath !== null;
  checks.push(
    check(
      1,
      '结构定位',
      exeOk && archiveOk ? PASS : FAIL,
      'adapter.layout：exe + resources/app.asar 齐全',
      `exe ${exeOk ? '存在' : '缺失'}（${adapter.layout.exe}）；归档 ${archiveOk ? '存在' : '缺失'}（${adapter.layout.archive}）`,
    ),
  );

  let snapshot = null;
  let pkg = null;
  if (archiveOk) {
    const r = await asar.readAsar(archivePath);
    if (r.success) snapshot = r.data;
  }

  // 检查 2（包名）与检查 3（版本与指纹）共用一次归档读取；按编号顺序推送
  if (snapshot) {
    const pr = await asar.readAsarPackage(snapshot);
    if (pr.success) pkg = pr.data;
  }
  const version = pkg && pkg.version ? pkg.version : null;
  if (pkg !== null) {
    const matched = adapter.matches(pkg);
    checks.push(
      check(
        2,
        '包名',
        matched ? PASS : FAIL,
        'adapter.matches(pkg)（归档 package.json）',
        `包名 ${pkg.name ?? '缺失'}${matched ? ' 与已适配目标一致' : ' 与已适配目标不符'}`,
      ),
    );
  } else {
    checks.push(
      check(2, '包名', FAIL, 'adapter.matches(pkg)', snapshot ? '归档 package.json 无法解析' : '无归档可读'),
    );
  }
  checks.push(
    check(
      3,
      '版本与指纹',
      snapshot ? PASS : FAIL,
      'readAsar 快照（size + SHA256）',
      snapshot
        ? `版本 ${version ?? '未知'}；指纹 ${snapshot.sha256.slice(0, 16)}…；归档 ${snapshot.size} 字节`
        : '归档读不到或无法解析（结构异常/被占用）',
    ),
  );

  // 检查 4/5/6（注入锚点 / 变更集合归属 / unpacked 信息项）：
  // 判据全部取自 core/compat-check（structural-compat S1 单一来源）——
  // 本文件不得再抄一份独立实现；白名单外版本能否放行应用与产品链路同一把尺子。
  if (snapshot) {
    const report = await compat.verifyStructure(snapshot, adapter, { fs: fss });
    const IDS = { anchor: 4, changeSet: 5, unpacked: 6 };
    for (const c of report.checks) {
      checks.push(check(IDS[c.key], c.name, c.status, c.basis, c.detail));
    }
  } else {
    checks.push(check(4, '注入锚点', FAIL, 'core/compat-check：锚点唯一性', '无归档可读'));
    checks.push(check(5, '变更集合归属', FAIL, 'core/compat-check：变更集合干净', '无归档可读'));
    checks.push(check(6, 'unpacked 完整性（信息项）', FAIL, 'core/compat-check：unpacked 目录在位', '无归档可读'));
  }

  // 检查 7（白名单比对，信息项）：不在列只标 unknown，不中断
  const inList = version !== null && adapter.supportedVersions.includes(version);
  checks.push(
    check(
      7,
      '白名单比对（信息项）',
      inList ? PASS : WARN,
      'adapter.supportedVersions',
      version === null
        ? '版本未知，按 unknown 处理'
        : inList
          ? `版本 ${version} 在已验证名单（supported）`
          : `版本 ${version} 不在已验证名单（已验证：${adapter.supportedVersions.join('、')}）→ unknown；其余检查照常给出`,
    ),
  );

  const hasFail = checks.some((c) => c.status === FAIL);
  const hasWarn = checks.some((c) => c.status === WARN);
  return {
    root,
    startedAt,
    finishedAt: new Date().toISOString(),
    adapterId: adapter.id,
    version,
    fingerprint16: snapshot ? snapshot.sha256.slice(0, 16) : null,
    support: version !== null && adapter.supportedVersions.includes(version) ? 'supported' : 'unknown',
    checks,
    conclusion: hasFail ? FAIL : hasWarn ? WARN : PASS,
    exitCode: hasFail ? 1 : 0,
    nextStep: hasFail
      ? '按上表 FAIL 项定位结构变化；probe 不做降级猜测，不改 supportedVersions。'
      : hasWarn
        ? '无阻断项但含 WARN：白名单外版本的结构判据以检查 4/5 为准（同产品链路）；进 supportedVersions 仍需真机闭环的人工决策。'
        : '全部 PASS：结构验证与产品链路同判据通过；进白名单仍是「真机闭环 + 人工决策」。',
  };
}

/* ---------- 输出 ---------- */

const MARK = { [PASS]: 'PASS', [WARN]: 'WARN', [FAIL]: 'FAIL' };

function printHuman(r) {
  console.log('');
  console.log(`安装目录：${r.root}`);
  console.log(`adapter：${r.adapterId ?? '—'}    版本：${r.version ?? '未知'}    指纹前16位：${r.fingerprint16 ?? '—'}    白名单：${r.support}`);
  console.log(`探测时间：${r.startedAt} → ${r.finishedAt}`);
  for (const c of r.checks) {
    console.log(`  [${MARK[c.status].padEnd(4)}] ${c.id}. ${c.name} —— ${c.detail}`);
    console.log(`          判据：${c.basis}`);
  }
  console.log(`结论：${r.conclusion}    ${r.nextStep}`);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (const a of argv) {
    if (a === '--json') out.flags.json = true;
    else if (a === '--discover') out.flags.discover = true;
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let roots = [];
  if (args.flags.discover) {
    // 复用生产发现逻辑（只读）：候选根 + 登记表，与 GUI 同一判据
    const useRegistry = process.env.THEME_SWITCHER_NO_REGISTRY !== '1';
    roots = discover.candidateRoots({ useRegistry }).filter((r) => {
      try {
        return fs.existsSync(r) && fs.statSync(r).isDirectory();
      } catch {
        return false;
      }
    });
    if (roots.length === 0) {
      console.error('未发现任何候选安装目录（--discover）');
      process.exit(2);
    }
  } else {
    if (args._.length !== 1) {
      console.error('用法：node tools/version-probe.cjs <安装目录> [--json]');
      console.error('      node tools/version-probe.cjs --discover [--json]');
      process.exit(2);
    }
    roots = [path.resolve(args._[0])];
  }

  const reports = [];
  let worst = 0;
  for (const r of roots) {
    const rep = await probeInstall(r);
    reports.push(rep);
    worst = Math.max(worst, rep.exitCode);
    if (!args.flags.json) printHuman(rep);
  }
  if (args.flags.json) {
    console.log(JSON.stringify({ probe: 'version-probe/1', reports, exitCode: worst }, null, 2));
  } else if (reports.length > 1) {
    console.log('');
    console.log(`共探测 ${reports.length} 个目录：${reports.map((r) => `${path.basename(r.root)}=${r.conclusion}`).join('，')}`);
  }
  process.exit(worst);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`探测脚本异常：${e && e.message ? e.message : e}`);
    process.exit(2);
  });
}

module.exports = { probeInstall, main };
