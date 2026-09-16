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
 * 自检：`--self-test-negative` 走同一套断言，但故意清空 DOM（必须判为失败），
 * 用于证明「检查真的会失败」，避免把永远通过的检查当成守门。
 *
 * 复审 R5 修正：旧版无条件带 `--no-sandbox --in-process-gpu`（无显示会话下的变通），
 * 却把那次运行当成与双击等价的验收 —— 关闭沙箱改变了实际运行条件，结论超出证据范围。
 * 现在默认**保留沙箱**（只关 GPU 相关子进程）；确需在无交互会话里诊断时用
 * `--diagnostic-degraded`，且该运行按失败关闭记账（不打印 SMOKE_OK、退出码非 0）。
 *
 * 用法：node tools/smoke-packaged.cjs <win-unpacked 目录> [--self-test-negative] [--diagnostic-degraded]
 * 退出码：0 冒烟通过（默认配置）；1 冒烟失败或不构成发布资格；2 用法错误。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
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
};

/**
 * 安全降级开关（复审 R5）：这些参数会改变候选包实际的运行安全条件，
 * **不得**出现在发布验收里。只有 `--diagnostic-degraded` 显式诊断时才带上，
 * 且那次运行不构成发布资格（不打印 SMOKE_OK，退出码非 0）。
 */
const DEGRADED_ARGS = ['--no-sandbox', '--in-process-gpu'];

/**
 * 默认启动参数：只关 GPU 相关子进程（无显示会话下的稳定性问题），
 * **完全不动沙箱**——main 进程配置的是 `sandbox: true`，验收必须在保留沙箱的
 * 受支持交互会话里进行，否则「冒烟通过」证明不了用户默认环境可启动。
 */
const DEFAULT_ARGS = [
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage',
];

/**
 * 判定本次冒烟能否作为「发布资格证据」（**纯函数**，供单测直接调用）。
 * 含安全降级参数、或只是负例自检，都不等于默认配置下的产品验收。
 * @param {{args?: string[], selfTestNegative?: boolean}} [o]
 * @returns {string[]} 不构成发布资格的原因（空数组 = 可作为发布资格证据）
 */
function judgeReleaseQualification(o = {}) {
  const args = Array.isArray(o.args) ? o.args : [];
  const problems = [];
  const degraded = args.filter((a) => DEGRADED_ARGS.includes(a));
  if (degraded.length) {
    problems.push(
      `启动参数含安全降级开关（${degraded.join('、')}）：只能算「非默认配置诊断」，不能作为发布资格证据`,
    );
  }
  if (o.selfTestNegative) problems.push('负例自检运行不是产品验收');
  return problems;
}

/**
 * 判定界面证据是否可用（**纯函数**，供单测直接调用，无需启动 Electron）。
 * @param {{visibleTextLen?: number, headerText?: string|null,
 *          applyVisible?: boolean, consoleErrors?: string[], pageErrors?: string[]}} o
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

/** 收集界面证据（不做断言，便于负例自检复用）。 */
async function observe(win) {
  const consoleErrors = [];
  const pageErrors = [];
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  win.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  win.on('crash', () => pageErrors.push('renderer crashed'));

  await win.waitForLoadState('domcontentloaded').catch(() => undefined);
  const title = await win.title().catch(() => '');
  const rawText = (await win.locator('body').innerText().catch(() => '')) || '';
  const visibleText = rawText.split('\n').filter((l) => l.trim()).join('\n');
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
    consoleErrors,
    pageErrors,
  };
}

async function main() {
  const { _electron: electron } = require('playwright');
  const argv = process.argv.slice(2);
  const negIdx = argv.indexOf('--self-test-negative');
  const selfTestNegative = negIdx >= 0;
  if (negIdx >= 0) argv.splice(negIdx, 1);
  const diagIdx = argv.indexOf('--diagnostic-degraded');
  const diagnosticDegraded = diagIdx >= 0;
  if (diagIdx >= 0) argv.splice(diagIdx, 1);
  const dir = argv[0];
  if (!dir) {
    console.error('用法: node tools/smoke-packaged.cjs <win-unpacked 目录> [--self-test-negative] [--diagnostic-degraded]');
    console.error('  --diagnostic-degraded：无可用交互会话时的诊断开关（会关闭沙箱）；该运行不构成发布资格（退出码非 0）');
    process.exit(2);
  }
  const exe = path.join(dir, 'OpenCodeThemeSwitcher.exe');
  const args = diagnosticDegraded ? [...DEFAULT_ARGS, ...DEGRADED_ARGS] : [...DEFAULT_ARGS];
  const qualification = judgeReleaseQualification({ args, selfTestNegative });

  // 记录本次运行的真实条件（executable / 参数 / 环境），避免把不同配置的结果混为一谈
  console.log(`SMOKE_EXE ${exe}`);
  console.log(`SMOKE_ARGS ${JSON.stringify(args)}`);
  console.log(
    `SMOKE_ENV platform=${process.platform} session=${process.env.SESSIONNAME || '(无)'} ` +
      `sandbox=${args.includes('--no-sandbox') ? 'disabled(诊断)' : 'preserved'} ` +
      `executableSha256=${fs.existsSync(exe) ? sha256File(exe).slice(0, 16) : '(缺失)'}…`,
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
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  let app;
  try {
    /*
     * 复审 R5：这里**不再**无条件带 `--no-sandbox` / `--in-process-gpu`。
     * 旧的降级参数确实能在无显示会话里起窗口（docs/acceptance.md 6.1 记录过
     * GPU 子进程反复重启、`Target crashed` 的问题），但那改变了实际运行条件，
     * 属于「非默认配置诊断」，不能证明用户双击默认启动可用。
     * 现在默认只关 GPU 相关子进程，保留沙箱；无可用交互会话时应当如实阻断，
     * 而不是靠关闭保护刷绿。
     */
    app = await electron.launch({ executablePath: exe, env, args });
    const win = await app.firstWindow();
    const obs = await observe(win);

    if (selfTestNegative) {
      // 负例自检：清空 DOM，必须判为失败（证明断言真的会失败）
      await win.evaluate(() => {
        document.body.innerHTML = '';
      });
      const afterWipe = await observe(win);
      const problems = judge(afterWipe, { relaxed: false });
      console.log('窗口标题:', obs.title);
      console.log('自检：清空 DOM 后判定 =', problems.length ? '失败（符合预期）' : '通过（不符合预期）');
      await app.close();
      if (problems.length) {
        console.log('SMOKE_SELFTEST_OK');
        process.exit(0);
      }
      console.log('SMOKE_SELFTEST_FAIL: 清空 DOM 后仍被判通过，断言形同虚设');
      process.exit(1);
    }

    const bodyText = (await win.locator('body').innerText().catch(() => '')) || '';
    console.log('窗口标题:', obs.title);
    console.log(
      '界面文本片段:',
      bodyText
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 3)
        .join(' | ')
        .slice(0, 160),
    );

    const problems = judge(obs, { relaxed: false });
    await app.close();
    app = undefined;

    if (problems.length) {
      for (const p of problems) console.log('SMOKE_FAIL:', p);
      process.exit(1);
    }
    if (qualification.length) {
      /*
       * 界面断言通过，但本次运行不构成发布资格（例如带了安全降级参数）：
       * 失败关闭——不打印 SMOKE_OK、退出码非 0，避免日志扫描器把它当成发布绿色。
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

module.exports = { judge, observe, SMOKE_CONTRACT, judgeReleaseQualification, DEGRADED_ARGS, DEFAULT_ARGS };

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
