/**
 * 基线门禁差异分类（drift-gate-r2 Y1，基线 baseline-drift B2）。
 *
 * classifyDrift 是纯函数：**放行判据与 discover 的 structural 通道完全同源** ——
 * 只看 `structure.compatible`（结构验证无 FAIL）。版本号陌生、差异量级、
 * unpacked 集合增减都只作证据留痕，不再是闸门（R2 之前它们参与否决，
 * 与 S 轮「版本陌生不否决」冲突，累积出真机 1081 拒绝缺陷）。
 * 端到端放行链在 tests/integration/baseline-drift.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASELINE_FILENAME,
  REBASELINE_DRIFT_MIN_COUNT,
  REBASELINE_DRIFT_RATIO,
  archiveCurrentBaselineFile,
  classifyDrift,
  countDrift,
  describeDrift,
  readBaselineFile,
  writeBaselineFile,
  type BaselineDrift,
  type DriftClassifyInput,
  type DriftConditionResult,
  type EntryBaseline,
} from '../../src/core/patch/archive-verify';
import type {
  CompatCheck,
  CompatReport,
  CompatStatus,
} from '../../src/core/patch/compat-check';
import { testTmpRoot } from '../fixtures/test-tmp';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(testTmpRoot(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 3 });
});

function changedDrift(n: number, withPackageJson = false): BaselineDrift {
  const changed: BaselineDrift['changed'] = Array.from({ length: n }, (_, i) => ({
    path: withPackageJson && i === 0 ? 'package.json' : `node_modules/dep${i}/index.js`,
    why: 'content' as const,
    baselineSize: 10,
    currentSize: 10,
  }));
  return { changed, missing: [], added: [], kindChanged: [] };
}

/** 造一份结构验证报告：默认锚点/变更集合全 PASS（compatible=true） */
function structureReport(
  over: { anchor?: CompatStatus; changeSet?: CompatStatus } = {},
): CompatReport {
  const anchor = over.anchor ?? 'PASS';
  const changeSet = over.changeSet ?? 'PASS';
  const checks: CompatCheck[] = [
    {
      key: 'anchor',
      name: '注入锚点',
      status: anchor,
      basis: '统计锚点出现次数',
      detail: anchor === 'PASS' ? '恰好 1 次，注入位置唯一' : '0 次：HTML 结构已变，现行注入方案不适用',
    },
    {
      key: 'changeSet',
      name: '变更集合归属',
      status: changeSet,
      basis: '查 cssFile/imageFile + 归属识别',
      detail: changeSet === 'PASS' ? '两文件均不存在（干净）' : '已存在且无法确认归属，按第三方占用处理',
    },
    {
      key: 'unpacked',
      name: 'unpacked 完整性（信息项）',
      status: 'PASS',
      basis: 'unpacked 目录存在性',
      detail: '目录在位',
    },
  ];
  const failedNames = checks.filter((c) => c.status === 'FAIL').map((c) => c.name);
  return { compatible: failedNames.length === 0, checks, failedNames };
}

/** 全通过态的底座：逐条测试只翻转自己要验证的那个要素 */
function passing(over: Partial<DriftClassifyInput> = {}): DriftClassifyInput {
  return {
    drift: changedDrift(200),
    baselineCount: 400,
    archiveVersion: '1.18.31',
    baselineVersion: '1.18.29',
    structure: structureReport(),
    currentUnpacked: ['node_modules/native/index.node'],
    baselineUnpacked: ['node_modules/native/index.node'],
    ...over,
  };
}

function cond(v: ReturnType<typeof classifyDrift>, key: DriftConditionResult['key']) {
  return v.conditions.find((c) => c.key === key);
}

describe('classifyDrift：放行判据与 structural 通道同源（结构无 FAIL 即 injectable）', () => {
  it('结构可行 → injectable，且各判据逐一留痕', () => {
    const v = classifyDrift(passing());
    expect(v.verdict).toBe('injectable');
    expect(v.conditions.map((c) => c.key)).toEqual([
      'versionChanged',
      'anchorUnique',
      'changeSetClean',
      'driftScale',
      'unpackedSet',
    ]);
    expect(v.conditions.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('版本号相同（非更新）→ 版本不再是闸门，结构可行仍放行', () => {
    const v = classifyDrift(passing({ baselineVersion: '1.18.31' }));
    expect(v.verdict).toBe('injectable');
    // 版本证据仍如实记录为「相同」
    expect(cond(v, 'versionChanged')?.passed).toBe(false);
  });

  it('当前归档读不到 version → 不影响放行，仅作提示', () => {
    const v = classifyDrift(passing({ archiveVersion: null }));
    expect(v.verdict).toBe('injectable');
    expect(cond(v, 'versionChanged')?.passed).toBe(false);
  });

  it('旧基线无版本记录（legacy 且快照回推失败）但结构可行 → 放行', () => {
    const v = classifyDrift(passing({ baselineVersion: null }));
    expect(v.verdict).toBe('injectable');
    expect(cond(v, 'versionChanged')?.passed).toBe(false);
  });

  it('锚点消失/变多（结构 FAIL）→ 拒绝', () => {
    const v = classifyDrift(passing({ structure: structureReport({ anchor: 'FAIL' }) }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'anchorUnique')?.passed).toBe(false);
  });

  it('变更集合被第三方占用（结构 FAIL）→ 拒绝', () => {
    const v = classifyDrift(passing({ structure: structureReport({ changeSet: 'FAIL' }) }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'changeSetClean')?.passed).toBe(false);
  });

  it('真机 1081 场景钉子：未知版本 + unpacked 集合变化 + 锚点在 + 变更集合净 → 放行', () => {
    const v = classifyDrift(
      passing({
        archiveVersion: '1.18.99',
        baselineVersion: null,
        currentUnpacked: [],
      }),
    );
    expect(v.verdict).toBe('injectable');
    // 证据如实留痕：版本不可比、unpacked 集合不同——但不否决
    expect(cond(v, 'versionChanged')?.passed).toBe(false);
    expect(cond(v, 'unpackedSet')?.passed).toBe(false);
    expect(cond(v, 'anchorUnique')?.passed).toBe(true);
    expect(cond(v, 'changeSetClean')?.passed).toBe(true);
  });

  it('unpacked 路径集合数量变化 → 证据为否，但不否决', () => {
    const v = classifyDrift(passing({ currentUnpacked: [] }));
    expect(v.verdict).toBe('injectable');
    expect(cond(v, 'unpackedSet')?.passed).toBe(false);
  });

  it('unpacked 集合路径不同但数量相同 → 证据为否，但不否决', () => {
    const v = classifyDrift(passing({ currentUnpacked: ['node_modules/other/x.node'] }));
    expect(v.verdict).toBe('injectable');
    expect(cond(v, 'unpackedSet')?.passed).toBe(false);
  });

  it('unpacked 集合只差顺序 → 视为一致', () => {
    const v = classifyDrift(
      passing({
        currentUnpacked: ['b/x.node', 'a/y.node'],
        baselineUnpacked: ['a/y.node', 'b/x.node'],
      }),
    );
    expect(cond(v, 'unpackedSet')?.passed).toBe(true);
  });

  it('基线无 unpacked 记录（null）→ 不否决，仅作提示', () => {
    const v = classifyDrift(passing({ baselineUnpacked: null }));
    expect(v.verdict).toBe('injectable');
    expect(cond(v, 'unpackedSet')?.passed).toBe(false);
  });
});

describe('classifyDrift：差异规模是证据不是闸门', () => {
  it('阈值常量固定：50% 与 100 条（证据口径，改动必须先过评审）', () => {
    expect(REBASELINE_DRIFT_RATIO).toBe(0.5);
    expect(REBASELINE_DRIFT_MIN_COUNT).toBe(100);
  });

  it('差异 49%（基线 100 条）→ 证据为否，但结构可行仍放行', () => {
    const v = classifyDrift(passing({ drift: changedDrift(49), baselineCount: 100 }));
    expect(v.verdict).toBe('injectable');
    expect(cond(v, 'driftScale')?.passed).toBe(false);
  });

  it('差异 51%（基线 100 条）→ 证据为是', () => {
    const v = classifyDrift(passing({ drift: changedDrift(51), baselineCount: 100 }));
    expect(v.verdict).toBe('injectable');
    expect(cond(v, 'driftScale')?.passed).toBe(true);
  });

  it('package.json 内容变化且 ≥100 条（不足 50%）→ 第二条通道证据为是', () => {
    const v = classifyDrift(passing({ drift: changedDrift(100, true), baselineCount: 1000 }));
    expect(cond(v, 'driftScale')?.passed).toBe(true);
  });

  it('≥100 条但 package.json 未变 → 两条通道都不过，证据为否', () => {
    const v = classifyDrift(passing({ drift: changedDrift(100), baselineCount: 1000 }));
    expect(cond(v, 'driftScale')?.passed).toBe(false);
  });

  it('package.json 变化但只有 99 条 → 第二条通道未达下限，证据为否', () => {
    const v = classifyDrift(passing({ drift: changedDrift(99, true), baselineCount: 1000 }));
    expect(cond(v, 'driftScale')?.passed).toBe(false);
  });

  it('package.json 出现在 missing 而非 changed → 不算「内容变化」', () => {
    const drift = changedDrift(99, true);
    drift.changed.shift();
    drift.missing.push('package.json');
    const v = classifyDrift(passing({ drift, baselineCount: 1000 }));
    expect(cond(v, 'driftScale')?.passed).toBe(false);
  });

  it('四类差异都计入规模（changed+missing+added+kindChanged）', () => {
    const drift = changedDrift(20);
    drift.missing.push('a.js');
    drift.added.push('b.js');
    drift.kindChanged.push('c.js');
    expect(countDrift(drift)).toBe(23);
    expect(cond(classifyDrift(passing({ drift, baselineCount: 40 })), 'driftScale')?.passed).toBe(
      true,
    );
  });
});

describe('describeDrift：明细口径与旧拒绝文案兼容', () => {
  it('逐条形态与既有断言口径一致（大小/内容/缺失/形态/新增）', () => {
    const drift: BaselineDrift = {
      changed: [
        { path: 'p1.js', why: 'size', baselineSize: 3, currentSize: 5 },
        { path: 'p2.js', why: 'content', baselineSize: 3, currentSize: 3 },
      ],
      missing: ['p3.js'],
      added: ['p4.js'],
      kindChanged: ['p5.js'],
    };
    const lines = describeDrift(drift);
    expect(lines[0]).toContain('大小 5，基线 3');
    expect(lines[1]).toContain('内容与首次接管时不同');
    expect(lines[2]).toContain('基线里有，当前归档缺失');
    expect(lines[3]).toContain('当前变成了 unpacked/link');
    expect(lines[4]).toContain('当前归档新增');
  });
});

function entry(path: string, sha = 'ab'): EntryBaseline {
  return { path, size: 10, sha256: sha.repeat(32).slice(0, 64), unpacked: false };
}

describe('基线文件持久化：v2 信封与旧格式兼容', () => {
  it('v2 写入后读回：元数据（version/fingerprint/unpackedPaths）与条目一致', async () => {
    const dir = tmp('ots-bl-');
    const entries = new Map([
      ['package.json', entry('package.json')],
      ['out/main/index.js', entry('out/main/index.js', 'cd')],
    ]);
    const meta = { version: '1.18.31', fingerprint: 'f'.repeat(64), unpackedPaths: ['n/a.node'] };
    const w = await writeBaselineFile(dir, entries, meta);
    expect(w.success).toBe(true);
    const r = await readBaselineFile(dir);
    expect(r.success).toBe(true);
    if (!r.success || !r.data) return;
    expect(r.data.meta).toEqual(meta);
    expect([...r.data.entries.keys()].sort()).toEqual(['out/main/index.js', 'package.json']);
    // 落盘是 {schema:2,...} 信封而不是裸数组
    const raw = JSON.parse(fs.readFileSync(path.join(dir, BASELINE_FILENAME), 'utf8'));
    expect(raw.schema).toBe(2);
  });

  it('旧格式（裸数组）读取兼容：meta 为 null，条目不丢', async () => {
    const dir = tmp('ots-bl-');
    fs.writeFileSync(
      path.join(dir, BASELINE_FILENAME),
      JSON.stringify([entry('package.json'), entry('x.js', 'ef')]),
      'utf8',
    );
    const r = await readBaselineFile(dir);
    expect(r.success).toBe(true);
    if (!r.success || !r.data) return;
    expect(r.data.meta).toBeNull();
    expect(r.data.entries.size).toBe(2);
  });

  it('基线文件不存在 → 读回 null（首次接管分支的入口条件）', async () => {
    const r = await readBaselineFile(tmp('ots-bl-'));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toBeNull();
  });

  it('无法识别的信封（schema≠2）→ 按无基线处理，不带病放行', async () => {
    const dir = tmp('ots-bl-');
    fs.writeFileSync(
      path.join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 99, entries: [entry('a')] }),
      'utf8',
    );
    const r = await readBaselineFile(dir);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toBeNull();
  });
});

describe('旧基线序号归档：永不覆盖删除', () => {
  it('baseline.json 按 v1→v2 递增归档，已有序号不被复用', async () => {
    const dir = tmp('ots-bl-');
    fs.writeFileSync(path.join(dir, BASELINE_FILENAME), '[]', 'utf8');
    const first = await archiveCurrentBaselineFile(dir);
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data).toBe(1);
    expect(fs.existsSync(path.join(dir, 'baseline.v1.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, BASELINE_FILENAME))).toBe(false);

    fs.writeFileSync(path.join(dir, BASELINE_FILENAME), '[]', 'utf8');
    fs.writeFileSync(path.join(dir, 'baseline.v7.json'), '[]', 'utf8');
    const second = await archiveCurrentBaselineFile(dir);
    expect(second.success).toBe(true);
    if (!second.success) return;
    // 已占用到 v7 → 下一个必须是 v8，绝不覆盖既有序号
    expect(second.data).toBe(8);
    expect(fs.existsSync(path.join(dir, 'baseline.v8.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'baseline.v7.json'))).toBe(true);
  });
});
