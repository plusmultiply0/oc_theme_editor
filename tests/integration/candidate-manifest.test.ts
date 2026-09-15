/**
 * P2 命令级集成测试：候选登记、构建来源与源码冻结。
 *
 * 这是 B2 的核心正例——在**独立小型 Git 夹具**里真实执行：
 *   初始化仓库 → 提交源码 → 生成合成构建产物（out/ + 构建记录 + 候选目录）→
 *   运行 `candidate-manifest.cjs register --manifest <夹具>/candidate-x/candidate-manifest.json`
 *   → 断言 **Git 仍干净、HEAD 未变、登记写入成功**，再 `check` 通过。
 * 不用单独调用纯函数代替：B1/B2 的教训正是「函数对、真实调用错」。
 *
 * 负例（全部必须失败且不产出成功登记）：源码改脏、未跟踪源码、Git 不可用、
 * 锁文件不一致、旧 buildId、错误候选目录、空/过期构建记录、已有登记拒绝覆盖。
 *
 * **P4 任务 A（2026-09-14）**：worker 侧子进程等待全部改为**异步**
 * （`execFile` + Promise，见 `tests/fixtures/async-command.ts`）。
 * 原先同步 `execFileSync`/`spawnSync` 会阻塞 worker 事件循环，令
 * `rpc().onTaskUpdate(...)` 回执往返超时（Vitest 3.2.7 默认 60s），
 * 把整条发布链的退出码拉成 1。改为异步后事件循环在等待期间仍可处理 IPC。
 * 被测行为不变：仍是真实 spawn 真实 git / 真实 CLI，未 mock、未删例。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventLoopLagProbe, runCommand } from '../fixtures/async-command';
import { mkTestTmp, testTmpRoot } from '../fixtures/test-tmp';

const REPO = path.resolve(__dirname, '..', '..');
const CAND = path.join(REPO, 'tools', 'candidate-manifest.cjs');
const VERIFY_RELEASE = path.join(REPO, 'tools', 'verify-release.cjs');

// 工具是 CJS：用 createRequire 加载，避免 lint 禁用 require 规则
const requireCjs = createRequire(__filename);

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');

/* ---------------- 本 case 自建目录的登记与清理 ---------------- */

/**
 * 只登记**本 case 明确创建**的夹具根，afterAll 逐条清理。
 * 不按通配符清扫整个历史缓存；遇占用保留并报告，不强行删除。
 */
const createdRoots: string[] = [];

function trackFixture(prefix: string): string {
  const root = mkTestTmp(prefix);
  createdRoots.push(root);
  return root;
}

afterAll(() => {
  const safeRoot = path.resolve(testTmpRoot());
  let removed = 0;
  const kept: string[] = [];
  for (const r of createdRoots) {
    // 安全护栏：只删测试专用根内的目录，绝不外溢
    const resolved = path.resolve(r);
    const rel = path.relative(safeRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      kept.push(`${r}（不在测试专用根内，跳过）`);
      continue;
    }
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      kept.push(`${r}（占用未删：${e instanceof Error ? e.message.split('\n')[0] : String(e)}）`);
    }
  }
  console.log(
    `[candidate-manifest] 夹具清理：删除 ${removed} 个，保留 ${kept.length} 个` +
      (kept.length ? `\n  ${kept.join('\n  ')}` : ''),
  );
});

/* ---------------- 异步命令封装（真实调用，非 mock） ---------------- */

/** 在夹具目录里跑 git；非 0 抛出带命令、状态、stderr 的错误 */
async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runCommand('git', args, cwd);
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} 失败：status=${r.status} signal=${r.signal ?? 'none'}` +
        `${r.error ? ` error=${r.error}` : ''}\nstderr: ${r.stderr.trim()}`,
    );
  }
  return r.stdout.trim();
}

async function gitInit(cwd: string): Promise<void> {
  await git(cwd, ['init', '-q', '-b', 'main']);
  await git(cwd, ['config', 'user.email', 'test@example.invalid']);
  await git(cwd, ['config', 'user.name', 'test']);
  await git(cwd, ['config', 'commit.gpgsign', 'false']);
}

/** 跑登记工具（cwd 为夹具仓库），返回 { status, stdout, stderr } */
async function runTool(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const r = await runCommand(process.execPath, [CAND, ...args], cwd, env ? { env } : {});
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * 建立可登记的夹具仓库：
 *   src/index.ts（被跟踪源码）、package-lock.json、package.json（version 0.1.0-alpha.1）
 *   out/main/index.js 等构建产物（out/ 在 .gitignore 内）
 *   build-record.json（本次构建记录，含 sourceCommit / version / lockfileSha256 / out.files / buildId）
 *   candidate-fixture/win-unpacked/{OpenCodeThemeSwitcher.exe, resources/app.asar}
 *
 * 注意：工具默认根是**本仓库**，夹具场景一律传 `--root <夹具根>`，
 * 否则所有相对路径会解析到真实仓库（这是 P2 集成测试踩过的坑）。
 */
async function makeFixture(prefix: string): Promise<{
  root: string;
  record: string;
  candidateDir: string;
  manifest: string;
}> {
  const root = trackFixture(prefix);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const version = 1;\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.1.0-alpha.1' }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3 }, null, 2),
  );
  fs.writeFileSync(path.join(root, '.gitignore'), 'out/\ncandidate-*/\n');

  // 合成构建产物：out/**（进入 out 清单）
  const outDir = path.join(root, 'out');
  const outFiles: Record<string, Buffer> = {
    'out/main/index.js': Buffer.from('main'),
    'out/main/services/image-store.js': Buffer.from('store'),
    'out/core/theme/generate.js': Buffer.from('generate'),
    'out/core/theme/image-probe.js': Buffer.from('probe'),
  };
  for (const [rel, buf] of Object.entries(outFiles)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }

  // 候选目录（完整 win-unpacked 形状）
  const candidateDir = path.join(root, 'candidate-fixture', 'win-unpacked');
  fs.mkdirSync(path.join(candidateDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(candidateDir, 'OpenCodeThemeSwitcher.exe'), Buffer.alloc(256, 7));
  fs.writeFileSync(path.join(candidateDir, 'resources', 'app.asar'), Buffer.from('fake asar'));

  await gitInit(root);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-q', '-m', 'fixture init']);
  const sourceCommit = await git(root, ['rev-parse', 'HEAD']);

  // 构建记录：out 清单来自**夹具自己的 out 目录**（真实调用工具）
  const vr = requireCjs(VERIFY_RELEASE) as {
    outManifestOfDir: (d: string) => { files: Record<string, unknown> };
  };
  const outManifest = vr.outManifestOfDir(outDir);
  const record = {
    // R1：/2 = 登记前不可变事实（不含 register/verify:release）；策略版本必须与可信策略一致
    schema: 'build-record/2',
    policyVersion: 1,
    buildId: 'fixture-build-1',
    version: '0.1.0-alpha.1',
    sourceCommit,
    lockfileSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
    out: { fileCount: Object.keys(outManifest.files).length, files: outManifest.files },
    steps: [{ step: 'build', status: 'passed', exit: 0, seconds: 1 }],
  };
  const recordPath = path.join(root, 'build-record.json');
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

  return {
    root,
    record: recordPath,
    candidateDir,
    manifest: path.join(root, 'candidate-fixture', 'candidate-manifest.json'),
  };
}

/** 所有夹具调用都必须带 --root <夹具根> */
const REGISTER_ARGS = (f: {
  root: string;
  manifest: string;
  candidateDir: string;
  record: string;
}): string[] => [
  'register',
  '--root',
  f.root,
  '--manifest',
  f.manifest,
  '--candidate-dir',
  f.candidateDir,
  '--build-record',
  f.record,
  '--build-id',
  'fixture-build-1',
  '--pack-method',
  'electron-builder',
];

describe('P2 正例：小夹具真实注册 → 核验，Git 仍干净、HEAD 未变', () => {
  it('register 成功写入忽略目录内的 manifest，且不弄脏工作树、不改 HEAD', async () => {
    const f = await makeFixture('p2-ok-');
    const headBefore = await git(f.root, ['rev-parse', 'HEAD']);
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status, `register 应成功：${r.stderr}`).toBe(0);
    expect(fs.existsSync(f.manifest)).toBe(true);

    // 关键：登记后没有「已跟踪文件改动」、HEAD 未变（build-record.json 是豁免的生成产物，
    // 允许以 ?? 存在；正是它不能把源码判脏，才使「登记与源码冻结」不再自相矛盾）
    expect(await git(f.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(await git(f.root, ['rev-parse', 'HEAD'])).toBe(headBefore);

    // 登记的 sourceCommit 就是夹具 HEAD
    const m = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
    expect(m.schema).toBe('candidate-manifest/3');
    expect(m.sourceCommit).toBe(headBefore);
    expect(m.buildId).toBe('fixture-build-1');
    // 防回归：提交主题必须取自**夹具**（--root 目标），不是宿主仓库。
    // `ROOT` 由 applyRoot 设为 --root 目标，故此处应等于夹具的提交信息。
    expect(m.sourceCommitSubject).toBe('fixture init');
    expect(m.buildRecord.sha256).toBe(sha256(fs.readFileSync(f.record)));
    expect(Object.keys(m.out.files)).toHaveLength(4);

    // 只读核验通过
    const c = await runTool(f.root, ['check', '--root', f.root, '--manifest', f.manifest]);
    expect(c.status, `check 应通过：${c.stderr}${c.stdout}`).toBe(0);
    expect(await git(f.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });

  it('登记目标已存在时默认拒绝覆盖', async () => {
    const f = await makeFixture('p2-nooverwrite-');
    expect((await runTool(f.root, REGISTER_ARGS(f))).status).toBe(0);
    const again = await runTool(f.root, REGISTER_ARGS(f));
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('拒绝覆盖');
  });

  it('--force 才允许覆盖已有登记', async () => {
    const f = await makeFixture('p2-force-');
    expect((await runTool(f.root, REGISTER_ARGS(f))).status).toBe(0);
    expect((await runTool(f.root, [...REGISTER_ARGS(f), '--force'])).status).toBe(0);
  });
});

describe('P2 负例：任一冻结/来源问题都必须失败且不产出成功登记', () => {
  it('源码改脏 → 拒绝', async () => {
    const f = await makeFixture('p2-dirty-');
    fs.appendFileSync(path.join(f.root, 'src', 'index.ts'), '// dirty\n');
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/未提交改动/);
    expect(fs.existsSync(f.manifest)).toBe(false);
  });

  it('新增未跟踪源码/脚本 → 拒绝（不能统一忽略 ??）', async () => {
    const f = await makeFixture('p2-untracked-');
    fs.writeFileSync(path.join(f.root, 'src', 'sneaky.ts'), 'export const x = 1;\n');
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/未跟踪的源码\/脚本/);
    expect(fs.existsSync(f.manifest)).toBe(false);
  });

  it('未跟踪内容若在豁免路径（candidate-*/、handoff/）内 → 不阻断', async () => {
    const f = await makeFixture('p2-exempt-');
    fs.writeFileSync(path.join(f.root, 'handoff-note.txt'), 'x'); // 未跟踪但不在豁免列表 → 应阻断
    expect((await runTool(f.root, REGISTER_ARGS(f))).status).toBe(1);
    fs.rmSync(path.join(f.root, 'handoff-note.txt'));
    fs.mkdirSync(path.join(f.root, 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'handoff', 'note.txt'), 'x'); // handoff/ 豁免
    expect((await runTool(f.root, REGISTER_ARGS(f))).status).toBe(0);
  });

  it('Git 不可用（非仓库）→ 明确失败，不当作干净', async () => {
    // 必须在一个**不在任何 Git 仓库内**的目录执行：测试用安全临时根位于本仓库的
    // node_modules/.cache 下，git 会向上找到真实仓库，因此这里显式断言前置条件
    // （git rev-parse 失败），再用 GIT_DIR 指向不存在路径强制 Git 查询失败。
    const root = trackFixture('p2-nogit-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const candidateDir = path.join(root, 'candidate-x', 'win-unpacked');
    fs.mkdirSync(path.join(candidateDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(candidateDir, 'OpenCodeThemeSwitcher.exe'), 'e');
    fs.writeFileSync(path.join(candidateDir, 'resources', 'app.asar'), 'a');
    const record = path.join(root, 'build-record.json');
    fs.writeFileSync(
      record,
      JSON.stringify({ sourceCommit: 'a'.repeat(40), version: '0.1.0-alpha.1', out: { files: {} } }),
    );

    const args = [
      'register',
      '--root',
      root,
      '--manifest',
      path.join(root, 'candidate-x', 'candidate-manifest.json'),
      '--candidate-dir',
      candidateDir,
      '--build-record',
      record,
      '--build-id',
      'x',
      // S5：--pack-method 是必填项（缺参会在更早的入参校验处失败），
      // 本例要断言的是「Git 读不到时不当作干净」，故显式给出打包方式。
      '--pack-method',
      'electron-builder',
    ];
    const r = await runTool(root, args, {
      ...process.env,
      GIT_DIR: path.join(root, 'definitely-not-a-git-dir'),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/无法读取 Git 状态/);
  });

  it('缺少 --manifest → 明确失败（不回落根目录历史 manifest）', async () => {
    const f = await makeFixture('p2-nomanifest-');
    const r = await runTool(f.root, [
      'register',
      '--root',
      f.root,
      '--candidate-dir',
      f.candidateDir,
      '--build-record',
      f.record,
      '--build-id',
      'x',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/必须显式提供 --manifest/);
  });

  it('缺少构建记录 → 拒绝（不接受「旧 out 就代表刚构建」）', async () => {
    const f = await makeFixture('p2-norecord-');
    const r = await runTool(f.root, [
      'register',
      '--root',
      f.root,
      '--manifest',
      f.manifest,
      '--candidate-dir',
      f.candidateDir,
      // S5：--pack-method 必填，缺它会在更早的入参校验处失败、盖掉本例要断言的诊断
      '--pack-method',
      'electron-builder',
      '--build-id',
      'x',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/缺少 --build-record/);
  });

  it('S5：缺少 --pack-method → 拒绝（来源方式不能由工具替调用方猜测）', async () => {
    const f = await makeFixture('p2-nopackmethod-');
    // 刻意不传 --pack-method：旧实现会静默兜底为 manual-repack，把真实 builder 链
    // 登记成手工重封（并写 reproducibleBuild=false），来源元数据因此不真实。
    const r = await runTool(f.root, [
      'register',
      '--root',
      f.root,
      '--manifest',
      f.manifest,
      '--candidate-dir',
      f.candidateDir,
      '--build-record',
      f.record,
      '--build-id',
      'x',
    ]);
    expect(r.status, '缺 --pack-method 必须拒绝登记').toBe(1);
    expect(r.stderr + r.stdout).toMatch(/--pack-method/);
    expect(fs.existsSync(f.manifest), '拒绝时不得产出成功登记').toBe(false);
  });

  it('S5：非法 --pack-method → 拒绝（只认两种声明值）', async () => {
    const f = await makeFixture('p2-badpackmethod-');
    const r = await runTool(f.root, [...REGISTER_ARGS(f), '--pack-method', 'zip-by-hand', '--force']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/--pack-method/);
    expect(fs.existsSync(f.manifest)).toBe(false);
  });

  it('构建记录 sourceCommit 与 HEAD 不符（过期记录）→ 拒绝', async () => {
    const f = await makeFixture('p2-stale-record-');
    const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
    rec.sourceCommit = 'b'.repeat(40);
    fs.writeFileSync(f.record, JSON.stringify(rec, null, 2));
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/与当前 HEAD/);
  });

  it('构建记录锁文件 hash 不符 → 拒绝', async () => {
    const f = await makeFixture('p2-lock-mismatch-');
    const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
    rec.lockfileSha256 = 'c'.repeat(64);
    fs.writeFileSync(f.record, JSON.stringify(rec, null, 2));
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/锁文件 hash/);
  });

  it('当前 out 与构建记录不一致（登记的不是记录那次构建）→ 拒绝', async () => {
    const f = await makeFixture('p2-out-drift-');
    fs.writeFileSync(
      path.join(f.root, 'out', 'main', 'services', 'image-store.js'),
      Buffer.from('TAMPERED'),
    );
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/与构建记录不一致/);
  });

  it('空/旧格式构建记录 → 拒绝（R1：旧 /1 自引用记录不得入册）', async () => {
    const f = await makeFixture('p2-empty-record-');
    fs.writeFileSync(f.record, JSON.stringify({}, null, 2));
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/build-record\/2/);
    expect(fs.existsSync(f.manifest)).toBe(false);
  });

  it('build-record/1 旧记录 → 拒绝并点名自引用原因（R1）', async () => {
    const f = await makeFixture('p2-old-record-');
    const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
    rec.schema = 'build-record/1';
    delete rec.policyVersion;
    rec.steps = [
      ...rec.steps,
      { step: 'register', status: 'pending', exit: 0 },
      { step: 'verify:release', status: 'pending', exit: 0 },
    ];
    fs.writeFileSync(f.record, JSON.stringify(rec, null, 2));
    const r = await runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/build-record\/2/);
  });

  it('R2 负例：记录重复步骤 → 登记拒绝（Map 后项覆盖前项不再容忍）', async () => {
    const dup = await makeFixture('p2-dup-step-');
    const recDup = JSON.parse(fs.readFileSync(dup.record, 'utf8'));
    recDup.steps = [...recDup.steps, { step: 'build', status: 'passed', exit: 0 }];
    fs.writeFileSync(dup.record, JSON.stringify(recDup, null, 2));
    const rDup = await runTool(dup.root, REGISTER_ARGS(dup));
    expect(rDup.status).toBe(1);
    expect(rDup.stderr).toMatch(/步骤重复：build/);
  }, 120_000);

  it('R2 负例：步骤状态非法 → 登记拒绝（不得以缺字段隐含 passed）', async () => {
    const badStatus = await makeFixture('p2-bad-status-');
    const recBad = JSON.parse(fs.readFileSync(badStatus.record, 'utf8'));
    recBad.steps = recBad.steps.map((s: { step: string }) =>
      s.step === 'build' ? { ...s, status: 'ok' } : s,
    );
    fs.writeFileSync(badStatus.record, JSON.stringify(recBad, null, 2));
    const rBad = await runTool(badStatus.root, REGISTER_ARGS(badStatus));
    expect(rBad.status).toBe(1);
    expect(rBad.stderr).toMatch(/状态非法/);
  }, 120_000);

  it('R2 负例：测试注入环境 → 登记拒绝（mock 成功不得当作真实通过）', async () => {
    const injected = await makeFixture('p2-injected-');
    const recInj = JSON.parse(fs.readFileSync(injected.record, 'utf8'));
    recInj.testInjectedEnvironment = true;
    fs.writeFileSync(injected.record, JSON.stringify(recInj, null, 2));
    const rInj = await runTool(injected.root, REGISTER_ARGS(injected));
    expect(rInj.status).toBe(1);
    expect(rInj.stderr).toMatch(/测试注入环境/);
  }, 120_000);

  it('候选目录不存在完整候选 → 拒绝', async () => {
    const f = await makeFixture('p2-badcand-');
    const r = await runTool(f.root, [
      'register',
      '--root',
      f.root,
      '--manifest',
      f.manifest,
      '--candidate-dir',
      path.join(f.root, 'nope'),
      '--build-record',
      f.record,
      '--build-id',
      'x',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/不是完整 win-unpacked 候选/);
  });
});

describe('P4 A：worker 事件循环在异步等待期间保持可响应', () => {
  it('异步等待子进程时定时器持续触发，且不阻塞 IPC（最大延迟远小于 RPC 60s 上限）', async () => {
    const fixture = await makeFixture('p4-loop-');
    const probe = new EventLoopLagProbe();
    probe.start(25);

    // 期间连续跑多个真实子进程（git + 登记工具），全部异步等待
    const head = await git(fixture.root, ['rev-parse', 'HEAD']);
    await git(fixture.root, ['status', '--porcelain']);
    const reg = await runTool(fixture.root, REGISTER_ARGS(fixture));
    const chk = await runTool(fixture.root, [
      'check',
      '--root',
      fixture.root,
      '--manifest',
      fixture.manifest,
    ]);

    const { maxLagMs } = probe.stop();
    console.log(
      `[P4-A] 异步等待期间最大事件循环延迟 = ${maxLagMs}ms（RPC 上限 60000ms）`,
    );

    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(reg.status, `register 应成功：${reg.stderr}`).toBe(0);
    expect(chk.status, `check 应通过：${chk.stderr}${chk.stdout}`).toBe(0);
    // 不设业务性能硬阈值；只要求**未被同步阻塞到量级错误**：
    // 若仍是同步等待，事件循环会被子进程独占，最大延迟会逼近总耗时。
    expect(maxLagMs).toBeLessThan(5_000);
  });
});
