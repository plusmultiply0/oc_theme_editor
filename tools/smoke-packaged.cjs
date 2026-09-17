/**
 * 冒烟：用 Playwright 启动候选包的 exe，**真实校验界面可用**（P4 任务 D）。
 *
 * 为什么不用命令行启动：从 shell 上下文启动 GUI 时窗口创建可能受限，
 * 会误判为「包坏了」。Playwright 的 electron.launch 与 e2e 用同一套机制，
 * 与真实用户双击启动行为一致。
 *
 * 为什么是 .cjs 而不是 .ts：原先用 `npx tsx` 运行，但 **tsx 并非本仓库声明依赖**，
 * 会在发布链里联网下载，非密闭且离线必失败。改用纯 CJS 后由 `node` 直接运行，
 * 与 tools/ 下其余脚本一致，只依赖已声明的 `playwright`（@playwright/test）。
 *
 * 旧版缺陷（本文件已修）：只读出标题与前 3 行文本就无条件打印 SMOKE_OK——
 * 空白页、白屏崩溃、渲染进程挂掉都能「通过」。现在必须：
 *  1. 渲染进程真的起来（拿到窗口）；
 *  2. 主界面关键控件**真实存在且可见**（顶栏标题 + 应用按钮）；
 *  3. 页面不是空白（可见文本有实质内容）；
 *  4. 渲染进程无致命错误（console error / pageerror 计数为 0）。
 * 任一不满足 → exit 1，绝不打印 SMOKE_OK。
 *
 * 复审 R5 修正：旧版无条件带 `--no-sandbox --in-process-gpu`（无显示会话下的变通），
 * 却把那次运行当成与双击等价的验收 —— 关闭沙箱改变了实际运行条件，结论超出证据范围。
 *
 * 复审 F2 修正（本文件）：**默认启动参数改为空**。
 * 旧版默认带 `--disable-gpu --disable-gpu-compositing --disable-software-rasterizer
 * --disable-dev-shm-usage`，资格函数却只排除 no-sandbox/in-process-gpu，
 * 于是这组「关了 GPU」的配置被当成可发布的默认启动验收。
 * 关闭 GPU 可能掩盖默认渲染路径的问题——那不等于应用真有 GPU 故障，
 * 而是这条绿色证据证明不了未加参数时也正常。
 * 现在：默认 args 为空（与双击等价）；确需在无显示会话里诊断时用
 * `--diagnostic-gpu` / `--diagnostic-degraded`，两者都**不构成发布资格**（退出码非 0）。
 *
 * 复审 F3 修正（本文件）：
 *  1. 错误通道建立**早于**就绪等待：`launch()` 一返回就挂 `app.on('window')`，
 *     `firstWindow()` 拿到窗口立刻挂页级监听（该方法在窗口创建时即返回，
 *     早于文档加载，因此能覆盖首屏脚本抛错——已用真实 Electron 夹具验证）；
 *     同时在主进程侧 hook `web-contents-created` 并**回填已存在的窗口**，
 *     补上页级事件看不到的 preload-error / did-fail-load / render-process-gone。
 *  2. 就绪判据是**有界轮询**（标题 + 主控件 + 可见文本），不是固定 sleep；
 *     就绪后只取**一次**界面快照。
 *  3. 错误记录持续到关闭确认之后；任一错误即失败。
 *  4. 监听只注册一次（每个 page 只挂一次），负例自检复用同一个记录器。
 *  5. 记录**实际**运行条件（真实 argv、运行时 webPreferences、exe 身份、平台），
 *     而不是只打印调用前的数组。
 *
 * 用法：
 *   node tools/smoke-packaged.cjs <win-unpacked 目录>
 *   node tools/smoke-packaged.cjs <win-unpacked 目录> --diagnostic-gpu
 *   node tools/smoke-packaged.cjs <win-unpacked 目录> --diagnostic-degraded
 *   node tools/smoke-packaged.cjs --self-test-negative <目录>
 *   node tools/smoke-packaged.cjs --self-test-fixtures      # 真实 Electron 夹具，四项时序场景
 * 退出码：0 冒烟通过（默认配置）；1 冒烟失败或不构成发布资格；2 用法错误。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 记录候选 exe 身份（避免把不同 exe 的运行结果混为一谈） */
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 主界面关键控件契约（与 tests/e2e/theme-switcher.spec.ts 保持一致）。 */
const SMOKE_CONTRACT = {
  /** 顶栏标题必须精确等于此文本 */
  titleExact: 'OpenCode 换肤助手',
  /** 必须可见的按钮（可操作入口） */
  buttonNames: ['应用到 OpenCode'],
  /** 必须有可见文本的最小长度（防止空白页蒙混） */
  minVisibleTextLen: 40,
  /** 就绪等待上限（有界轮询，不是固定 sleep） */
  readyTimeoutMs: 20_000,
  /** 就绪轮询间隔 */
  readyIntervalMs: 250,
  /**
   * 就绪后的观测窗口（F3）。
   *
   * 为什么需要它：就绪只能证明「此刻界面渲染好了」，证明不了「之后不会报错」。
   * 启动期的异步失败（延迟抛错、子资源加载失败、preload 报错）常常晚于就绪才出现。
   * 若就绪即判定，这类错误会被结构性地漏掉——夹具 `late-error` 正是这种情况。
   *
   * 它**不是**用来掩盖就绪问题的 sleep：就绪本身走有界轮询并独立断言
   * （超时即失败），这里只是给错误通道一段确定的、有界可打印的观察时间。
   */
  settleMs: 1500,
};

/**
 * 默认启动参数：**空**。
 *
 * F2：正式产品启动冒烟必须与用户双击等价，不加任何 GPU / 沙箱 workaround。
 * 加了 `--disable-gpu` 之类的参数虽然更容易起窗口，但那改变了实际运行条件，
 * 证明不了「用户默认环境可启动」。需要那种诊断时走显式诊断模式，
 * 且诊断模式的结果不构成发布资格。
 */
const DEFAULT_ARGS = [];

/**
 * GPU workaround（诊断专用，F2）。
 * 无显示/无 GPU 会话里 Electron 的 GPU 子进程可能反复重启，这组参数压制它。
 * 仅用于诊断启动问题，**不得**作为发布验收证据。
 */
const DIAGNOSTIC_GPU_ARGS = [
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage',
];

/**
 * 安全降级开关（R5）：这些参数会改变候选包实际的运行安全条件，
 * **不得**出现在发布验收里。只有 `--diagnostic-degraded` 显式诊断时才带上，
 * 且那次运行不构成发布资格（不打印 SMOKE_OK，退出码非 0）。
 */
const DEGRADED_ARGS = ['--no-sandbox', '--in-process-gpu'];

/**
 * 计算本次要传给 electron.launch 的启动配置（**纯函数**，供单测直接断言）。
 *
 * 这是 F2 验收点之一：「测试应断言传给 launch 的正式参数配置，
 * 不只测试资格纯函数」。默认必须是空参数，且**不得**混入任何
 * GPU workaround 或沙箱开关。
 * @param {{diagnosticGpu?: boolean, diagnosticDegraded?: boolean}} [o]
 * @returns {{args: string[], env: Record<string, string>, mode: string}}
 */
function launchConfig(o = {}) {
  const args = [...DEFAULT_ARGS];
  let mode = 'default';
  if (o.diagnosticGpu) {
    args.push(...DIAGNOSTIC_GPU_ARGS);
    mode = 'diagnostic-gpu';
  }
  if (o.diagnosticDegraded) {
    args.push(...DEGRADED_ARGS);
    mode = 'diagnostic-degraded';
  }
  return { args, mode, env: {} };
}

/**
 * 判定本次冒烟能否作为「发布资格证据」（**纯函数**，供单测直接调用）。
 *
 * F2：资格的唯一充分条件是「默认配置」——即**未追加任何启动参数**。
 * 旧版只排除 no-sandbox/in-process-gpu，于是带 GPU workaround 的运行
 * 也被算作可发布，这是被复审点名的问题。
 * @param {{args?: string[], selfTestNegative?: boolean, selfTestFixtures?: boolean, mode?: string}} [o]
 * @returns {string[]} 不构成发布资格的原因（空数组 = 可作为发布资格证据）
 */
function judgeReleaseQualification(o = {}) {
  const args = Array.isArray(o.args) ? o.args : [];
  const problems = [];
  if (args.length) {
    const degraded = args.filter((a) => DEGRADED_ARGS.includes(a));
    const gpu = args.filter((a) => DIAGNOSTIC_GPU_ARGS.includes(a));
    const kinds = [];
    if (gpu.length) kinds.push(`GPU workaround（${gpu.join('、')}）`);
    if (degraded.length) kinds.push(`安全降级开关（${degraded.join('、')}）`);
    const rest = args.filter((a) => !DIAGNOSTIC_GPU_ARGS.includes(a) && !DEGRADED_ARGS.includes(a));
    if (rest.length) kinds.push(`额外参数（${rest.join('、')}）`);
    problems.push(
      `启动参数非默认（${kinds.join('；')}）：只能算「非默认配置诊断」，不能作为发布资格证据`,
    );
  }
  if (o.selfTestNegative) problems.push('负例自检运行不是产品验收');
  if (o.selfTestFixtures) problems.push('夹具自检运行不是产品验收');
  return problems;
}

/**
 * 主进程异常事件 → 人类可读的问题串（**纯函数**）。
 * 只处理页级事件看不到的三类：preload 失败、主框架加载失败、渲染进程消失。
 * @param {Array<{kind?: string, detail?: string}>} events
 * @returns {string[]}
 */
function classifyMainEvents(events) {
  const problems = [];
  for (const e of Array.isArray(events) ? events : []) {
    const kind = e && e.kind;
    const detail = (e && e.detail) || '';
    if (kind === 'preload-error') problems.push(`preload 执行失败：${detail}`);
    else if (kind === 'did-fail-load') problems.push(`主框架加载失败：${detail}`);
    else if (kind === 'render-process-gone') problems.push(`渲染进程消失：${detail}`);
    else if (kind === 'unresponsive') problems.push(`渲染进程无响应：${detail}`);
  }
  return problems;
}

/**
 * 判定界面证据是否可用（**纯函数**，供单测直接调用，无需启动 Electron）。
 * @param {{visibleTextLen?: number, headerText?: string|null,
 *          applyVisible?: boolean, consoleErrors?: string[], pageErrors?: string[],
 *          mainEvents?: Array<{kind?: string, detail?: string}>}} o
 * @param {{relaxed?: boolean}} [opts]
 * @returns {string[]} 未通过原因；空数组表示通过
 */
function judge(o, opts = {}) {
  const problems = [];
  const consoleErrors = o.consoleErrors || [];
  const pageErrors = o.pageErrors || [];
  if (pageErrors.length) {
    problems.push(`渲染进程错误 ${pageErrors.length} 条：${pageErrors[0]}`);
  }
  for (const p of classifyMainEvents(o.mainEvents || [])) problems.push(p);
  if (consoleErrors.length) {
    problems.push(`控制台错误 ${consoleErrors.length} 条：${consoleErrors[0]}`);
  }
  if (opts.relaxed) return problems; // 负例自检：不看界面结构

  if (!o.headerText) {
    problems.push('顶栏标题 .topbar h1 缺失（主界面未渲染）');
  } else if (o.headerText !== SMOKE_CONTRACT.titleExact) {
    problems.push(`顶栏标题不符：期望「${SMOKE_CONTRACT.titleExact}」，实际「${o.headerText}」`);
  }
  if (!o.applyVisible) problems.push('关键控件「应用到 OpenCode」按钮不可见');
  if ((o.visibleTextLen ?? 0) < SMOKE_CONTRACT.minVisibleTextLen) {
    problems.push(`页面可见文本过少（${o.visibleTextLen ?? 0} 字符），疑似空白页`);
  }
  return problems;
}

/**
 * 创建一个「只注册一次」的错误记录器（F3 第 4 条）。
 * 页级与主进程侧都写进同一个记录器，负例自检复用它，避免重复 observe 累积监听。
 */
function createErrorRecorder() {
  return {
    consoleErrors: [],
    pageErrors: [],
    mainEvents: [],
    /** 已挂过监听的 page，按身份去重（避免同一窗口被挂两次） */
    attached: new Set(),
  };
}

/** 给一个 page 挂错误监听；同一个 page 只挂一次。 */
function attachPageRecorder(rec, page, tag = 'window') {
  if (!rec || !page || rec.attached.has(page)) return;
  rec.attached.add(page);
  page.on('console', (m) => {
    if (m.type() === 'error') rec.consoleErrors.push(`[${tag}] ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => rec.pageErrors.push(`[${tag}] ${String(e.message).slice(0, 200)}`));
  page.on('crash', () => rec.pageErrors.push(`[${tag}] renderer crashed`));
}

/**
 * 读一次界面快照（不做断言；就绪轮询与最终判定都用它）。
 * 所有取值都吞错并回落到「没拿到」，由判据去判失败——不把读取异常当成通过。
 */
async function readSnapshot(win) {
  const title = await win.title().catch(() => '');
  const rawText = (await win.locator('body').innerText().catch(() => '')) || '';
  const visibleText = rawText
    .split('\n')
    .filter((l) => l.trim())
    .join('\n');
  const headerText = await win
    .locator('.topbar h1')
    .innerText()
    .catch(() => null);
  const applyVisible = await win
    .getByRole('button', { name: '应用到 OpenCode' })
    .first()
    .isVisible()
    .catch(() => false);
  return {
    title,
    visibleTextLen: visibleText.length,
    headerText: headerText === null ? null : headerText.trim(),
    applyVisible,
  };
}

/** 就绪判据（**纯函数**）：主界面三项同时满足才算就绪。 */
function isReady(s) {
  return (
    !!s &&
    s.headerText === SMOKE_CONTRACT.titleExact &&
    s.applyVisible === true &&
    (s.visibleTextLen ?? 0) >= SMOKE_CONTRACT.minVisibleTextLen
  );
}

/**
 * 有界轮询等界面就绪（F3 第 2 条）。
 * 不用固定 sleep：延迟渲染通过，始终不就绪则超时失败。
 * @returns {Promise<{ok: boolean, snapshot: object|null, timedOut: boolean, waitedMs: number, polls: number}>}
 */
async function waitForReady(win, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? SMOKE_CONTRACT.readyTimeoutMs;
  const intervalMs = opts.intervalMs ?? SMOKE_CONTRACT.readyIntervalMs;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  let polls = 0;
  let snapshot = null;
  for (;;) {
    snapshot = await readSnapshot(win);
    polls += 1;
    if (isReady(snapshot)) {
      return { ok: true, snapshot, timedOut: false, waitedMs: now() - started, polls };
    }
    if (now() - started >= timeoutMs) {
      return { ok: false, snapshot, timedOut: true, waitedMs: now() - started, polls };
    }
    await sleep(intervalMs);
  }
}

/**
 * 主进程侧诊断钩子（在 Electron 主进程里执行）。
 * 与页级监听互补：这里能看到 preload-error / did-fail-load / render-process-gone，
 * 并**回填已经存在的窗口**（Playwright 的 evaluate 在启动后才执行，
 * 首个窗口很可能已经建好，不回填就等于漏掉它）。
 */
function mainDiagnosticsProbe({ app, BrowserWindow }) {
  const g = (globalThis.__otsSmokeEvents = globalThis.__otsSmokeEvents || []);
  const wired = (globalThis.__otsSmokeWired = globalThis.__otsSmokeWired || new WeakSet());
  const push = (kind, detail) => {
    if (g.length < 200) g.push({ kind, detail: String(detail).slice(0, 200) });
  };
  const wire = (wc) => {
    if (!wc || wired.has(wc)) return;
    wired.add(wc);
    try {
      wc.on('render-process-gone', (_e, d) => push('render-process-gone', (d && d.reason) || 'unknown'));
      wc.on('unresponsive', () => push('unresponsive', 'webContents 无响应'));
      wc.on('preload-error', (_e, p, err) => push('preload-error', `${p}: ${(err && err.message) || err}`));
      wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
        if (isMainFrame) push('did-fail-load', `${code} ${desc} ${url}`);
      });
    } catch {
      /* 单个事件签名不符不致命：其余通道继续工作 */
    }
  };
  const existing = BrowserWindow.getAllWindows();
  for (const w of existing) wire(w.webContents);
  app.on('web-contents-created', (_e, wc) => wire(wc));

  const first = existing[0];
  return {
    argv: process.argv.slice(0),
    webPreferences: first && first.webContents.getLastWebPreferences
      ? first.webContents.getLastWebPreferences()
      : null,
    windowsAtHook: existing.length,
  };
}

/** 读回主进程侧累计的事件。 */
function readMainEventsProbe() {
  return globalThis.__otsSmokeEvents || [];
}

/**
 * 一次完整的界面证据采集（F3）：
 *   挂监听（页级 + 主进程）→ 有界等待就绪 → 有界观测窗口 → 取一次快照 → 读回主进程事件。
 * @returns {Promise<object>} 可直接交给 judge()
 */
async function collectUiEvidence(app, win, rec, opts = {}) {
  attachPageRecorder(rec, win, 'first-window');
  const ready = await waitForReady(win, opts);

  // 就绪后的有界观测窗口：让启动期的异步错误有机会到达（见 SMOKE_CONTRACT.settleMs）
  const settleMs = opts.settleMs ?? SMOKE_CONTRACT.settleMs;
  if (settleMs > 0) await (opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(settleMs);

  // 窗口结束后只取**一次**快照（不要边等边累积，避免把中间态当结论）
  const snapshot = await readSnapshot(win);

  let mainEvents = [];
  try {
    mainEvents = await app.evaluate(readMainEventsProbe);
  } catch {
    mainEvents = [];
  }
  if (Array.isArray(mainEvents)) rec.mainEvents = mainEvents;

  return {
    ...snapshot,
    consoleErrors: rec.consoleErrors,
    pageErrors: rec.pageErrors,
    mainEvents: rec.mainEvents,
    ready: ready.ok,
    readyTimedOut: ready.timedOut,
    readyWaitedMs: ready.waitedMs,
    readyPolls: ready.polls,
    settleMs,
  };
}

// ---------------- 自检夹具（真实 Electron，F3 验收） ----------------

/** 夹具用的主界面骨架（满足 SMOKE_CONTRACT） */
const FIXTURE_MAIN_UI =
  '<div class="topbar"><h1>OpenCode 换肤助手</h1></div>' +
  '<button>应用到 OpenCode</button>' +
  '<p>夹具正文占位内容，长度足以满足「不是空白页」的可见文本下限要求。</p>';

const EARLY_MARKER = 'FIXTURE_EARLY_BOOT_ERROR';
const LATE_MARKER = 'FIXTURE_LATE_ERROR';

/** 生成四种时序场景的夹具页面（纯字符串，便于阅读与断言） */
function fixtureHtml(kind) {
  const head =
    kind === 'early-error'
      ? `<script>console.error(${JSON.stringify(EARLY_MARKER)});throw new Error(${JSON.stringify(EARLY_MARKER)});</script>`
      : '';
  const late =
    kind === 'late-error'
      ? `<script>setTimeout(function(){console.error(${JSON.stringify(LATE_MARKER)});},700);</script>`
      : '';
  let body;
  if (kind === 'never-ready') {
    // 永远不出现 .topbar h1：验证「始终不就绪」必须超时失败
    body =
      '<div id="root">这个页面永远不会渲染主界面标题，用于验证「始终不就绪」必须超时失败；' +
      '因此这里放入足够长的占位文本，确保它不会因为「空白页」这条判据而提前失败。</div>';
  } else if (kind === 'normal-delayed') {
    // 延迟渲染：验证有界轮询能等到，而不是靠固定 sleep
    body = `<div id="root"></div><script>setTimeout(function(){document.getElementById('root').innerHTML=${JSON.stringify(
      FIXTURE_MAIN_UI,
    )};},600);</script>`;
  } else {
    body = `<div id="root">${FIXTURE_MAIN_UI}</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}${late}</body></html>`;
}

/** 写一个最小可启动的 Electron 夹具应用目录 */
function writeFixtureApp(root, kind) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: `ots-smoke-fixture-${kind}`, main: 'main.js' }),
  );
  fs.writeFileSync(
    path.join(root, 'main.js'),
    [
      "const { app, BrowserWindow } = require('electron');",
      'app.whenReady().then(() => {',
      '  const w = new BrowserWindow({ width: 900, height: 600, show: false,',
      '    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });',
      "  w.loadFile('index.html');",
      '});',
      "app.on('window-all-closed', () => app.quit());",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'index.html'), fixtureHtml(kind));
}

/**
 * 夹具自检（真实 Electron）：四种时序场景都必须落到规定结论。
 * 这是 F3 的验收证据——不是「纯函数测过就算」。
 * @returns {Promise<Array<{name: string, ok: boolean, detail: string}>>}
 */
async function runFixtureSelfTest(opts = {}) {
  const { _electron: electron } = require('playwright');
  const electronBin = opts.executablePath || findElectronBinary();
  const results = [];
  const baseTmp = fs.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), 'ots-smoke-fixtures-'));

  /**
   * 每个场景期望的结论：
   *   expectPass=true  → 冒烟判据必须放行
   *   expectPass=false → 必须失败，且失败原因里要含 `must`（锁住是**因为什么**失败的）
   */
  const scenarios = [
    { kind: 'normal-delayed', expectPass: true, must: null, note: '正常延迟渲染必须通过' },
    { kind: 'never-ready', expectPass: false, must: '顶栏标题', note: '始终不就绪必须超时失败' },
    { kind: 'early-error', expectPass: false, must: '渲染进程错误', note: '初始化早期抛错必须失败' },
    { kind: 'late-error', expectPass: false, must: '控制台错误', note: '晚到错误必须失败' },
  ];

  try {
    for (const sc of scenarios) {
      const dir = path.join(baseTmp, sc.kind);
      writeFixtureApp(dir, sc.kind);
      const rec = createErrorRecorder();
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      let app;
      let obs = null;
      let thrown = null;
      try {
        // 夹具同样走**默认配置**（空参数），与产品冒烟一致
        app = await electron.launch({
          executablePath: electronBin,
          env,
          args: [...launchConfig().args, dir],
        });
        const win = await app.firstWindow();
        // 与产品路径一致：先挂 window 事件（覆盖后续窗口），再挂当前窗口
        app.on('window', (p) => attachPageRecorder(rec, p, 'fixture-window'));
        obs = await collectUiEvidence(app, win, rec, {
          timeoutMs: opts.readyTimeoutMs ?? 6000,
          intervalMs: 200,
        });
      } catch (e) {
        thrown = e instanceof Error ? e.message : String(e);
      }

      let problems;
      if (thrown) {
        problems = [`启动/采集抛出：${thrown}`];
      } else {
        // 就绪超时用 judge 表达：把「不就绪」翻成明确问题
        const forJudge = { ...obs };
        if (!obs.ready) forJudge.headerText = null;
        problems = judge(forJudge);
      }

      const passed = problems.length === 0;
      let ok = passed === sc.expectPass;
      let detail = problems.length ? problems.slice(0, 2).join('；') : '无问题';
      if (ok && !sc.expectPass && sc.must && !problems.some((p) => p.includes(sc.must))) {
        ok = false;
        detail = `失败了，但原因不含「${sc.must}」：${detail}`;
      }
      results.push({ name: `${sc.note}（${sc.kind}）`, ok, detail });

      if (app) await app.close().catch(() => undefined);
    }
  } finally {
    try {
      fs.rmSync(baseTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      console.log(`SMOKE_FIXTURE_CLEANUP_WARN ${baseTmp} 未删除（临时目录由系统回收）`);
    }
  }
  return results;
}

/** 找 Electron 可执行文件（仅夹具自检需要） */
function findElectronBinary() {
  const ROOT = path.resolve(__dirname, '..');
  const candidates =
    process.platform === 'win32'
      ? [path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')]
      : [
          path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
          path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// ---------------- CLI ----------------
async function main() {
  const { _electron: electron } = require('playwright');
  const argv = process.argv.slice(2);
  const takeFlag = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return false;
    argv.splice(i, 1);
    return true;
  };
  const selfTestNegative = takeFlag('--self-test-negative');
  const selfTestFixtures = takeFlag('--self-test-fixtures');
  const diagnosticGpu = takeFlag('--diagnostic-gpu');
  const diagnosticDegraded = takeFlag('--diagnostic-degraded');
  const dir = argv[0];

  if (selfTestFixtures) {
    const bin = findElectronBinary();
    if (!bin) {
      console.log('SMOKE_FIXTURE_FAIL: 找不到 electron 可执行文件（请先 npm install）');
      process.exit(1);
    }
    console.log(`SMOKE_FIXTURE_EXE ${bin}`);
    const results = await runFixtureSelfTest({ executablePath: bin });
    for (const r of results) console.log(`${r.ok ? '[OK]  ' : '[FAIL]'} ${r.name} | ${r.detail}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.log(`SMOKE_FIXTURE_FAIL: ${failed.length}/${results.length} 项不符合预期`);
      process.exit(1);
    }
    console.log(`SMOKE_FIXTURE_OK（${results.length} 项时序场景结论均符合预期）`);
    process.exit(0);
  }

  if (!dir) {
    console.error('用法: node tools/smoke-packaged.cjs <win-unpacked 目录>');
    console.error('      [--self-test-negative] [--self-test-fixtures]');
    console.error('      [--diagnostic-gpu | --diagnostic-degraded]');
    console.error('  --diagnostic-gpu      ：无显示会话里的 GPU 诊断（非默认配置，不构成发布资格）');
    console.error('  --diagnostic-degraded ：诊断开关（会关闭沙箱；不构成发布资格）');
    process.exit(2);
  }

  const config = launchConfig({ diagnosticGpu, diagnosticDegraded });
  const args = config.args;
  const qualification = judgeReleaseQualification({ args, selfTestNegative, mode: config.mode });
  const exe = path.join(dir, 'OpenCodeThemeSwitcher.exe');

  // 记录本次运行的真实条件（executable / 参数 / 环境），避免把不同配置的结果混为一谈
  console.log(`SMOKE_MODE ${config.mode}`);
  console.log(`SMOKE_EXE ${exe}`);
  console.log(`SMOKE_ARGS ${JSON.stringify(args)}`);
  console.log(`SMOKE_PLATFORM ${process.platform}`);
  console.log(
    `SMOKE_EXE_SHA256 ${fs.existsSync(exe) ? sha256File(exe) : '(缺失)'}`,
  );
  if (qualification.length) {
    for (const p of qualification) console.log('SMOKE_NOT_RELEASE_QUALIFYING:', p);
  }

  // 预检：exe 不存在就别启动（Playwright 的 launch 失败会抛出难看的长栈，
  // 且可能从子进程异步逃逸出 try/catch），这里给出干净的 SMOKE_FAIL。
  if (!fs.existsSync(exe)) {
    console.log(`SMOKE_FAIL: 候选 exe 不存在：${exe}（目录可能未打包成功）`);
    process.exit(1);
  }

  /*
   * 必须清掉 ELECTRON_RUN_AS_NODE：某些开发环境（含本仓库的自动化 shell）
   * 会全局导出它，Electron 应用会退化成 Node 模式 —— 不建窗口、无脚本时静默
   * 退出 0，看上去像「包坏了」。曾据此误判过一次，所以这里显式剥离。
   */
  const env = { ...process.env, ...config.env };
  delete env.ELECTRON_RUN_AS_NODE;

  let app;
  try {
    /*
     * F2：默认配置 = 空启动参数，与用户双击等价。
     * F3：launch 一返回就挂 app.on('window')，再 firstWindow() 立刻挂页级监听；
     *     firstWindow() 在窗口创建时即返回（早于文档加载），因此首屏脚本抛错也能覆盖。
     */
    app = await electron.launch({ executablePath: exe, env, args });
    const rec = createErrorRecorder();
    app.on('window', (p) => attachPageRecorder(rec, p, 'window'));
    const win = await app.firstWindow();

    // 主进程侧诊断：回填已存在窗口 + hook 后续 webContents
    let runtime = null;
    try {
      runtime = await app.evaluate(mainDiagnosticsProbe);
      console.log(`SMOKE_RUNTIME argv=${JSON.stringify(runtime && runtime.argv)}`);
      console.log(
        `SMOKE_RUNTIME webPreferences=${JSON.stringify(runtime && runtime.webPreferences)} ` +
          `windowsAtHook=${runtime ? runtime.windowsAtHook : '?'}`,
      );
    } catch (e) {
      console.log(`SMOKE_RUNTIME_WARN 主进程诊断未装上：${String(e && e.message).slice(0, 160)}`);
    }

    console.log(
      'SMOKE_COVERAGE 页级 console/pageerror 自 firstWindow() 起；' +
        'preload-error / did-fail-load / render-process-gone 自主进程诊断装上起' +
        '（含回填已存在窗口）；launch 之前的主进程错误不在覆盖范围内。',
    );

    if (selfTestNegative) {
      // 负例自检：清空 DOM，必须判为失败（证明断言真的会失败）
      const obs = await collectUiEvidence(app, win, rec, { timeoutMs: 8000, intervalMs: 250 });
      await win.evaluate(() => {
        document.body.innerHTML = '';
      });
      const afterWipe = await readSnapshot(win);
      const problems = judge({ ...afterWipe, consoleErrors: rec.consoleErrors, pageErrors: rec.pageErrors });
      console.log('窗口标题:', obs.title);
      console.log('自检：清空 DOM 后判定 =', problems.length ? '失败（符合预期）' : '通过（不符合预期）');
      await app.close();
      app = undefined;
      if (problems.length) {
        console.log('SMOKE_SELFTEST_OK');
        process.exit(0);
      }
      console.log('SMOKE_SELFTEST_FAIL: 清空 DOM 后仍被判通过，断言形同虚设');
      process.exit(1);
    }

    const obs = await collectUiEvidence(app, win, rec);
    console.log(
      `SMOKE_READY ready=${obs.ready} timedOut=${obs.readyTimedOut} ` +
        `waitedMs=${obs.readyWaitedMs} polls=${obs.readyPolls} settleMs=${obs.settleMs}`,
    );
    console.log('窗口标题:', obs.title);
    const bodyText = (await win.locator('body').innerText().catch(() => '')) || '';
    console.log(
      '界面文本片段:',
      bodyText
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 3)
        .join(' | ')
        .slice(0, 160),
    );

    // 就绪未达成时把「不就绪」翻成明确问题（超时即失败，不是靠 sleep 蒙）
    const forJudge = obs.ready ? obs : { ...obs, headerText: null };
    const problems = judge(forJudge);

    // 记录持续到关闭之后：先关再判，避免关闭过程中的错误被漏掉
    await app.close();
    app = undefined;
    if (!obs.ready) {
      problems.unshift(`界面在 ${SMOKE_CONTRACT.readyTimeoutMs}ms 内未就绪（超时失败）`);
    }

    if (problems.length) {
      for (const p of problems) console.log('SMOKE_FAIL:', p);
      process.exit(1);
    }
    if (qualification.length) {
      /*
       * 界面断言通过，但本次运行不构成发布资格（例如带了诊断参数）：
       * 失败关闭——不打印 SMOKE_OK、退出码非 0，避免日志扫描器把它当成发布绿色。
       * 尤其 F2：GPU 诊断通过**不能**覆盖正常配置失败。
       */
      console.log('SMOKE_DIAGNOSTIC_ONLY（非默认配置诊断；不构成发布资格）');
      process.exit(1);
    }
    console.log('SMOKE_OK');
  } catch (e) {
    console.log('SMOKE_FAIL:', e instanceof Error ? e.message.slice(0, 300) : String(e));
    if (app) await app.close().catch(() => undefined);
    process.exit(1);
  }
}

module.exports = {
  judge,
  judgeReleaseQualification,
  classifyMainEvents,
  launchConfig,
  createErrorRecorder,
  attachPageRecorder,
  readSnapshot,
  isReady,
  waitForReady,
  collectUiEvidence,
  mainDiagnosticsProbe,
  readMainEventsProbe,
  runFixtureSelfTest,
  fixtureHtml,
  writeFixtureApp,
  findElectronBinary,
  SMOKE_CONTRACT,
  DEFAULT_ARGS,
  DIAGNOSTIC_GPU_ARGS,
  DEGRADED_ARGS,
};

if (require.main === module) {
  // Playwright 的启动失败可能从内部子进程异步逃逸，绕过 main 的 try/catch，
  // 表现为难看的长栈。这里兜底成干净的 SMOKE_FAIL 并确保退出码为 1（失败关闭）。
  process.on('unhandledRejection', (e) => {
    console.log('SMOKE_FAIL:', e instanceof Error ? e.message.slice(0, 300) : String(e));
    process.exit(1);
  });
  main().then(
    () => process.exit(0),
    (e) => {
      console.log('SMOKE_FAIL:', e instanceof Error ? e.message.slice(0, 300) : String(e));
      process.exit(1);
    },
  );
}
