/**
 * 打包专用工作进程（事故 F1 修复）。
 *
 * 事故：handoff/startup-incident-2026-09-11/RECOVERY_AND_FIX.md。
 * `@electron/asar` 的 `Filesystem.insertFile` 对 ≤2MB 的文件走同步快路径：
 *   `fs.readFileSync(p)`，其中 p 是**归档内的逻辑路径**，相对打包进程的 cwd 解析。
 * 本工具的 cwd 是开发项目，里面恰好也有同路径 `node_modules`，但内容与目标安装不一致；
 * 于是完整性 hash 取自开发项目的文件，size 与数据流却来自真正要打包的文件，
 * `storeFileEntry` 再按这个错误 hash 去重 —— 两个内容不同的文件被当成同一条，
 * 共享 offset，第二个文件读出来就是第一个文件的前 N 字节（真机上 jsonfile 被截断，
 * OpenCode 主进程加载依赖时 SyntaxError，无法启动）。
 *
 * 修复：打包隔离到专用进程，并把它的 **cwd 设为解包根目录**。
 * 这样即使快路径仍然按逻辑路径读文件，读到的也是正确的那一份，
 * hash、size、最终写入来自同一份字节。cwd 是进程级状态，
 * 绝不能在主进程里临时 chdir（会影响并发任务和其他路径解析），所以用独立进程。
 *
 * 协议：父进程通过 IPC 发送 PackJob，本进程回 `{ok:true}` 或 `{ok:false,error}` 后退出。
 * 本进程**只做物理归档 I/O**，因此可以全程关闭 asar 解释（见下），不存在异步窗口问题。
 */
import fs from 'node:fs';
import path from 'node:path';

interface PackJob {
  /** 解包根目录（绝对路径）；本进程会 chdir 到这里 */
  appDir: string;
  /** 输出归档（绝对路径） */
  stagedArchive: string;
  /** 要打包的条目：归档内相对路径（正斜杠）+ 是否 unpacked */
  files: { path: string; unpacked: boolean }[];
}

interface PackError {
  code: string;
  message: string;
  detail?: string;
}

/**
 * 回消息给父进程。
 * 两种派生方式的通道不同：
 * - `child_process.fork`（普通 Node）→ process.send / process.on('message')
 * - Electron `utilityProcess.fork`    → process.parentPort.postMessage / .on('message')
 */
const parentPort = (process as unknown as {
  parentPort?: { postMessage: (m: unknown) => void; on: (e: string, l: (ev: { data: unknown }) => void) => void };
}).parentPort;

function reply(payload: { ok: true } | { ok: false; error: PackError }): void {
  if (parentPort) {
    parentPort.postMessage(payload);
    return;
  }
  if (typeof process.send === 'function') {
    process.send(payload);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(code: string, message: string, detail?: string): never {
  reply({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } });
  process.exit(1);
}

async function run(job: PackJob): Promise<void> {
  if (!job || typeof job.appDir !== 'string' || typeof job.stagedArchive !== 'string' || !Array.isArray(job.files)) {
    fail('INVALID_PARAMS', '打包任务参数不合法', JSON.stringify(job).slice(0, 200));
  }
  if (!fs.existsSync(job.appDir)) {
    fail('STAGE_FAILED', `解包根目录不存在：${job.appDir}`);
  }

  // cwd 必须是解包根目录：这是本次修复的核心。
  // 即便依赖库的快路径仍按逻辑路径读文件，读到的也是正确的那一份。
  process.chdir(job.appDir);

  // 先加载依赖再关 asar 解释：打包后的 worker 自身就在 app.asar 里，
  // 加载模块仍需要 asar 支持；关掉之后本进程只做物理文件读写。
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- worker 是 CJS 入口，必须用 require 解析 app.asar 内的依赖
  const { createPackageFromStreams } = require('@electron/asar') as {
    createPackageFromStreams: (dest: string, streams: unknown[]) => Promise<void>;
  };
  process.noAsar = true;

  const streams: unknown[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const logical = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) {
        streams.push({ path: logical, type: 'directory', unpacked: false, stat: fs.statSync(abs) });
        walk(abs, logical);
        continue;
      }
      if (!e.isFile()) continue;
      const wanted = job.files.find((f) => f.path === logical);
      if (!wanted) {
        // 解包目录里出现了计划之外的条目：拒绝打包，而不是静默塞进去
        fail('STAGE_FAILED', `解包目录出现计划外条目：${logical}`, '请重新准备后再打包。');
      }
      streams.push({
        path: logical,
        type: 'file',
        unpacked: wanted.unpacked,
        stat: fs.statSync(abs),
        streamGenerator: () => fs.createReadStream(abs),
      });
    }
  };
  walk(job.appDir, '');

  // 计划里的条目必须全部存在，少一个都说明解包结果与计划不一致
  const seen = new Set<string>();
  for (const s of streams as { path?: string }[]) {
    if (typeof s.path === 'string') seen.add(s.path);
  }
  const missing = job.files.filter((f) => !seen.has(f.path)).map((f) => f.path);
  if (missing.length > 0) {
    fail('STAGE_FAILED', `解包目录缺少计划条目：${missing.slice(0, 5).join('、')}`);
  }

  await createPackageFromStreams(job.stagedArchive, streams);
}

function start(job: PackJob): void {
  run(job)
    .then(() => {
      reply({ ok: true });
      // 专用进程，任务完成即退出；不等任何句柄
      process.exit(0);
    })
    .catch((e) => {
      fail('STAGE_FAILED', '打包工作进程失败', e && e.stack ? e.stack : String(e));
    });
}

if (parentPort) {
  // Electron utilityProcess
  parentPort.on('message', (ev: { data: unknown }) => start(ev.data as PackJob));
} else if (typeof process.send === 'function') {
  // child_process.fork
  process.on('message', (job: PackJob) => start(job));
} else {
  // 被直接执行而不是被派生：明确报错，避免有人把它当 CLI 用
  console.error('pack-worker 是打包专用工作进程，必须由 pack.ts 通过 IPC 派生，不要直接运行。');
  process.exit(2);
}

/**
 * 测试专用入口：让单元/集成测试能在当前进程里执行与 worker 完全相同的打包逻辑
 * （验证 cwd 与 hash/size/data 一致性），而不必真的派生进程。
 * 生产路径必须走 pack.ts 的进程隔离，不走这里。
 */
export async function __runForTests(job: PackJob): Promise<void> {
  await run(job);
}
