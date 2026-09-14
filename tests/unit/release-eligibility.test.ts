/**
 * 发布资格判定 tools/release-eligibility.cjs 的契约测试（P4 任务 C）。
 *
 * 这是「跳过检查仍可发布」缺口的守门：build 与 verify 共用此模块，
 * 任何一条放宽都会让「跳步骤/测试注入/mock 成功」被当成发布通过。
 * 因此逐条锁定：缺字段不乐观放行、skipped/pending/failed 全被拒、
 * 退出码非 0 被拒、测试注入被拒、必需步骤缺失被拒。
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const { RELEASE_REQUIRED_STEPS, checkReleaseEligibility } = requireCjs(
  '../../tools/release-eligibility.cjs',
) as {
  RELEASE_REQUIRED_STEPS: string[];
  checkReleaseEligibility: (rec: unknown) => { ok: boolean; problems: string[]; required: string[] };
};

/** 构造一份「完全合格」的发布构建记录。 */
function goodRecord(): {
  releaseEligible: boolean;
  releaseRequiredSteps: string[];
  missingRequiredSteps: string[];
  testInjectedEnvironment: boolean;
  steps: { step: string; status: string; exit: number }[];
} {
  return {
    releaseEligible: true,
    releaseRequiredSteps: [...RELEASE_REQUIRED_STEPS],
    missingRequiredSteps: [],
    testInjectedEnvironment: false,
    steps: RELEASE_REQUIRED_STEPS.map((step) => ({ step, status: 'passed', exit: 0 })),
  };
}

describe('RELEASE_REQUIRED_STEPS', () => {
  it('恰为 14 项，且包含 smoke:gui 与两类 E2E', () => {
    expect(RELEASE_REQUIRED_STEPS.length).toBe(14);
    expect(RELEASE_REQUIRED_STEPS).toContain('smoke:gui');
    expect(RELEASE_REQUIRED_STEPS).toContain('test:e2e');
    expect(RELEASE_REQUIRED_STEPS).toContain('test:e2e:electron');
    expect(RELEASE_REQUIRED_STEPS).toContain('register');
    expect(RELEASE_REQUIRED_STEPS).toContain('verify:release');
  });
});

describe('checkReleaseEligibility（任务 C 契约）', () => {
  it('齐全 + releaseEligible=true + 无注入 → 通过（防止永远为红）', () => {
    const r = checkReleaseEligibility(goodRecord());
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.required.length).toBe(14);
  });

  it('releaseEligible 缺失 → 拒绝（绝不乐观放行）', () => {
    const rec = goodRecord() as Record<string, unknown>;
    delete rec.releaseEligible;
    expect(checkReleaseEligibility(rec).ok).toBe(false);
  });

  it('releaseEligible=false → 拒绝', () => {
    expect(checkReleaseEligibility({ ...goodRecord(), releaseEligible: false }).ok).toBe(false);
  });

  it('testInjectedEnvironment=true → 拒绝（mock 成功不得伪装真实通过）', () => {
    const r = checkReleaseEligibility({ ...goodRecord(), testInjectedEnvironment: true });
    expect(r.ok).toBe(false);
    expect(r.problems.join('；')).toMatch(/测试注入环境/);
  });

  it('缺任一必需步骤（如 smoke:gui / 两类 E2E）→ 拒绝并点名', () => {
    for (const missing of ['smoke:gui', 'test:e2e', 'test:e2e:electron']) {
      const rec = goodRecord();
      rec.steps = rec.steps.filter((s) => s.step !== missing);
      const r = checkReleaseEligibility(rec);
      expect(r.ok).toBe(false);
      expect(r.problems.join('；')).toContain(missing);
    }
  });

  it('有步骤被标 skipped → 拒绝（不以缺字段隐含跳过）', () => {
    const rec = goodRecord();
    const s = rec.steps.find((x) => x.step === 'smoke:gui');
    if (s) s.status = 'skipped';
    const r = checkReleaseEligibility(rec);
    expect(r.ok).toBe(false);
    expect(r.problems.join('；')).toMatch(/跳过/);
  });

  it('有步骤处于 pending / failed → 拒绝', () => {
    for (const bad of ['pending', 'failed']) {
      const rec = goodRecord();
      const s = rec.steps.find((x) => x.step === 'test:integration');
      if (s) s.status = bad;
      const r = checkReleaseEligibility(rec);
      expect(r.ok).toBe(false);
      expect(r.problems.join('；')).toMatch(/未 passed/);
    }
  });

  it('有步骤退出码非 0 → 拒绝并点名', () => {
    const rec = goodRecord();
    const s = rec.steps.find((x) => x.step === 'lint');
    if (s) s.exit = 1;
    const r = checkReleaseEligibility(rec);
    expect(r.ok).toBe(false);
    expect(r.problems.join('；')).toMatch(/lint=1/);
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

  it('记录自带 releaseRequiredSteps 时以其为准（新记录优先）', () => {
    const rec = goodRecord() as Record<string, unknown>;
    rec.releaseRequiredSteps = ['typecheck'];
    rec.steps = [{ step: 'typecheck', status: 'passed', exit: 0 }];
    const r = checkReleaseEligibility(rec);
    expect(r.ok).toBe(true);
    expect(r.required).toEqual(['typecheck']);
  });

  it('空记录 / null → 拒绝，绝不抛异常', () => {
    expect(checkReleaseEligibility(null).ok).toBe(false);
    expect(checkReleaseEligibility({}).ok).toBe(false);
    expect(checkReleaseEligibility(undefined).ok).toBe(false);
  });
});
