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
 * 用法：node tools/smoke-packaged.cjs <win-unpacked 目录> [--self-test-negative]
 * 退出码：0 冒烟通过；1 冒烟失败；2 用法错误。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

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
  const dir = argv[0];
  if (!dir) {
    console.error('用法: node tools/smoke-packaged.cjs <win-unpacked 目录> [--self-test-negative]');
    process.exit(2);
  }
  const exe = path.join(dir, 'OpenCodeThemeSwitcher.exe');

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
    app = await electron.launch({
      executablePath: exe,
      env,
      /*
       * 无显示会话下必须用这组开关（docs/acceptance.md 第 175 行有记录）：
       * Electron 的 GPU 子进程会反复重启并拖住进程；`--no-sandbox` 与
       * `--in-process-gpu` 缺一不可。
       *
       * 这里此前只传了 `--disable-gpu --disable-software-rasterizer`，结果
       * Playwright 在 attach 时拿不到可用的 CDP target，报 `Target crashed`
       * ——而且这个错误会**从子进程异步逃逸出 try/catch**，表现为一句
       * 没有上下文的 SMOKE_FAIL。补齐开关后同一候选能正常起窗口
       * （`firstWindow()` 返回标题「OpenCode 换肤助手」）。
       */
      args: [
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-sandbox',
        '--in-process-gpu',
        '--disable-dev-shm-usage',
        '--disable-gpu-compositing',
      ],
    });
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
    console.log('SMOKE_OK');
  } catch (e) {
    console.log('SMOKE_FAIL:', e instanceof Error ? e.message.slice(0, 300) : String(e));
    if (app) await app.close().catch(() => undefined);
    process.exit(1);
  }
}

module.exports = { judge, observe, SMOKE_CONTRACT };

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
