/**
 * 当前候选入口一致性核对（tools/doc-candidate-entry.cjs）单元测试 —— 复审 F1。
 *
 * F1 的成因是「文档里的当前候选靠人工抄写，重封后必然滞后」。
 * 这一组用例锁住的是**这个核对器真的能抓到漂移**，而不是只跑通正例：
 *
 *   1. 正例：文档块 / manifest / 磁盘三方一致 → 通过；
 *   2. 文档块里的哈希被改动 → 必须失败（文档漂移）；
 *   3. manifest 登记的哈希与磁盘不符 → 必须失败（登记漂移，磁盘才是被核验对象）；
 *   4. 缺少产物文件 → 必须失败；
 *   5. 出现两个候选块 → 必须失败（入口必须唯一）；
 *   6. 某份文档没跟上 buildId → 必须失败（重封后只更新一处）；
 *   7. 哈希只从文档抄、不去实算 → 算不上核对：注入的 sha256File 必须被真的调用。
 *
 * 夹具在临时目录内自建（小文件），不触碰真实候选产物。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mkTestTmp } from '../fixtures/test-tmp';

const require_ = createRequire(import.meta.url);
const tool = require_('../../tools/doc-candidate-entry.cjs') as {
  BEGIN: string;
  END: string;
  FIELDS: string[];
  BLOCK_DOCS: string[];
  entryFromManifest: (
    manifestPath: string,
    opts?: { root?: string; sha256File?: (p: string) => string },
  ) => { entry: Record<string, string> | null; problems: string[] };
  renderEntryBlock: (e: Record<string, string>) => string;
  parseEntryBlocks: (t: string) => { entries: Record<string, string>[]; problems: string[] };
  diffEntry: (a: Record<string, string>, b: Record<string, string>) => string[];
  checkDocs: (docs: string[], e: Record<string, string>, opts?: { root?: string }) => string[];
};

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }
});

const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

interface Fixture {
  root: string;
  manifestRel: string;
  entry: Record<string, string>;
}

/**
 * 造一份「manifest + 磁盘产物 + 文档」都自洽的小夹具。
 * 只有 release-checklist.md 带机器块，其余文档只带 buildId —— 与仓库约定一致。
 */
function makeFixture(opts: { diskTamper?: string } = {}): Fixture {
  const root = mkTestTmp('ots-doc-entry-');
  tmpDirs.push(root);

  const buildId = '20260917000000-abcdef0-123456';
  const candidateDir = `candidate-${buildId}/win-unpacked`;
  const zipRel = `candidate-${buildId}.zip`;

  const write = (rel: string, content: string) => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  write('src/app.js', 'console.log(1);\n');
  const exeRel = `${candidateDir}/OpenCodeThemeSwitcher.exe`;
  const asarRel = `${candidateDir}/resources/app.asar`;
  write(exeRel, 'MZ-fake-exe');
  write(asarRel, 'asar-fake-bytes');
  write(zipRel, 'zip-fake-bytes');

  // diskTamper：写入后篡改文件内容，模拟「产物被换掉」
  if (opts.diskTamper) write(opts.diskTamper, 'TAMPERED');

  const hashes = {
    zip: sha(path.join(root, ...zipRel.split('/'))),
    exe: sha(path.join(root, ...exeRel.split('/'))),
    'app.asar': sha(path.join(root, ...asarRel.split('/'))),
  };

  const manifestRel = `${candidateDir}/candidate-manifest.json`;
  const manifest = {
    schema: 'candidate-manifest/3',
    version: '0.1.0-alpha.1',
    buildId,
    sourceCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    packMethod: 'electron-builder',
    candidateDir,
    zip: zipRel,
    hashes,
  };
  write(manifestRel, JSON.stringify(manifest, null, 2));

  const { entry } = tool.entryFromManifest(manifestRel, { root });
  if (!entry) throw new Error('夹具自检失败：entryFromManifest 未返回条目');

  const block = tool.renderEntryBlock(entry);
  write('docs/release-checklist.md', `# 交付清单\n\n${block}\n\n正文。\n`);
  write('docs/alpha-acceptance.md', `# 验收\n\n当前候选 buildId ${buildId}。\n`);
  write('README.md', `# README\n\n当前候选 buildId ${buildId}。\n`);

  return { root, manifestRel, entry };
}

const DEFAULT_DOCS = ['README.md', 'docs/release-checklist.md', 'docs/alpha-acceptance.md'];

describe('doc-candidate-entry：条目推导', () => {
  it('从 manifest 加磁盘实算得到条目，且字段齐全', () => {
    const f = makeFixture();
    const { entry, problems } = tool.entryFromManifest(f.manifestRel, { root: f.root });
    expect(problems).toEqual([]);
    expect(entry).not.toBeNull();
    for (const field of tool.FIELDS) expect(entry![field]).toBeTruthy();
    expect(entry!.buildId).toBe(f.entry.buildId);
    expect(entry!.zip).toBe(f.entry.zip);
  });

  it('哈希来自实算，而不是照抄 manifest 登记值', () => {
    const f = makeFixture();
    // 篡改磁盘上的 zip：实算值必须随之改变，从而与登记不符
    const abs = path.join(f.root, ...f.entry.zip.split('/'));
    fs.writeFileSync(abs, 'zip-fake-bytes-CHANGED');
    const { entry, problems } = tool.entryFromManifest(f.manifestRel, { root: f.root });
    expect(entry!.zipSha256).not.toBe(f.entry.zipSha256);
    expect(problems.join('\n')).toContain('zipSha256');
  });

  it('注入的 sha256File 必须真的被调用（否则不算实算）', () => {
    const f = makeFixture();
    const seen: string[] = [];
    const { problems } = tool.entryFromManifest(f.manifestRel, {
      root: f.root,
      sha256File: (p) => {
        seen.push(path.basename(p));
        return sha(p);
      },
    });
    expect(problems).toEqual([]);
    expect(seen).toContain(path.basename(f.entry.zip));
    expect(seen).toContain('OpenCodeThemeSwitcher.exe');
    expect(seen).toContain('app.asar');
  });

  it('缺少产物文件时失败，而不是把空哈希当成通过', () => {
    const f = makeFixture();
    fs.rmSync(path.join(f.root, ...f.entry.zip.split('/')), { force: true });
    const { problems } = tool.entryFromManifest(f.manifestRel, { root: f.root });
    expect(problems.join('\n')).toContain('缺少产物');
  });
});

describe('doc-candidate-entry：文档核对', () => {
  it('正例：文档块、manifest、磁盘三方一致时通过', () => {
    const f = makeFixture();
    expect(tool.checkDocs(DEFAULT_DOCS, f.entry, { root: f.root })).toEqual([]);
  });

  it('文档块里的哈希被改动即失败（F1 的直接症状）', () => {
    const f = makeFixture();
    const docRel = 'docs/release-checklist.md';
    const abs = path.join(f.root, ...docRel.split('/'));
    const tampered = fs
      .readFileSync(abs, 'utf8')
      .replace(f.entry.zipSha256, 'deadbeef'.repeat(8));
    fs.writeFileSync(abs, tampered);
    const problems = tool.checkDocs(DEFAULT_DOCS, f.entry, { root: f.root });
    expect(problems.join('\n')).toContain('zipSha256 不一致');
  });

  it('文档里出现两个候选块即失败（入口必须唯一）', () => {
    const f = makeFixture();
    const docRel = 'docs/release-checklist.md';
    const abs = path.join(f.root, ...docRel.split('/'));
    const block = tool.renderEntryBlock(f.entry);
    fs.writeFileSync(abs, `# 交付清单\n\n${block}\n\n旧的也留着：\n\n${block}\n`);
    const problems = tool.checkDocs(DEFAULT_DOCS, f.entry, { root: f.root });
    expect(problems.join('\n')).toContain('入口必须唯一');
  });

  it('某份文档没跟上 buildId 即失败（重封后只更新一处）', () => {
    const f = makeFixture();
    const rel = 'docs/alpha-acceptance.md';
    const abs = path.join(f.root, ...rel.split('/'));
    fs.writeFileSync(abs, '# 验收\n\nbuildId 20260901000000-oldold-000000。\n');
    const problems = tool.checkDocs(DEFAULT_DOCS, f.entry, { root: f.root });
    expect(problems.join('\n')).toContain('未出现当前 buildId');
  });

  it('缺少候选块即失败，不会因为「文档存在」就放行', () => {
    const f = makeFixture();
    const rel = 'docs/release-checklist.md';
    const abs = path.join(f.root, ...rel.split('/'));
    fs.writeFileSync(abs, `# 交付清单\n\nbuildId ${f.entry.buildId}\n\n（忘了带块）\n`);
    const problems = tool.checkDocs(DEFAULT_DOCS, f.entry, { root: f.root });
    expect(problems.join('\n')).toContain('缺少「当前候选」机器块');
  });

  it('块缺结束标记时失败，不会静默截断', () => {
    const { problems } = tool.parseEntryBlocks(`${tool.BEGIN}\nbuildId: x\n`);
    expect(problems.join('\n')).toContain('缺少结束标记');
  });

  it('块缺字段时失败', () => {
    const { problems } = tool.parseEntryBlocks(`${tool.BEGIN}\nbuildId: x\n${tool.END}`);
    expect(problems.join('\n')).toContain('缺少字段');
  });
});

describe('doc-candidate-entry：与仓库当前状态一致', () => {
  /**
   * 关键点：**manifest 路径从文档块自身读出来**，不在测试里写死 buildId。
   * 否则每次重封都要改测试，反而制造新的漂移点。
   * 于是这条用例的语义是：
   *   「文档自称的当前候选，必须真的与它所指向的 manifest 及磁盘产物一致」。
   */
  it('仓库文档里自称的当前候选，与它指向的 manifest/磁盘一致', () => {
    const root = path.resolve(__dirname, '..', '..');
    const docRel = 'docs/release-checklist.md';
    const abs = path.join(root, ...docRel.split('/'));
    if (!fs.existsSync(abs)) return;

    const { entries, problems } = tool.parseEntryBlocks(fs.readFileSync(abs, 'utf8'));
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1); // 入口唯一

    const declared = entries[0];
    const manifestRel = declared.manifest;
    expect(
      fs.existsSync(path.join(root, ...manifestRel.split('/'))),
      `文档声明的 manifest 不存在：${manifestRel}`,
    ).toBe(true);

    const { entry, problems: deriveProblems } = tool.entryFromManifest(manifestRel, { root });
    expect(deriveProblems).toEqual([]);
    // 文档块 == manifest + 磁盘实算
    expect(tool.diffEntry(entry!, declared)).toEqual([]);

    // 另外两份文档必须跟上同一个 buildId（重封只更新一处的典型漂移）
    for (const rel of ['README.md', 'docs/alpha-acceptance.md']) {
      const p = path.join(root, ...rel.split('/'));
      if (!fs.existsSync(p)) continue;
      expect(
        fs.readFileSync(p, 'utf8').includes(declared.buildId),
        `${rel} 未跟上 buildId=${declared.buildId}`,
      ).toBe(true);
    }
  });
});
