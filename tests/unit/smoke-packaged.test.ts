/**
 * 打包冒烟判定（tools/smoke-packaged.cjs）的纯函数测试（P4 任务 D）。
 *
 * 冒烟的价值在于「真的会失败」。旧版只打印前 3 行文本就 SMOKE_OK，
 * 空白页/白屏崩溃也能通过。这里锁住四条判据：
 *   1. 顶栏标题缺失或不符 → 失败；
 *   2. 关键控件「应用到 OpenCode」不可见 → 失败；
 *   3. 可见文本过少（空白页）→ 失败；
 *   4. 渲染进程有 console/page error → 失败。
 * 并给出一个「全部满足 → 通过」的正面用例，防止断言永远为红。
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const { judge, SMOKE_CONTRACT } = requireCjs('../../tools/smoke-packaged.cjs') as {
  judge: (
    o: {
      visibleTextLen?: number;
      headerText?: string | null;
      applyVisible?: boolean;
      consoleErrors?: string[];
      pageErrors?: string[];
    },
    opts?: { relaxed?: boolean },
  ) => string[];
  SMOKE_CONTRACT: { titleExact: string; buttonNames: readonly string[]; minVisibleTextLen: number };
};

/** 一个「界面完全可用」的证据基线。 */
function goodObservation() {
  return {
    visibleTextLen: 300,
    headerText: SMOKE_CONTRACT.titleExact,
    applyVisible: true,
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
  };
}

describe('冒烟判定 judge（任务 D）', () => {
  it('界面完全可用 → 通过（防止断言永远为红）', () => {
    expect(judge(goodObservation())).toEqual([]);
  });

  it('顶栏标题缺失（主界面未渲染 / 空白页）→ 失败', () => {
    const problems = judge({ ...goodObservation(), headerText: null, visibleTextLen: 0 });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('；')).toMatch(/顶栏标题/);
  });

  it('顶栏标题不符 → 失败', () => {
    const problems = judge({ ...goodObservation(), headerText: '其他应用' });
    expect(problems.join('；')).toMatch(/顶栏标题不符/);
  });

  it('关键控件「应用到 OpenCode」不可见 → 失败', () => {
    const problems = judge({ ...goodObservation(), applyVisible: false });
    expect(problems.join('；')).toMatch(/应用到 OpenCode/);
  });

  it('可见文本过少（空白页）→ 失败', () => {
    const problems = judge({
      ...goodObservation(),
      visibleTextLen: SMOKE_CONTRACT.minVisibleTextLen - 1,
    });
    expect(problems.join('；')).toMatch(/空白页/);
  });

  it('渲染进程 page error → 失败', () => {
    const problems = judge({ ...goodObservation(), pageErrors: ['TypeError: x is undefined'] });
    expect(problems.join('；')).toMatch(/渲染进程错误/);
  });

  it('控制台 error → 失败', () => {
    const problems = judge({ ...goodObservation(), consoleErrors: ['Failed to load resource'] });
    expect(problems.join('；')).toMatch(/控制台错误/);
  });

  it('空白页同时触发多条缺陷 → 全部列出（不早退）', () => {
    const problems = judge({
      visibleTextLen: 0,
      headerText: null,
      applyVisible: false,
      consoleErrors: ['boom'],
      pageErrors: [],
    });
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it('relaxed（负例自检用）只看错误计数，不看界面结构', () => {
    expect(judge({ visibleTextLen: 0, headerText: null, applyVisible: false }, { relaxed: true })).toEqual([]);
    expect(
      judge(
        { visibleTextLen: 0, headerText: null, applyVisible: false, pageErrors: ['crash'] },
        { relaxed: true },
      ).length,
    ).toBeGreaterThan(0);
  });
});
