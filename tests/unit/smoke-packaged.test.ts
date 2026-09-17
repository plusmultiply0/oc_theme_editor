/**
 * 打包冒烟判定（tools/smoke-packaged.cjs）的单元测试（P4 任务 D + 复审 F2/F3）。
 *
 * 冒烟的价值在于「真的会失败」。旧版只打印前 3 行文本就 SMOKE_OK，
 * 空白页/白屏崩溃也能通过。这里锁住四条判据：
 *   1. 顶栏标题缺失或不符 → 失败；
 *   2. 关键控件「应用到 OpenCode」不可见 → 失败；
 *   3. 可见文本过少（空白页）→ 失败；
 *   4. 渲染进程有 console/page error → 失败。
 * 并给出一个「全部满足 → 通过」的正面用例，防止断言永远为红。
 *
 * 复审 F2：默认启动参数必须为空，且资格函数只认「未追加任何参数」。
 * 复审 F3：就绪判据/有界轮询/主进程事件分类。
 *
 * 真实 Electron 的四项时序场景由 `node tools/smoke-packaged.cjs --self-test-fixtures`
 * 覆盖（纯函数测不到时序）；这里只锁可离线判定的部分。
 */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const {
  judge,
  judgeReleaseQualification,
  classifyMainEvents,
  launchConfig,
  isReady,
  waitForReady,
  attachPageRecorder,
  createErrorRecorder,
  SMOKE_CONTRACT,
  DEFAULT_ARGS,
  DIAGNOSTIC_GPU_ARGS,
  DEGRADED_ARGS,
} = requireCjs('../../tools/smoke-packaged.cjs') as {
  judge: (
    o: {
      visibleTextLen?: number;
      headerText?: string | null;
      applyVisible?: boolean;
      consoleErrors?: string[];
      pageErrors?: string[];
      mainEvents?: { kind?: string; detail?: string }[];
    },
    opts?: { relaxed?: boolean },
  ) => string[];
  judgeReleaseQualification: (o?: {
    args?: string[];
    selfTestNegative?: boolean;
    selfTestFixtures?: boolean;
    mode?: string;
  }) => string[];
  classifyMainEvents: (e: { kind?: string; detail?: string }[]) => string[];
  launchConfig: (o?: { diagnosticGpu?: boolean; diagnosticDegraded?: boolean }) => {
    args: string[];
    mode: string;
    env: Record<string, string>;
  };
  isReady: (s: Record<string, unknown>) => boolean;
  waitForReady: (
    win: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; snapshot: Record<string, unknown> | null; timedOut: boolean; polls: number }>;
  attachPageRecorder: (rec: Record<string, unknown>, page: unknown, tag?: string) => void;
  createErrorRecorder: () => {
    consoleErrors: string[];
    pageErrors: string[];
    mainEvents: unknown[];
    attached: Set<unknown>;
  };
  SMOKE_CONTRACT: { titleExact: string; buttonNames: readonly string[]; minVisibleTextLen: number };
  DEFAULT_ARGS: string[];
  DIAGNOSTIC_GPU_ARGS: string[];
  DEGRADED_ARGS: string[];
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

  it('主进程侧 preload 失败 → 失败（页级事件看不到）', () => {
    const problems = judge({
      ...goodObservation(),
      mainEvents: [{ kind: 'preload-error', detail: '/x/preload.js: boom' }],
    });
    expect(problems.join('；')).toMatch(/preload 执行失败/);
  });

  it('主框架加载失败 / 渲染进程消失 → 失败', () => {
    expect(
      judge({ ...goodObservation(), mainEvents: [{ kind: 'did-fail-load', detail: '-6 ERR_FILE_NOT_FOUND' }] })
        .join('；'),
    ).toMatch(/主框架加载失败/);
    expect(
      judge({ ...goodObservation(), mainEvents: [{ kind: 'render-process-gone', detail: 'crashed' }] }).join('；'),
    ).toMatch(/渲染进程消失/);
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

/**
 * 复审 R5：无条件关闭沙箱的冒烟结果不能当发布验收。
 * 复审 F2：**带 GPU workaround 同样不能**当发布验收——旧版正是漏了这条。
 */
describe('冒烟发布资格判定 judgeReleaseQualification（R5 + F2）', () => {
  it('默认配置（**空参数**，与双击等价）→ 可作为发布资格证据', () => {
    expect(judgeReleaseQualification({ args: [] })).toEqual([]);
  });

  it('含 --no-sandbox → 不构成发布资格，原因明确点名该开关', () => {
    const problems = judgeReleaseQualification({ args: ['--no-sandbox'] });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('--no-sandbox');
    expect(problems[0]).toContain('发布资格');
  });

  it('含 --in-process-gpu → 不构成发布资格', () => {
    const problems = judgeReleaseQualification({ args: ['--in-process-gpu'] });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('--in-process-gpu');
  });

  /** F2 的核心断言：GPU workaround 不能算默认配置 */
  it('含 GPU workaround → 不构成发布资格（F2 直接锁这条）', () => {
    const problems = judgeReleaseQualification({ args: [...DIAGNOSTIC_GPU_ARGS] });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('--disable-gpu');
    expect(problems[0]).toContain('发布资格');
  });

  it('任何额外参数都不构成发布资格，且原因点名具体参数', () => {
    const problems = judgeReleaseQualification({ args: ['--some-flag'] });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('--some-flag');
  });

  it('负例自检运行 → 不构成发布资格（即使参数干净）', () => {
    expect(judgeReleaseQualification({ args: [], selfTestNegative: true })[0]).toContain('负例自检');
  });

  it('夹具自检运行 → 不构成发布资格', () => {
    expect(judgeReleaseQualification({ args: [], selfTestFixtures: true })[0]).toContain('夹具自检');
  });
});

/**
 * F2 验收要求「测试应断言传给 launch 的正式参数配置，不只测试资格纯函数」。
 * 这里直接断言 launchConfig 的产物，而不是只断言判据。
 */
describe('冒烟启动配置 launchConfig（F2）', () => {
  it('默认配置的 args 必须为空数组，且不含任何 workaround', () => {
    const cfg = launchConfig();
    expect(cfg.args).toEqual([]);
    expect(cfg.mode).toBe('default');
    expect(cfg.args).not.toContain('--disable-gpu');
    expect(cfg.args).not.toContain('--no-sandbox');
  });

  it('DEFAULT_ARGS 本身为空（防止以后又被塞回 GPU 开关）', () => {
    expect(DEFAULT_ARGS).toEqual([]);
  });

  it('诊断 GPU 模式才带 GPU workaround，且标注为非默认模式', () => {
    const cfg = launchConfig({ diagnosticGpu: true });
    expect(cfg.mode).toBe('diagnostic-gpu');
    for (const a of DIAGNOSTIC_GPU_ARGS) expect(cfg.args).toContain(a);
    expect(cfg.args).not.toContain('--no-sandbox');
  });

  it('诊断降级模式带沙箱开关', () => {
    const cfg = launchConfig({ diagnosticDegraded: true });
    expect(cfg.mode).toBe('diagnostic-degraded');
    for (const a of DEGRADED_ARGS) expect(cfg.args).toContain(a);
  });

  it('任一诊断模式的产物都不可能被判为发布资格', () => {
    for (const o of [{ diagnosticGpu: true }, { diagnosticDegraded: true }]) {
      expect(judgeReleaseQualification({ args: launchConfig(o).args }).length).toBeGreaterThan(0);
    }
  });
});

describe('就绪判据与有界轮询（F3）', () => {
  it('isReady：标题 + 主控件 + 文本长度三者同时满足才算就绪', () => {
    expect(isReady({ headerText: SMOKE_CONTRACT.titleExact, applyVisible: true, visibleTextLen: 100 })).toBe(
      true,
    );
    expect(isReady({ headerText: SMOKE_CONTRACT.titleExact, applyVisible: true, visibleTextLen: 1 })).toBe(false);
    expect(isReady({ headerText: null, applyVisible: true, visibleTextLen: 100 })).toBe(false);
    expect(isReady({ headerText: SMOKE_CONTRACT.titleExact, applyVisible: false, visibleTextLen: 100 })).toBe(
      false,
    );
  });

  it('waitForReady：延迟渲染能被轮询等到，不是靠固定 sleep', async () => {
    // 前两次快照「界面还没渲染好」，第三次起才就绪
    let polls = 0;
    const notReady = '<div></div>';
    const readyBody =
      `${SMOKE_CONTRACT.titleExact}\n` +
      '以及足够长的正文文本，用来满足「可见文本下限」这条判据，避免夹具本身被误判为空白页。';
    const win = {
      title: async () => SMOKE_CONTRACT.titleExact,
      locator: (sel: string) => ({
        innerText: async () => {
          if (sel === 'body') return polls >= 3 ? readyBody : notReady;
          // .topbar h1：就绪前为空
          return polls >= 3 ? SMOKE_CONTRACT.titleExact : '';
        },
      }),
      getByRole: () => ({
        first: () => ({
          isVisible: async () => {
            polls += 1; // 每次轮询在这里计数一次
            return polls >= 3;
          },
        }),
      }),
    };
    const r = await waitForReady(win as never, { timeoutMs: 5000, intervalMs: 1, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.polls).toBeGreaterThanOrEqual(3);
  });

  it('waitForReady：始终不就绪 → 超时失败（不是无限等）', async () => {
    let t = 0;
    const win = {
      title: async () => 'x',
      locator: () => ({ innerText: async () => '' }),
      getByRole: () => ({ first: () => ({ isVisible: async () => false }) }),
    };
    const r = await waitForReady(win as never, {
      timeoutMs: 100,
      intervalMs: 1,
      now: () => (t += 60), // 每次轮询推进 60ms，两次即超时
      sleep: async () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });
});

describe('错误记录器只注册一次（F3）', () => {
  function fakePage() {
    const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    return {
      handlers,
      on(ev: string, fn: (...a: unknown[]) => void) {
        handlers.set(ev, [...(handlers.get(ev) || []), fn]);
      },
    };
  }

  it('同一个 page 重复挂载不会累积监听（避免重复观察放大错误）', () => {
    const rec = createErrorRecorder();
    const p = fakePage();
    attachPageRecorder(rec, p, 'a');
    attachPageRecorder(rec, p, 'b');
    expect(rec.attached.size).toBe(1);
    expect(p.handlers.get('pageerror')?.length).toBe(1);
  });

  it('pageerror / console.error 进记录器，console.log 不进', () => {
    const rec = createErrorRecorder();
    const p = fakePage();
    attachPageRecorder(rec, p, 'w');
    p.handlers.get('pageerror')![0]({ message: 'boom' });
    p.handlers.get('console')![0]({ type: () => 'error', text: () => 'bad' });
    p.handlers.get('console')![0]({ type: () => 'log', text: () => 'fine' });
    expect(rec.pageErrors).toHaveLength(1);
    expect(rec.consoleErrors).toHaveLength(1);
  });
});

describe('主进程事件分类（F3）', () => {
  it('只把真正的失败类事件翻成问题，未知事件不误报', () => {
    const problems = classifyMainEvents([
      { kind: 'did-fail-load', detail: '-6' },
      { kind: 'something-else', detail: 'x' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('主框架加载失败');
  });

  it('空/非数组输入不抛错', () => {
    expect(classifyMainEvents([])).toEqual([]);
    expect(classifyMainEvents(undefined as never)).toEqual([]);
  });
});

describe('relaxed 自检路径与真判据分离', () => {
  it('负例自检用 relaxed 时不会因为界面结构缺失而误判（它要验的是错误通道）', () => {
    const spy = vi.fn(() => []);
    expect(spy()).toEqual([]);
    expect(judge({ visibleTextLen: 0, headerText: null, applyVisible: false }, { relaxed: true })).toEqual([]);
  });
});
