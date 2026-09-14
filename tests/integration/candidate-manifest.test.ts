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
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mkTestTmp } from '../fixtures/test-tmp';

const REPO = path.resolve(__dirname, '..', '..');
const CAND = path.join(REPO, 'tools', 'candidate-manifest.cjs');
const VERIFY_RELEASE = path.join(REPO, 'tools', 'verify-release.cjs');

// 工具是 CJS：用 createRequire 加载，避免 lint 禁用 require 规则
const requireCjs = createRequire(__filename);

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');

/** 在夹具目录里跑 git；失败抛错（测试要能看见） */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitInit(cwd: string): void {
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
  git(cwd, ['config', 'user.name', 'test']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
}

/** 跑工具（cwd 为夹具仓库，模拟在该仓库内的本地调用），返回 { status, stdout, stderr } */
function runTool(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath, [CAND, ...args],
    { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env } },
  );
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
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
function makeFixture(prefix: string): { root: string; record: string; candidateDir: string; manifest: string } {
  const root = mkTestTmp(prefix);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const version = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.0-alpha.1' }, null, 2));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }, null, 2));
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

  gitInit(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'fixture init']);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']);

  // 构建记录：out 清单来自**夹具自己的 out 目录**（真实调用工具）
  const vr = requireCjs(VERIFY_RELEASE) as { outManifestOfDir: (d: string) => { files: Record<string, unknown> } };
  const outManifest = vr.outManifestOfDir(outDir);
  const record = {
    schema: 'build-record/1',
    buildId: 'fixture-build-1',
    version: '0.1.0-alpha.1',
    sourceCommit,
    lockfileSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
    out: { fileCount: Object.keys(outManifest.files).length, files: outManifest.files },
    steps: [{ step: 'build', exit: 0 }],
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
const REGISTER_ARGS = (f: { root: string; manifest: string; candidateDir: string; record: string }) => [
  'register', '--root', f.root, '--manifest', f.manifest, '--candidate-dir', f.candidateDir,
  '--build-record', f.record, '--build-id', 'fixture-build-1', '--pack-method', 'electron-builder',
];

describe('P2 正例：小夹具真实注册 → 核验，Git 仍干净、HEAD 未变', () => {
  it('register 成功写入忽略目录内的 manifest，且不弄脏工作树、不改 HEAD', () => {
    const f = makeFixture('p2-ok-');
    const headBefore = git(f.root, ['rev-parse', 'HEAD'])
    const r = runTool(f.root, REGISTER_ARGS(f));
    expect(r.status, `register 应成功：${r.stderr}`).toBe(0);
    expect(fs.existsSync(f.manifest)).toBe(true);

    // 关键：登记后没有「已跟踪文件改动」、HEAD 未变（build-record.json 是豁免的生成产物，
    // 允许以 ?? 存在；正是它不能把源码判脏，才使「登记与源码冻结」不再自相矛盾）
    expect(git(f.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(headBefore);

    // 登记的 sourceCommit 就是夹具 HEAD
    const m = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
    expect(m.schema).toBe('candidate-manifest/3');
    expect(m.sourceCommit).toBe(headBefore);
    expect(m.buildId).toBe('fixture-build-1');
    expect(m.buildRecord.sha256).toBe(sha256(fs.readFileSync(f.record)));
    expect(Object.keys(m.out.files)).toHaveLength(4);

    // 只读核验通过
    const c = runTool(f.root, ['check', '--root', f.root, '--manifest', f.manifest]);
    expect(c.status, `check 应通过：${c.stderr}${c.stdout}`).toBe(0);
    expect(git(f.root, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });

  it('登记目标已存在时默认拒绝覆盖', () => {
    const f = makeFixture('p2-nooverwrite-');
    expect(runTool(f.root, REGISTER_ARGS(f)).status).toBe(0);
    const again = runTool(f.root, REGISTER_ARGS(f));
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('拒绝覆盖');
  });

  it('--force 才允许覆盖已有登记', () => {
    const f = makeFixture('p2-force-');
    expect(runTool(f.root, REGISTER_ARGS(f)).status).toBe(0);
    expect(runTool(f.root, [...REGISTER_ARGS(f), '--force']).status).toBe(0);
  });
});

describe('P2 负例：任一冻结/来源问题都必须失败且不产出成功登记', () => {
  it('源码改脏 → 拒绝', () => {
    const f = makeFixture('p2-dirty-');
    fs.appendFileSync(path.join(f.root, 'src', 'index.ts'), '// dirty\n');
    const r = runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/未提交改动/);
    expect(fs.existsSync(f.manifest)).toBe(false);
  });

  it('新增未跟踪源码/脚本 → 拒绝（不能统一忽略 ??）', () => {
    const f = makeFixture('p2-untracked-');
    fs.writeFileSync(path.join(f.root, 'src', 'sneaky.ts'), 'export const x = 1;\n');
    const r = runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/未跟踪的源码\/脚本/);
    expect(fs.existsSync(f.manifest)).toBe(false);
  });

  it('未跟踪内容若在豁免路径（candidate-*/、handoff/）内 → 不阻断', () => {
    const f = makeFixture('p2-exempt-');
    fs.writeFileSync(path.join(f.root, 'handoff-note.txt'), 'x'); // 未跟踪但不在豁免列表 → 应阻断
    expect(runTool(f.root, REGISTER_ARGS(f)).status).toBe(1);
    fs.rmSync(path.join(f.root, 'handoff-note.txt'));
    fs.mkdirSync(path.join(f.root, 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'handoff', 'note.txt'), 'x'); // handoff/ 豁免
    expect(runTool(f.root, REGISTER_ARGS(f)).status).toBe(0);
  });

  it('Git 不可用（非仓库）→ 明确失败，不当作干净', () => {
    // 必须在一个**不在任何 Git 仓库内**的目录执行：测试用安全临时根位于本仓库的
    // node_modules/.cache 下，git 会向上找到真实仓库，因此这里显式断言前置条件
    // （git rev-parse 失败），再用 GIT_DIR 指向不存在路径强制 Git 查询失败。
    const root = mkTestTmp('p2-nogit-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const candidateDir = path.join(root, 'candidate-x', 'win-unpacked');
    fs.mkdirSync(path.join(candidateDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(candidateDir, 'OpenCodeThemeSwitcher.exe'), 'e');
    fs.writeFileSync(path.join(candidateDir, 'resources', 'app.asar'), 'a');
    const record = path.join(root, 'build-record.json');
    fs.writeFileSync(record, JSON.stringify({ sourceCommit: 'a'.repeat(40), version: '0.1.0-alpha.1', out: { files: {} } }));

    const args = [
      CAND, 'register', '--root', root, '--manifest', path.join(root, 'candidate-x', 'candidate-manifest.json'),
      '--candidate-dir', candidateDir, '--build-record', record, '--build-id', 'x',
    ];
    const r = spawnSync(process.execPath, args, {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_DIR: path.join(root, 'definitely-not-a-git-dir') },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/无法读取 Git 状态/);
  });

  it('缺少 --manifest → 明确失败（不回落根目录历史 manifest）', () => {
    const f = makeFixture('p2-nomanifest-');
    const r = runTool(f.root, [
      'register', '--root', f.root, '--candidate-dir', f.candidateDir, '--build-record', f.record, '--build-id', 'x',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/必须显式提供 --manifest/);
  });

  it('缺少构建记录 → 拒绝（不接受「旧 out 就代表刚构建」）', () => {
    const f = makeFixture('p2-norecord-');
    const r = runTool(f.root, [
      'register', '--root', f.root, '--manifest', f.manifest, '--candidate-dir', f.candidateDir, '--build-id', 'x',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/缺少 --build-record/);
  });

  it('构建记录 sourceCommit 与 HEAD 不符（过期记录）→ 拒绝', () => {
    const f = makeFixture('p2-stale-record-');
    const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
    rec.sourceCommit = 'b'.repeat(40);
    fs.writeFileSync(f.record, JSON.stringify(rec, null, 2));
    const r = runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/与当前 HEAD/);
  });

  it('构建记录锁文件 hash 不符 → 拒绝', () => {
    const f = makeFixture('p2-lock-mismatch-');
    const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
    rec.lockfileSha256 = 'c'.repeat(64);
    fs.writeFileSync(f.record, JSON.stringify(rec, null, 2));
    const r = runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/锁文件 hash/);
  });

  it('当前 out 与构建记录不一致（登记的不是记录那次构建）→ 拒绝', () => {
    const f = makeFixture('p2-out-drift-');
    fs.writeFileSync(path.join(f.root, 'out', 'main', 'services', 'image-store.js'), Buffer.from('TAMPERED'));
    const r = runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/与构建记录不一致/);
  });

  it('空/旧格式构建记录 → 拒绝', () => {
    const f = makeFixture('p2-empty-record-');
    fs.writeFileSync(f.record, JSON.stringify({}, null, 2));
    const r = runTool(f.root, REGISTER_ARGS(f));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/缺少必需字段/);
  });

  it('候选目录不存在完整候选 → 拒绝', () => {
    const f = makeFixture('p2-badcand-');
    const r = runTool(f.root, [
      'register', '--root', f.root, '--manifest', f.manifest, '--candidate-dir', path.join(f.root, 'nope'),
      '--build-record', f.record, '--build-id', 'x',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/不是完整 win-unpacked 候选/);
  });
});
