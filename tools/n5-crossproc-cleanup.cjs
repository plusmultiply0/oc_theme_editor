#!/usr/bin/env node
/**
 * R7 启动清理语义的**跨进程**验证（复审 D 项取证）。
 *
 * 为什么不能只在同一个进程里测：
 *
 * `apply` 的准备区清理是**故意异步、并且吞掉错误**的（见 apply.ts 注释：真机取证
 * 2026-09-12，递归删除上百 MB 准备区在部分 Windows 环境会被安全软件逐文件扫描而
 * 阻塞几十分钟）。`cleanAllStages` 也只在自己删不掉时静默重试下一次启动。
 *
 * 因此「同一个进程刚 staging 完，就立刻要求 cleanAllStages 把准备区删掉」这个
 * 时序**本来就删不掉**：asar 缓存还持有 `stage/<opId>/app` 下的句柄，`rm` 抛
 * `EBUSY`，被按设计吞掉 → 计数 0。这不是产品缺陷，是测试造错了时序。
 *
 * 本脚本用真正的两个进程来验证产品实际依赖的场景：
 *   角色 A：造出一个「上一次运行遗留」的准备区目录（含嵌套 app 产物与 staged.asar）；
 *   角色 B：**新进程**调用 cleanAllStages，必须把遗留删掉并计数为 1。
 * 再补一个同进程对照（无遗留 payload 时同样能删掉），说明锁来自同进程句柄。
 *
 * 用法：node tools/n5-crossproc-cleanup.cjs
 * 退出码：0 = 全部符合预期；1 = 有不符合项。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
}

/** 子进程脚本：只做一件事 —— 在新进程里跑 cleanAllStages 并把计数打到 stdout */
const CHILD_SRC = `'use strict';
const recovery = require(${JSON.stringify(path.join(OUT, 'core', 'patch', 'recovery'))});
recovery
  .cleanAllStages(process.argv[2])
  .then((n) => process.stdout.write('CLEANED=' + n))
  .catch((e) => process.stdout.write('ERR=' + (e && e.code)));
`;

function main() {
  if (!fs.existsSync(path.join(OUT, 'core', 'patch', 'recovery.js'))) {
    console.error('缺少 out/ 构建产物：请先 npm run build');
    process.exit(1);
  }
  const { runtimeDirs, ensureDirs } = require(path.join(OUT, 'core', 'patch', 'layout'));
  const { instanceIdFromPath } = require(path.join(OUT, 'core', 'patch', 'paths'));
  const { cleanAllStages } = require(path.join(OUT, 'core', 'patch', 'recovery'));

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-n5-cross-'));
  const runtimeRoot = path.join(base, 'runtime');
  const layout = runtimeDirs(runtimeRoot, instanceIdFromPath(path.join(base, 'install')));

  const run = async () => {
    // ---- 角色 A：造出「上一次运行遗留」的准备区 ----
    await ensureDirs(layout);
    const opDir = path.join(layout.stageDir, 'op-LEFTOVER-previous-run');
    fs.mkdirSync(path.join(opDir, 'app', 'out', 'main'), { recursive: true });
    fs.writeFileSync(path.join(opDir, 'app', 'package.json'), '{"name":"leftover"}');
    fs.writeFileSync(path.join(opDir, 'staged.asar'), 'partial-staged');
    check('A：遗留准备区已造出（含嵌套 app 产物）', fs.existsSync(opDir), opDir);

    // ---- 角色 B：新进程清理 ----
    const childScript = path.join(base, 'child.cjs');
    fs.writeFileSync(childScript, CHILD_SRC, 'utf8');
    const r = spawnSync(process.execPath, [childScript, runtimeRoot], { encoding: 'utf8' });
    const stdout = (r.stdout || '').trim();
    check(
      'B（新进程）cleanAllStages 返回 CLEANED=1',
      stdout === 'CLEANED=1',
      stdout || `stderr=${(r.stderr || '').slice(0, 200)}`,
    );
    check('B 之后遗留准备区已被物理删除', !fs.existsSync(layout.stageDir), layout.stageDir);

    // ---- 同进程对照：无遗留 payload 时应能删掉 ----
    fs.mkdirSync(path.join(layout.stageDir, 'x'), { recursive: true });
    const sameProc = await cleanAllStages(runtimeRoot);
    check(
      '同进程（无遗留 payload）cleanAllStages 同样返回 1',
      sameProc === 1,
      `cleaned=${sameProc}`,
    );
    check('同进程清理后 stage 已删除', !fs.existsSync(layout.stageDir));

    // ---- 空场景：没有准备区时必须报 0 ----
    const empty = await cleanAllStages(runtimeRoot);
    check('无任何准备区时返回 0（不把没删掉任何东西报成清理成功）', empty === 0, `cleaned=${empty}`);
  };

  run()
    .catch((e) => check('执行未抛异常', false, String(e && e.stack ? e.stack : e)))
    .then(() => {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      } catch {
        /* 临时目录交给系统回收 */
      }
      report();
    });
}

function report() {
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` | ${r.detail}` : ''}`);
  }
  console.log(`\nR7 跨进程清理语义：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main();
