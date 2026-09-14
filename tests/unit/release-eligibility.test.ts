/**
 * 发布资格判定 tools/release-eligibility.cjs 的契约测试（P4 任务 C → R1/R2 修订）。
 *
 * 这是「跳过检查仍可发布」缺口的守门：build / register / verify 共用此模块，
 * 任何一条放宽都会让「跳步骤/测试注入/mock 成功/自缩减规则」被当成发布通过。
 * 因此逐条锁定：
 *   - build-record/2 契约：不含 register/verify:release（R1 去自引用）；
 *   - 信任边界（R2）：policyVersion 未知拒绝、声明集合不得缩减、自报字段
 *     必须与重算一致、重复/畸形 steps 拒绝；
 *   - 缺字段不乐观放行、skipped/pending/failed 全被拒、退出码非 0 被拒、
 *     测试注入被拒、必需步骤缺失被拒。
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const eligibility = requireCjs('../../tools/release-eligibility.cjs') as {
  RELEASE_POLICY_VERSION: number;
  RELEASE_REQUIRED_STEPS: string[];
  POST_REGISTER_STEPS: string[];
  STEP_STATUSES: string[];
  RECORD_SCHEMA: string;
  checkRecordFacts: (rec: unknown) => {
    ok: boolean;
    problems: string[];
    missing: string[];
    eligible: boolean;
    byName: Map<string, unknown>;
  };
  checkReleaseEligibility: (rec: unknown) => { ok: boolean; problems: string[]; required: string[] };
};

const {
  RELEASE_POLICY_VERSION,
  RELEASE_REQUIRED_STEPS,
  POST_REGISTER_STEPS,
  STEP_STATUSES,
  RECORD_SCHEMA,
  checkRecordFacts,
  checkReleaseEligibility,
} = eligibility;

/** 构造一份「完全合格」的发布构建记录（build-record/2，R1/R2 契约）。 */
function goodRecord(): Record<string, unknown> {
  return {
    schema: RECORD_SCHEMA,
    policyVersion: RELEASE_POLICY_VERSION,
    buildId: 'b-good',
    version: '0.1.0-alpha.1',
    sourceCommit: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64),
    out: { fileCount: 1, files: { 'out/main/index.js': { bytes: 4, sha256: 'c'.repeat(64) } } },
    releaseEligible: true,
    releaseRequiredSteps: [...RELEASE_REQUIRED_STEPS],
    missingRequiredSteps: [],
    testInjectedEnvironment: false,
    steps: RELEASE_REQUIRED_STEPS.map((step) => ({ step, status: 'passed', exit: 0, seconds: 1 })),
  };
}

describe('build-record/2 契约常量（R1 去自引用）', () => {
  it('必检步骤恰为 12 项（登记前事实），且不含 register/verify:release', () => {
    expect(RELEASE_REQUIRED_STEPS.length).toBe(12);
    expect(RELEASE_REQUIRED_STEPS).toContain('smoke:gui');
    expect(RELEASE_REQUIRED_STEPS).toContain('test:e2e');
    expect(RELEASE_REQUIRED_STEPS).toContain('test:e2e:electron');
    expect(RELEASE_REQUIRED_STEPS).not.toContain('register');
    expect(RELEASE_REQUIRED_STEPS).not.toContain('verify:release');
  });

  it('登记后步骤由 release-receipt/1 证明，POST_REGISTER_STEPS 与记录内容互斥', () => {
    expect(POST_REGISTER_STEPS).toEqual(['register', 'verify:release']);
    for (const s of POST_REGISTER_STEPS) {
      expect(RELEASE_REQUIRED_STEPS).not.toContain(s);
    }
  });

  it('版本化策略：schema=build-record/2、policyVersion=1、状态集合显式', () => {
    expect(RECORD_SCHEMA).toBe('build-record/2');
    expect(RELEASE_POLICY_VERSION).toBe(1);
    expect(STEP_STATUSES).toEqual(['passed', 'failed', 'skipped', 'pending']);
  });
});

describe('checkRecordFacts（R1 core 层）', () => {
  it('齐全记录：事实合格、缺失为空、eligible=true', () => {
    const f = checkRecordFacts(goodRecord());
    expect(f.ok).toBe(true);
    expect(f.problems).toEqual([]);
    expect(f.missing).toEqual([]);
    expect(f.eligible).toBe(true);
  });

  it('core 层不要求 12 项齐全：开发构建缺 3 项 → 事实仍合格，但 eligible=false 并点名', () => {
    const rec = goodRecord() as {
      steps: { step: string; status: string; exit: number }[];
      missingRequiredSteps: string[];
      releaseEligible: boolean;
    };
    const skippedSteps = ['smoke:gui', 'test:e2e', 'test:e2e:electron'];
    rec.steps = rec.steps.filter((s) => !skippedSteps.includes(s.step));
    // 真实开发构建记录：自报字段与事实一致（编排器重算后写入）
    rec.missingRequiredSteps = [...skippedSteps];
    rec.releaseEligible = false;
    const f = checkRecordFacts(rec);
    expect(f.ok).toBe(true);
    expect(f.eligible).toBe(false);
    // missing 按策略常量顺序重算，与声明集合做集合级比较
    expect([...f.missing].sort()).toEqual([...skippedSteps].sort());
  });

  it('schema 不是 build-record/2（含旧 /1 与缺失）→ 拒绝并点名自引用原因', () => {
    for (const schema of ['build-record/1', undefined]) {
      const rec = goodRecord() as Record<string, unknown>;
      if (schema === undefined) delete rec.schema;
      else rec.schema = schema;
      const f = checkRecordFacts(rec);
      expect(f.ok).toBe(false);
      expect(f.problems.join('；')).toMatch(/build-record\/2/);
      expect(f.problems.join('；')).toMatch(/自引用|pending/);
    }
  });

  it('policyVersion 未知/缺失 → 拒绝（记录不能按未知版本的策略接受判定）', () => {
    for (const v of [0, 2, '1', undefined]) {
      const rec = goodRecord() as Record<string, unknown>;
      if (v === undefined) delete rec.policyVersion;
      else rec.policyVersion = v;
      const f = checkRecordFacts(rec);
      expect(f.ok).toBe(false);
      expect(f.problems.join('；')).toMatch(/policyVersion/);
    }
  });

  it('testInjectedEnvironment=true → 拒绝（mock 成功不得伪装真实通过）', () => {
    const f = checkRecordFacts({ ...goodRecord(), testInjectedEnvironment: true });
    expect(f.ok).toBe(false);
    expect(f.problems.join('；')).toMatch(/测试注入环境/);
  });

  it('步骤重复 → 拒绝（重复项不得靠 Map 覆盖吞掉）', () => {
    const rec = goodRecord() as { steps: Record<string, unknown>[] };
    rec.steps = [...rec.steps, { step: 'lint', status: 'passed', exit: 0 }];
    const f = checkRecordFacts(rec);
    expect(f.ok).toBe(false);
    expect(f.problems.join('；')).toMatch(/步骤重复：lint/);
  });

  it('畸形 steps（非对象 / 步骤名缺失 / 非法状态 / 非整数退出码）→ 逐项拒绝', () => {
    const bads: unknown[] = [
      null,
      'lint',
      { status: 'passed', exit: 0 },
      { step: 'lint', status: 'ok', exit: 0 },
      { step: 'lint', status: undefined, exit: 0 },
      { step: 'lint', status: 'passed', exit: '0' },
      { step: 'lint', status: 'passed', exit: 1.5 },
    ];
    for (const bad of bads) {
      const rec = goodRecord() as { steps: unknown[] };
      rec.steps = [bad];
      const f = checkRecordFacts(rec);
      expect(f.ok, `应拒绝：${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('已记录步骤 failed/skipped/pending 或退出码非 0 → 拒绝并点名', () => {
    for (const [status, exit, pattern] of [
      ['failed', 0, /未 passed/],
      ['skipped', 0, /未 passed/],
      ['pending', 0, /未 passed/],
      ['passed', 3, /lint=3/],
    ] as const) {
      const rec = goodRecord() as { steps: { step: string; status: string; exit: number }[] };
      const s = rec.steps.find((x) => x.step === 'lint');
      if (s) {
        s.status = status;
        s.exit = exit;
      }
      const f = checkRecordFacts(rec);
      expect(f.ok).toBe(false);
      expect(f.problems.join('；')).toMatch(pattern);
    }
  });

  it('missingRequiredSteps 自报与重算不一致 → 拒绝（不信任自报）', () => {
    const f = checkRecordFacts({ ...goodRecord(), missingRequiredSteps: ['lint'] });
    expect(f.ok).toBe(false);
    expect(f.problems.join('；')).toMatch(/missingRequiredSteps 声明/);
  });

  it('releaseEligible 自报与重算不一致 → 拒绝', () => {
    // 自报 true 但缺步骤
    const rec = goodRecord() as { steps: { step: string }[] };
    rec.steps = rec.steps.filter((s) => s.step !== 'audit');
    const f1 = checkRecordFacts({ ...rec, releaseEligible: true });
    expect(f1.ok).toBe(false);
    expect(f1.problems.join('；')).toMatch(/releaseEligible 自报=true/);
    // 步骤齐全但自报 false
    const f2 = checkRecordFacts({ ...goodRecord(), releaseEligible: false });
    expect(f2.ok).toBe(false);
    expect(f2.problems.join('；')).toMatch(/releaseEligible 自报=false/);
  });

  it('空记录 / null → 拒绝，绝不抛异常', () => {
    expect(checkRecordFacts(null).ok).toBe(false);
    expect(checkRecordFacts({}).ok).toBe(false);
    expect(checkRecordFacts(undefined).ok).toBe(false);
  });
});

describe('checkReleaseEligibility（R1/R2 契约）', () => {
  it('齐全 + releaseEligible=true + 无注入 → 通过（防止永远为红）', () => {
    const r = checkReleaseEligibility(goodRecord());
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.required.length).toBe(12);
  });

  it('releaseEligible=false → 拒绝（自报与重算不一致）', () => {
    const r = checkReleaseEligibility({ ...goodRecord(), releaseEligible: false });
    expect(r.ok).toBe(false);
    expect(r.problems.join('；')).toMatch(/releaseEligible 自报/);
  });

  it('R2 缩减攻击负例：build-only 记录被拒（旧正例翻转）', () => {
    const rec = {
      schema: RECORD_SCHEMA,
      policyVersion: RELEASE_POLICY_VERSION,
      releaseEligible: true,
      releaseRequiredSteps: ['build'],
      steps: [{ step: 'build', status: 'passed', exit: 0 }],
    };
    const r = checkReleaseEligibility(rec);
    expect(r.ok).toBe(false);
    expect(r.problems.join('；')).toMatch(/不能缩减审查规则|缺失必需步骤/);
  });

  it('R2 缩减攻击负例：typecheck-only 记录被拒', () => {
    const rec = {
      schema: RECORD_SCHEMA,
      policyVersion: RELEASE_POLICY_VERSION,
      releaseEligible: true,
      releaseRequiredSteps: ['typecheck'],
      steps: [{ step: 'typecheck', status: 'passed', exit: 0 }],
    };
    expect(checkReleaseEligibility(rec).ok).toBe(false);
  });

  it('R2：任一必需步骤单独删除（12 项逐一）→ 全部拒绝并点名', () => {
    for (const missing of RELEASE_REQUIRED_STEPS) {
      const rec = goodRecord() as { steps: { step: string }[] };
      rec.steps = rec.steps.filter((s) => s.step !== missing);
      const r = checkReleaseEligibility(rec);
      expect(r.ok, `缺 ${missing} 应拒绝`).toBe(false);
      expect(r.problems.join('；')).toContain(missing);
    }
  });

  it('R2：声明集合少一步 / 非数组 → 拒绝（与可信集合必须完全一致）', () => {
    const fewer = [...RELEASE_REQUIRED_STEPS.slice(1)];
    const r1 = checkReleaseEligibility({ ...goodRecord(), releaseRequiredSteps: fewer });
    expect(r1.ok).toBe(false);
    expect(r1.problems.join('；')).toMatch(/不能缩减审查规则/);
    const r2 = checkReleaseEligibility({ ...goodRecord(), releaseRequiredSteps: 'typecheck' });
    expect(r2.ok).toBe(false);
  });

  it('缺任一关键步骤（smoke:gui / 两类 E2E）→ 拒绝并点名', () => {
    for (const missing of ['smoke:gui', 'test:e2e', 'test:e2e:electron']) {
      const rec = goodRecord() as { steps: { step: string }[] };
      rec.steps = rec.steps.filter((s) => s.step !== missing);
      const r = checkReleaseEligibility(rec);
      expect(r.ok).toBe(false);
      expect(r.problems.join('；')).toContain(missing);
    }
  });

  it('steps 缺失或空 → 判为缺全部必需步骤', () => {
    for (const steps of [undefined, []]) {
      const rec = goodRecord() as Record<string, unknown>;
      rec.steps = steps;
      const r = checkReleaseEligibility(rec);
      expect(r.ok).toBe(false);
      expect(r.problems.join('；')).toMatch(/缺失必需步骤/);
    }
  });

  it('测试注入 / skipped / 非 0 退出 → 均拒绝', () => {
    expect(checkReleaseEligibility({ ...goodRecord(), testInjectedEnvironment: true }).ok).toBe(false);
    const skipped = goodRecord() as { steps: { step: string; status: string }[] };
    const s = skipped.steps.find((x) => x.step === 'smoke:gui');
    if (s) s.status = 'skipped';
    expect(checkReleaseEligibility(skipped).ok).toBe(false);
    const nonZero = goodRecord() as { steps: { step: string; status: string; exit: number }[] };
    const a = nonZero.steps.find((x) => x.step === 'audit');
    if (a) {
      a.status = 'failed';
      a.exit = 7;
    }
    expect(checkReleaseEligibility(nonZero).ok).toBe(false);
  });

  it('空记录 / null → 拒绝，绝不抛异常', () => {
    expect(checkReleaseEligibility(null).ok).toBe(false);
    expect(checkReleaseEligibility({}).ok).toBe(false);
    expect(checkReleaseEligibility(undefined).ok).toBe(false);
  });
});
