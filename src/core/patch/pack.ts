/**
 * 打包调度（事故 F1 修复）：把归档打包隔离到专用工作进程。
 *
 * 为什么必须隔离，见 pack-worker.ts 与
 * handoff/startup-incident-2026-09-11/RECOVERY_AND_FIX.md 第三节。
 *
 * 两条硬规则：
 * - 主进程**绝不**临时 `process.chdir`：cwd 是进程级状态，会影响并发任务与路径解析。
 * - 工作进程 cwd 必须是解包根目录，保证依赖库的小文件快路径
 *   （`fs.readFileSync(逻辑路径)`）读到的是真正要打包的那一份。
 *
 * 派生方式：
 * - Electron 主进程 → `utilityProcess.fork`（带 asar 支持，打包后的 worker 在 app.asar 里也能加载依赖）
 * - 普通 Node（测试、live-cli）→ `child_process.fork`
 */
import { fork } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { fail, ok, type Result } from '../../shared/errors';

export interface PackJob {
  /** 解包根目录（绝对路径） */
  appDir: string;
  /** 输出归档（绝对路径） */
  stagedArchive: string;
  /** 计划打包的条目：归档内相对路径（正斜杠）+ 是否 unpacked */
  files: { path: string; unpacked: boolean }[];
}

export interface PackOptions {
  /** 覆盖 worker 脚本路径（测试用） */
  workerPath?: string;
  /** 超时毫秒数；真实安装 150MB 级打包需要几分钟 */
  timeoutMs?: number;
  /** 测试注入：直接在当前进程跑（仅用于验证 worker 逻辑本身，不用于生产路径） */
  runInline?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

interface WorkerReply {
  ok: boolean;
  error?: { code: string; message: string; detail?: string };
}

interface WorkerHandle {
  onMessage(listener: (payload: WorkerReply) => void): void;
  onExit(listener: (code: number | null) => void): void;
  postMessage(message: PackJob): void;
  kill(): void;
}

type RawUtilityProcess = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  postMessage: (message: unknown) => void;
  kill: () => void;
};

type UtilityProcessModule = {
  fork: (modulePath: string, args?: string[], options?: Record<string, unknown>) => RawUtilityProcess;
};

/** worker 脚本位置：编译后在同目录；从源码跑（vitest）时回落到 out/ */
export function resolvePackWorkerPath(): string {
  const exists = (p: string): boolean => {
    try {
      return fsSync.existsSync(p);
    } catch {
      return false;
    }
  };
  const candidates = [
    path.join(__dirname, 'pack-worker.js'),
    path.join(process.cwd(), 'out', 'core', 'patch', 'pack-worker.js'),
  ];
  const found = candidates.find(exists);
  if (!found) {
    throw new Error(
      `找不到打包工作进程脚本（尝试过：${candidates.join('、')}）；请先 npm run build 再执行需要打包的操作。`,
    );
  }
  return found;
}

/** Electron 主进程里 utilityProcess 才可用；普通 Node 下 require('electron') 返回的是路径字符串 */
function loadUtilityProcess(): UtilityProcessModule | null {
  if (!process.versions?.electron) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { utilityProcess?: UtilityProcessModule };
    if (!electron || typeof electron !== 'object' || !electron.utilityProcess) return null;
    return electron.utilityProcess;
  } catch {
    return null;
  }
}

function forkWithNode(workerPath: string): WorkerHandle {
  const child = fork(workerPath, [], {
    execArgv: [],
    stdio: 'ignore',
    env: { ...process.env },
  });
  return {
    onMessage: (listener) => child.on('message', (m: unknown) => listener(m as WorkerReply)),
    onExit: (listener) => child.on('exit', (code) => listener(code)),
    postMessage: (message) => {
      child.send(message);
    },
    kill: () => child.kill(),
  };
}

function forkWithUtilityProcess(workerPath: string, utility: UtilityProcessModule): WorkerHandle {
  const child = utility.fork(workerPath, [], {
    serviceName: 'opencode-theme-switcher-pack',
    stdio: 'ignore',
  });
  return {
    onMessage: (listener) =>
      child.on('message', (...args: unknown[]) => listener(args[0] as WorkerReply)),
    onExit: (listener) => child.on('exit', (...args: unknown[]) => listener(args[0] as number | null)),
    postMessage: (message) => child.postMessage(message),
    kill: () => child.kill(),
  };
}

/**
 * 在专用工作进程里打包。
 * 成功返回 ok；任何失败（参数、派生、超时、worker 内部错误）都返回失败，绝不静默。
 */
export async function packArchiveInWorker(job: PackJob, opts: PackOptions = {}): Promise<Result<void>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (opts.runInline) {
    // 测试专用：跳过进程隔离，直接在当前进程跑 worker 的打包逻辑。
    // 仅用于验证 worker 逻辑本身；生产路径必须走进程隔离。
    // worker 会 chdir 并关掉 asar 解释，两者都是进程级状态，必须在测试进程里还原，
    // 否则会污染后续测试（这正是事故报告里警告「不要在主进程临时 chdir」的原因）。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const worker = require('./pack-worker') as { __runForTests?: (job: PackJob) => Promise<void> };
    if (typeof worker.__runForTests !== 'function') {
      return fail('STAGE_FAILED', '当前构建缺少测试用的打包入口', '请重新 npm run build。');
    }
    const prevCwd = process.cwd();
    const prevNoAsar = (process as unknown as { noAsar?: boolean }).noAsar === true;
    try {
      await worker.__runForTests(job);
      return ok(undefined);
    } catch (e) {
      return fail('STAGE_FAILED', '打包失败', '请重试；若持续失败请查看日志。', e instanceof Error ? e.stack : String(e));
    } finally {
      process.chdir(prevCwd);
      (process as unknown as { noAsar?: boolean }).noAsar = prevNoAsar;
    }
  }

  let workerPath: string;
  try {
    workerPath = opts.workerPath ?? resolvePackWorkerPath();
  } catch (e) {
    return fail('STAGE_FAILED', e instanceof Error ? e.message : String(e), '工作进程脚本缺失。');
  }

  const started = Date.now();
  const utility = loadUtilityProcess();

  return new Promise<Result<void>>((resolve) => {
    let settled = false;
    let handle: WorkerHandle | null = null;

    const timer = setTimeout(() => {
      finish(
        fail(
          'STAGE_FAILED',
          `打包超时（${Math.round(timeoutMs / 1000)}s）`,
          `已运行 ${Math.round((Date.now() - started) / 1000)}s；工作进程：${workerPath}`,
        ),
      );
    }, timeoutMs);

    function finish(r: Result<void>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        handle?.kill();
      } catch {
        /* 已退出 */
      }
      resolve(r);
    }

    function onMessage(payload: WorkerReply): void {
      if (payload && payload.ok === true) {
        finish(ok(undefined));
        return;
      }
      if (payload && payload.ok === false && payload.error) {
        finish(
          fail(
            (payload.error.code as 'STAGE_FAILED') ?? 'STAGE_FAILED',
            payload.error.message,
            '请根据错误信息处理后重试；安装未被修改。',
            payload.error.detail,
          ),
        );
        return;
      }
      finish(fail('STAGE_FAILED', '打包工作进程返回了无法识别的结果', JSON.stringify(payload).slice(0, 200)));
    }

    function onExit(code: number | null): void {
      // 没有回消息就退出：一定是异常终止
      finish(fail('STAGE_FAILED', `打包工作进程异常退出（code=${String(code)}）`, workerPath));
    }

    try {
      handle = utility ? forkWithUtilityProcess(workerPath, utility) : forkWithNode(workerPath);
      handle.onMessage(onMessage);
      handle.onExit(onExit);
      handle.postMessage(job);
    } catch (e) {
      finish(
        fail(
          'STAGE_FAILED',
          '无法派生打包工作进程',
          '请重试；若持续失败请查看日志。',
          e instanceof Error ? e.stack : String(e),
        ),
      );
    }
  });
}
