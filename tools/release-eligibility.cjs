/**
 * 发布资格判定（共享实现）—— R1/R2 修订版。
 *
 * 被三处消费，保证「写记录 / 登记 / 核验」用同一把尺子：
 *   - `tools/release-build.cjs`：构建结尾判定本次能否取得发布资格
 *     （合格且持有完成回执 → 打印 `ALL_GREEN`；否则只打印 `DEV_BUILD_COMPLETE`）。
 *   - `tools/candidate-manifest.cjs`：登记时校验记录结构（拒绝旧/畸形记录入册）。
 *   - `tools/verify-release.cjs`：core 层查记录事实；最终发布判定查完整资格与回执绑定。
 *
 * 生命周期（R1 修订）：**构建事实与完成回执分离，移除自我依赖**。
 *   - `build-record/2` = 登记前写定的**不可变事实**：只含登记前真实完成的
 *     步骤（typecheck…zip 共 12 项）、来源/锁文件/out 清单、策略版本与注入标志；
 *     **不含 register / verify:release**（登记时它们尚未发生，写进去必然
 *     「记录要求自己尚未发生的完成回执」——旧 /1 记录正是因此永远拿不到资格）。
 *   - register 绑定记录 hash，之后记录**不再改写**（删除旧 finalize 回写路径）。
 *   - register 与 core 核验真实退出 0 后，编排器另写独立 `release-receipt/1`
 *     记录完成回执（buildId/sourceCommit/manifestHash/buildRecordHash），
 *     不把回执 hash 反向塞入 manifest，避免再形成环。
 *
 * 信任边界（R2 修订）：**记录不能自己定义更宽松的审查规则**。
 *   - 按 `policyVersion` 选择必检集合，未知/缺失版本拒绝；
 *   - 记录自带的 `releaseRequiredSteps` 声明了就必须与可信集合**完全一致**
 *     （只能声明，不能缩减）；
 *   - 不信任自报 `releaseEligible`：从步骤事实重算；记录声明了该字段则必须
 *     与重算结果一致（不一致即拒绝）；`missingRequiredSteps` 同理核对；
 *   - steps 结构校验：唯一名称、合法状态、数字退出码；重复步骤拒绝
 *     （Map 的后项覆盖前项不再被容忍）。
 *
 * policy v2 修订：smoke:gui 环境受限替代。当构建环境使「Playwright 驱动
 * 默认配置（沙箱开）的 Electron」必然崩溃、且已取证与应用代码无关时
 * （见 handoff/gpu-smoke-incident-2026-10-18/），构建可**显式声明**
 * `envLimitedGui`（含失败事实/证据文件名/原因），以替代步骤
 * `smoke:gui-env-limited` 换取 smoke:gui 的发布事实。仅显式声明生效——
 * 不声明照旧要求 smoke:gui 本人通过，记录不能静默缩减审查。
 *
 * 设计原则：**绝不乐观放行**——任何结构缺失都判为不可发布。
 */
'use strict';

/**
 * 发布必检策略版本。`build-record/2` 必须声明与之一致的 `policyVersion`；
 * 未知版本拒绝（策略升级时递增版本号并同步编排器/登记/核验/测试/RUNBOOK）。
 *
 * v2：新增 envLimitedGui 替代规则（见文件头）。v1 记录自此拒绝——
 * 历史候选的登记事实不因此作废（manifest/receipt 已固定），但不得按 v1 策略
 * 重新接受发布判定。
 */
const RELEASE_POLICY_VERSION = 2;

/**
 * build-record/2 必须记录的**登记前**步骤（12 项发布事实）。
 * register / verify:release 属登记后步骤，由 release-receipt/1 证明，
 * 不在记录里——它们的完成回执不能再要求记录自己预先持有。
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
];

/** 登记后步骤：其成功由 release-receipt/1 证明，不属于 build-record 内容。 */
const POST_REGISTER_STEPS = ['register', 'verify:release'];

/**
 * smoke:gui 环境受限替代步骤（policy v2）及其证据文件名。
 * 替代步骤由 tools/smoke-env-limited.cjs 产出证据（双击等价启动存活 +
 * 降级配置冒烟 READY）；证据文件名固定，登记/核验端不猜路径。
 */
const ENV_LIMITED_GUI_STEP = 'smoke:gui-env-limited';
const ENV_LIMITED_GUI_EVIDENCE = 'smoke-env-limited-evidence.json';

/** 允许在步骤记录里出现的状态值（显式声明，不得以缺字段隐含 skipped） */
const STEP_STATUSES = ['passed', 'failed', 'skipped', 'pending'];

/** 构建记录当前 schema（R1：/2 起不再含登记后步骤，登记后不可变） */
const RECORD_SCHEMA = 'build-record/2';

/**
 * core 层：校验记录结构与已记录步骤的事实。
 * **不要求**全部必需步骤都在场（开发构建允许缺省跳过项）——
 * 「12 项齐全」的完整资格判定在 `checkReleaseEligibility`。
 * 此层成功 ≠ 最终发布资格。
 * @param {object} record 已解析的 build-record
 * @returns {{ ok: boolean, problems: string[], missing: string[], eligible: boolean, byName: Map<string, object> }}
 */
function checkRecordFacts(record) {
  const problems = [];
  const rec = record || {};

  // 0) schema 与策略版本：版本化策略，未知版本一律拒绝
  if (rec.schema !== RECORD_SCHEMA) {
    problems.push(
      `schema=${rec.schema === undefined ? '(缺失)' : rec.schema} 不是 ${RECORD_SCHEMA}：` +
      '旧 /1 记录把尚未发生的 register/verify:release 写成 pending（自引用），不得进入发布判定',
    );
    return { ok: false, problems, missing: [...RELEASE_REQUIRED_STEPS], eligible: false, byName: new Map() };
  }
  if (rec.policyVersion !== RELEASE_POLICY_VERSION) {
    problems.push(
      `policyVersion=${rec.policyVersion === undefined ? '(缺失)' : rec.policyVersion} 未知（期望 ${RELEASE_POLICY_VERSION}）：` +
      '记录不能按未知版本的策略接受发布判定',
    );
  }

  // 1) 测试注入环境不得伪装成真实通过
  if (rec.testInjectedEnvironment === true) {
    problems.push('检测到测试注入环境（OTS_STEP_STUB/OTS_NODE_BIN），mock 成功不得当作真实通过');
  }

  // 2) 记录自带的必检集合声明：声明了就必须与可信集合完全一致（R2：不能自我缩减）
  if (rec.releaseRequiredSteps !== undefined) {
    const declared = Array.isArray(rec.releaseRequiredSteps) ? rec.releaseRequiredSteps : null;
    const same =
      declared !== null &&
      declared.length === RELEASE_REQUIRED_STEPS.length &&
      RELEASE_REQUIRED_STEPS.every((n) => declared.includes(n)) &&
      declared.every((n) => RELEASE_REQUIRED_STEPS.includes(n));
    if (!same) {
      problems.push(
        `releaseRequiredSteps 声明=${JSON.stringify(rec.releaseRequiredSteps)} 与可信策略集合不一致：` +
        '记录只能声明完整必检集合，不能缩减审查规则',
      );
    }
  }

  // 3) steps 结构校验：数组、对象、唯一名称、合法状态、数字退出码
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const byName = new Map();
  for (const s of steps) {
    if (!s || typeof s !== 'object' || typeof s.step !== 'string' || !s.step) {
      problems.push(`steps 含非法步骤项：${JSON.stringify(s)}`);
      continue;
    }
    if (byName.has(s.step)) {
      problems.push(`步骤重复：${s.step}（重复项不得靠覆盖吞掉）`);
      continue;
    }
    if (!STEP_STATUSES.includes(s.status)) {
      problems.push(`步骤 ${s.step} 状态非法：${s.status === undefined ? '(缺失)' : s.status}`);
      continue;
    }
    if (typeof s.exit !== 'number' || !Number.isInteger(s.exit)) {
      problems.push(`步骤 ${s.step} 退出码必须是整数：${JSON.stringify(s.exit)}`);
      continue;
    }
    byName.set(s.step, s);
  }

  // 4) 已记录步骤的事实：不得 failed/skipped/pending、退出码必须 0
  for (const [name, s] of byName) {
    if (s.status !== 'passed') {
      problems.push(`已记录步骤未 passed：${name}(${s.status})`);
    } else if (s.exit !== 0) {
      problems.push(`已记录步骤退出码非 0：${name}=${s.exit}`);
    }
  }

  // 4.5) smoke:gui 环境受限替代（policy v2）：仅显式声明生效，声明必须完整如实
  const egl = rec.envLimitedGui;
  let envLimitedOk = false;
  if (egl !== undefined) {
    const eglProblems = [];
    if (!egl || typeof egl !== 'object' || Array.isArray(egl)) {
      eglProblems.push('必须是对象');
    } else {
      if (typeof egl.reason !== 'string' || !egl.reason.trim()) eglProblems.push('reason 必须是非空字符串（受限原因要可追溯）');
      if (egl.evidence !== ENV_LIMITED_GUI_EVIDENCE) {
        eglProblems.push(`evidence 必须是 ${ENV_LIMITED_GUI_EVIDENCE}，实际=${JSON.stringify(egl.evidence)}`);
      }
      if (!egl.failedStep || egl.failedStep.step !== 'smoke:gui' || !Number.isInteger(egl.failedStep.exit) || egl.failedStep.exit === 0) {
        eglProblems.push('failedStep 必须如实记录 smoke:gui 的非零失败事实');
      }
      if (byName.has('smoke:gui')) eglProblems.push('与已通过的 smoke:gui 冲突：两条路径只能走一条');
      const sub = byName.get(ENV_LIMITED_GUI_STEP);
      if (!sub) eglProblems.push(`缺少替代步骤 ${ENV_LIMITED_GUI_STEP}`);
      else if (sub.status !== 'passed' || sub.exit !== 0) eglProblems.push(`替代步骤 ${ENV_LIMITED_GUI_STEP} 未通过（${sub.status}/${sub.exit}）`);
    }
    if (eglProblems.length) {
      for (const p of eglProblems) problems.push(`envLimitedGui 声明无效：${p}`);
    } else {
      envLimitedOk = true;
    }
  }

  // 5) 重算缺失清单（登记前步骤集合；v2：环境受限声明有效时按替代集合重算）
  const effective = envLimitedOk
    ? RELEASE_REQUIRED_STEPS.filter((n) => n !== 'smoke:gui').concat(ENV_LIMITED_GUI_STEP)
    : [...RELEASE_REQUIRED_STEPS];
  const missing = effective.filter((n) => !byName.has(n));

  // 6) 记录自报字段与重算结果一致性（R2：不信任自报，但声明了就必须对得上）
  if (rec.missingRequiredSteps !== undefined) {
    const declaredMissing = Array.isArray(rec.missingRequiredSteps) ? rec.missingRequiredSteps : null;
    const sameMissing =
      declaredMissing !== null &&
      declaredMissing.length === missing.length &&
      missing.every((n) => declaredMissing.includes(n));
    if (!sameMissing) {
      problems.push(
        `missingRequiredSteps 声明=${JSON.stringify(rec.missingRequiredSteps)} 与重算结果 ${JSON.stringify(missing)} 不一致`,
      );
    }
  }
  const eligible = problems.length === 0 && missing.length === 0;
  if (rec.releaseEligible !== undefined && rec.releaseEligible !== eligible) {
    problems.push(
      `releaseEligible 自报=${rec.releaseEligible} 与按事实重算的 ${eligible} 不一致：` +
      '发布资格由策略与证据重算，自报只能作为一致性核对',
    );
  }

  return { ok: problems.length === 0, problems, missing, eligible, byName };
}

/**
 * 完整发布资格：core 事实合格 + 12 项登记前步骤齐全。
 * register / verify:release 不在此列——它们的成功由 release-receipt/1 证明。
 * @param {object} record 已解析的 build-record
 * @returns {{ ok: boolean, problems: string[], required: string[] }}
 */
function checkReleaseEligibility(record) {
  const facts = checkRecordFacts(record);
  const problems = [...facts.problems];
  if (facts.missing.length) problems.push(`缺失必需步骤：${facts.missing.join('、')}`);
  return { ok: problems.length === 0, problems, required: [...RELEASE_REQUIRED_STEPS] };
}

module.exports = {
  RELEASE_POLICY_VERSION,
  RELEASE_REQUIRED_STEPS,
  POST_REGISTER_STEPS,
  STEP_STATUSES,
  RECORD_SCHEMA,
  ENV_LIMITED_GUI_STEP,
  ENV_LIMITED_GUI_EVIDENCE,
  checkRecordFacts,
  checkReleaseEligibility,
  effectiveRequiredSteps,
};

/**
 * 按记录声明求「本次有效必检集合」（编排器写记录时与核验端用同一把尺子）。
 * 仅当 envLimitedGui 声明存在且替代步骤真实 passed/0 时才启用替代集合；
 * 声明是否合法由 checkRecordFacts 严格判定（这里不重复、不放宽）。
 * @param {object} record 已解析的 build-record（或含 steps/envLimitedGui 的等价结构）
 * @returns {string[]} 有效必检步骤集合
 */
function effectiveRequiredSteps(record) {
  const rec = record || {};
  const sub = Array.isArray(rec.steps) ? rec.steps.find((s) => s && s.step === ENV_LIMITED_GUI_STEP) : null;
  if (rec.envLimitedGui !== undefined && sub && sub.status === 'passed' && sub.exit === 0) {
    return RELEASE_REQUIRED_STEPS.filter((n) => n !== 'smoke:gui').concat(ENV_LIMITED_GUI_STEP);
  }
  return [...RELEASE_REQUIRED_STEPS];
}
