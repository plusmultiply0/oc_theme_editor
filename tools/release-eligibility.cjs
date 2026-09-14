/**
 * 发布资格判定（P4 任务 C）—— **共享实现**。
 *
 * 被两处消费，保证「登记」与「核验」用同一把尺子：
 *   - `tools/release-build.cjs`：构建结尾判定本次能否取得发布资格
 *     （合格 → 打印 `ALL_GREEN`；不合格 → 只打印 `DEV_BUILD_COMPLETE`）。
 *   - `tools/verify-release.cjs`：核验既有候选时，重新检查构建记录里的步骤契约，
 *     关闭「跳过检查仍可发布」缺口（只核对 hash 不看步骤是不够的）。
 *
 * 设计原则：**绝不乐观放行**——任何字段缺失都判为不可发布。
 */
'use strict';

/**
 * 发布必需步骤集合。
 * `release-build.cjs` 与 `verify-release.cjs` 均以此为唯一事实来源；
 * 构建记录里若自带 `releaseRequiredSteps`（新记录），以记录内声明的为准。
 */
const RELEASE_REQUIRED_STEPS = [
  'typecheck',
  'lint',
  'test:unit',
  'test:integration',
  'build',
  'test:e2e',
  'test:e2e:electron',
  'audit',
  'dist',
  'smoke:gui',
  'verify-package',
  'zip',
  'register',
  'verify:release',
];

/** 允许在步骤记录里出现的状态值（三态，不得以缺字段隐含 skipped） */
const STEP_STATUSES = ['passed', 'failed', 'skipped', 'pending'];

/**
 * 校验一份构建记录是否具备发布资格。
 * @param {object} record 已解析的 build-record
 * @returns {{ ok: boolean, problems: string[], required: string[] }}
 */
function checkReleaseEligibility(record) {
  const problems = [];
  const rec = record || {};
  const required =
    Array.isArray(rec.releaseRequiredSteps) && rec.releaseRequiredSteps.length
      ? rec.releaseRequiredSteps
      : RELEASE_REQUIRED_STEPS;

  // 1) 显式声明（缺字段视为不可发布，不乐观放行）
  if (rec.releaseEligible !== true) {
    problems.push(
      `releaseEligible=${rec.releaseEligible === undefined ? '(缺失)' : rec.releaseEligible}`,
    );
  }

  // 2) 测试注入环境不得伪装成真实通过
  if (rec.testInjectedEnvironment === true) {
    problems.push('检测到测试注入环境（OTS_STEP_STUB/OTS_NODE_BIN），mock 成功不得当作真实通过');
  }

  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const byName = new Map(steps.map((s) => [s.step, s]));

  // 3) 必需步骤齐全（不以缺字段隐含跳过）
  const missing = required.filter((n) => !byName.has(n));
  if (missing.length) problems.push(`缺失必需步骤：${missing.join('、')}`);

  // 4) 无 skipped
  const skipped = required.filter((n) => {
    const s = byName.get(n);
    return s && s.status === 'skipped';
  });
  if (skipped.length) problems.push(`必需步骤被跳过：${skipped.join('、')}`);

  // 5) 全部 passed
  const notPassed = required
    .filter((n) => byName.has(n))
    .filter((n) => byName.get(n).status !== 'passed');
  if (notPassed.length) {
    problems.push(
      `必需步骤未 passed：${notPassed.map((n) => `${n}(${byName.get(n).status})`).join('、')}`,
    );
  }

  // 6) 退出码均为 0
  const nonZero = required
    .filter((n) => byName.has(n))
    .filter((n) => byName.get(n).exit !== 0);
  if (nonZero.length) {
    problems.push(
      `必需步骤退出码非 0：${nonZero.map((n) => `${n}=${byName.get(n).exit}`).join('、')}`,
    );
  }

  return { ok: problems.length === 0, problems, required };
}

module.exports = { RELEASE_REQUIRED_STEPS, STEP_STATUSES, checkReleaseEligibility };
