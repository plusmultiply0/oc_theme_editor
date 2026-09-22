/**
 * 基线门禁差异分类（baseline-drift B2）。
 *
 * classifyDrift 是纯函数：五条件缺一不可（宁拒勿纵），这里把每条判据
 * 单独打穿（其余条件全给通过态），再加阈值边界 49%/51% 与常量固定。
 * 另覆盖基线文件 v2 信封 / 旧数组格式兼容与旧基线序号归档（永不覆盖删除）。
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

/** 全通过态的底座：逐条测试只翻转自己要验证的那个条件 */
function passing(over: Partial<DriftClassifyInput> = {}): DriftClassifyInput {
  return {
    drift: changedDrift(200),
    baselineCount: 400,
    archiveVersion: '1.18.31',
    baselineVersion: '1.18.29',
    anchorUnique: true,
    changeSetClean: true,
    currentUnpacked: ['node_modules/native/index.node'],
    baselineUnpacked: ['node_modules/native/index.node'],
    ...over,
  };
}

function cond(v: ReturnType<typeof classifyDrift>, key: DriftConditionResult['key']) {
  return v.conditions.find((c) => c.key === key);
}

describe('classifyDrift：五条件缺一不可', () => {
  it('全部满足 → official-update，且五条件逐一留痕', () => {
    const v = classifyDrift(passing());
    expect(v.verdict).toBe('official-update');
    expect(v.conditions.map((c) => c.key)).toEqual([
      'versionChanged',
      'anchorUnique',
      'changeSetClean',
      'driftScale',
      'unpackedSet',
    ]);
    expect(v.conditions.every((c) => c.passed)).toBe(true);
    expect(v.conditions.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('版本号相同（非更新）→ suspicious，仅 versionChanged 不过', () => {
    const v = classifyDrift(passing({ baselineVersion: '1.18.31' }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'versionChanged')?.passed).toBe(false);
    expect(v.conditions.filter((c) => !c.passed)).toHaveLength(1);
  });

  it('当前归档读不到 version → 不可证明，按可疑拒绝', () => {
    const v = classifyDrift(passing({ archiveVersion: null }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'versionChanged')?.passed).toBe(false);
  });

  it('旧基线无版本记录（legacy 且快照回推失败）→ 不可证明，按可疑拒绝', () => {
    const v = classifyDrift(passing({ baselineVersion: null }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'versionChanged')?.passed).toBe(false);
  });

  it('锚点消失/变多 → 哪怕版本变了也拒绝', () => {
    const v = classifyDrift(passing({ anchorUnique: false }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'anchorUnique')?.passed).toBe(false);
  });

  it('变更集合被第三方占用 → 拒绝', () => {
    const v = classifyDrift(passing({ changeSetClean: false }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'changeSetClean')?.passed).toBe(false);
  });

  it('unpacked 路径集合数量变化 → 拒绝（原生模块结构不稳）', () => {
    const v = classifyDrift(passing({ currentUnpacked: [] }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'unpackedSet')?.passed).toBe(false);
  });

  it('unpacked 集合路径不同但数量相同 → 仍拒绝', () => {
    const v = classifyDrift(
      passing({ currentUnpacked: ['node_modules/other/x.node'] }),
    );
    expect(v.verdict).toBe('suspicious');
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

  it('基线无 unpacked 记录（null）→ 不可判定，拒绝', () => {
    const v = classifyDrift(passing({ baselineUnpacked: null }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'unpackedSet')?.passed).toBe(false);
  });
});

describe('classifyDrift：差异规模阈值（命名常量固定 + 边界两侧）', () => {
  it('阈值常量固定：50% 与 100 条（改动必须先过评审）', () => {
    expect(REBASELINE_DRIFT_RATIO).toBe(0.5);
    expect(REBASELINE_DRIFT_MIN_COUNT).toBe(100);
  });

  it('差异 49%（基线 100 条）→ 未达整体替换量级，拒绝', () => {
    const v = classifyDrift(passing({ drift: changedDrift(49), baselineCount: 100 }));
    expect(v.verdict).toBe('suspicious');
    expect(cond(v, 'driftScale')?.passed).toBe(false);
  });

  it('差异 51%（基线 100 条）→ 达量级，规模条件通过', () => {
    const v = classifyDrift(passing({ drift: changedDrift(51), baselineCount: 100 }));
    expect(v.verdict).toBe('official-update');
    expect(cond(v, 'driftScale')?.passed).toBe(true);
  });

  it('package.json 内容变化且 ≥100 条（不足 50%）→ 第二条通道放行', () => {
    const v = classifyDrift(
      passing({ drift: changedDrift(100, true), baselineCount: 1000 }),
    );
    expect(v.verdict).toBe('official-update');
    expect(cond(v, 'driftScale')?.passed).toBe(true);
  });

  it('≥100 条但 package.json 未变 → 两条通道都不过，拒绝', () => {
    const v = classifyDrift(passing({ drift: changedDrift(100), baselineCount: 1000 }));
    expect(cond(v, 'driftScale')?.passed).toBe(false);
  });

  it('package.json 变化但只有 99 条 → 第二条通道未达下限，拒绝', () => {
    const v = classifyDrift(
      passing({ drift: changedDrift(99, true), baselineCount: 1000 }),
    );
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
