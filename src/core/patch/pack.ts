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
  /**
   * 测试注入：替换派生实现。
   *
   * 这里是**故意留的缝**：N2 要验证的是「异步 error / 发送失败 / 退出次序」这些事件契约，
   * 而这些事件无法用真实子进程稳定复现（EAGAIN 需要真的资源耗尽）。注入的 fork
   * 必须返回同样形状的 WorkerHandle，因此测试覆盖的是生产代码里的同一条状态机。
   * 生产路径不传此参数。
   */
  forkOverride?: (
    workerPath: string,
    onSendError: (err: Error) => void,
  ) => WorkerHandle;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** 成功回执之后等待正常退出的上限：只用于「回收是否完成」的判定，不改变成功结论 */
const EXIT_GRACE_MS = 30_000;

interface WorkerReply {
  ok: boolean;
  error?: { code: string; message: string; detail?: string };
}

interface WorkerHandle {
  onMessage(listener: (payload: WorkerReply) => void): void;
  onExit(listener: (code: number | null) => void): void;
  /** N2：派生/通道的**异步**错误必须有人监听，否则会从 EventEmitter 逸出成未捕获异常 */
  onError(listener: (err: Error) => void): void;
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

function forkWithNode(
  workerPath: string,
  onSendError: (err: Error) => void,
): WorkerHandle {
  const child = fork(workerPath, [], {
    execArgv: [],
    stdio: 'ignore',
    env: { ...process.env },
  });
  return {
    onMessage: (listener) => child.on('message', (m: unknown) => listener(m as WorkerReply)),
    onExit: (listener) => child.on('exit', (code) => listener(code)),
    onError: (listener) => child.on('error', (e: Error) => listener(e)),
    postMessage: (message) => {
      child.send(message, (err: Error | null | undefined) => {
        // 通道在发送时失败（EPIPE / ERR_IPC_CHANNEL_CLOSED）走回调，而不是抛出
        if (err) onSendError(err);
      });
    },
    kill: () => child.kill(),
  };
}

function forkWithUtilityProcess(
  workerPath: string,
  utility: UtilityProcessModule,
  onSendError: (err: Error) => void,
): WorkerHandle {
  const child = utility.fork(workerPath, [], {
    serviceName: 'opencode-theme-switcher-pack',
    stdio: 'ignore',
  });
  return {
    onMessage: (listener) =>
      child.on('message', (...args: unknown[]) => listener(args[0] as WorkerReply)),
    onExit: (listener) => child.on('exit', (...args: unknown[]) => listener(args[0] as number | null)),
    // utilityProcess 的 error 事件参数不保证是 Error 实例，统一包一层
    onError: (listener) =>
      child.on('error', (...args: unknown[]) => {
        const raw = args[0];
        listener(raw instanceof Error ? raw : new Error(String(raw)));
      }),
    postMessage: (message) => {
      try {
        child.postMessage(message);
      } catch (e) {
        // utilityProcess 的 postMessage 没有 Node 那样的完成回调：
        // 同步异常在这里转成结构化失败，异步错误由 error 事件兜住。
        onSendError(e instanceof Error ? e : new Error(String(e)));
      }
    },
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
    // 成功结果要等「正常退出」再交付（见 finish 注释），因此消息与退出各留一份
    let successResult: Result<void> | null = null;
    let exitSeen = false;

    const timer = setTimeout(() => {
      // 超时属于「故障回收」：kill 是正当的
      finish(
        fail(
          'STAGE_FAILED',
          `打包超时（${Math.round(timeoutMs / 1000)}s）`,
          `已运行 ${Math.round((Date.now() - started) / 1000)}s；工作进程：${workerPath}`,
        ),
        { killWorker: true },
      );
    }, timeoutMs);

    // 成功消息已到、但进程迟迟不退出时的**有界等待**：不无限期挂着，
    // 也不把「还没退出」当成失败——只是无法确认回收完成，如实记进恢复建议。
    const timers: NodeJS.Timeout[] = [timer];

    function armExitGrace(): void {
      const grace = setTimeout(() => {
        if (settled || exitSeen) return;
        // 结果仍是成功：打包已回执完成。这里只说明「回收是否按时完成」，
        // 不去改成功/失败的结论，也不把未退出当成失败。
        settle(ok(undefined), { killWorker: true });
      }, EXIT_GRACE_MS);
      grace.unref?.();
      timers.push(grace);
    }

    function clearTimers(): void {
      for (const t of timers) clearTimeout(t);
    }

    function settle(r: Result<void>, o: { killWorker: boolean }): void {
      if (settled) return;
      settled = true;
      clearTimers();
      if (o.killWorker) {
        try {
          handle?.kill();
        } catch {
          /* 已退出 */
        }
      }
      resolve(r);
    }

    /** 失败路径：立即结算并回收进程 */
    function finish(r: Result<void>, o: { killWorker: boolean } = { killWorker: true }): void {
      settle(r, o);
    }

    function onMessage(payload: WorkerReply): void {
      if (payload && payload.ok === true) {
        // N2：成功消息**不代表**可以立刻交付。旧实现 message 一到就 kill + resolve，
        // 于是下游可能在 worker 尚未真正退出、句柄/映射尚未释放时就开始操作同一批
        // 文件——这是「成功消息早于退出」的顺序问题（是否导致历史文件锁尚未证实，
        // 但契约上不该把回收未完成的进程当作已结束）。
        // 这里改为：记住成功，等 exit；exit 迟到则用有界等待兜底。
        successResult = ok(undefined);
        if (exitSeen) settle(successResult, { killWorker: false });
        else armExitGrace();
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
      exitSeen = true;
      if (successResult) {
        // 正常退出 + 成功回执：不再 kill（进程已经没了），直接交付
        settle(successResult, { killWorker: false });
        return;
      }
      // 没有回消息就退出：一定是异常终止
      finish(fail('STAGE_FAILED', `打包工作进程异常退出（code=${String(code)}）`, workerPath));
    }

    function onWorkerError(e: Error): void {
      // N2：派生失败/通道错误并非都同步抛出。Node 的 fork 返回对象后才 emit('error')；
      // 没有 error 监听时 EventEmitter 会把它抛出进程，变成不受控的未捕获异常。
      // 这里统一转成一次性的结构化失败，并停止计时、释放监听。
      finish(
        fail(
          'STAGE_FAILED',
          '打包工作进程派生或通道失败',
          '请重试；若持续失败请查看日志。',
          `${e.name}: ${e.message}${(e as NodeJS.ErrnoException).code ? ` (code=${(e as NodeJS.ErrnoException).code})` : ''}`,
        ),
      );
    }

    try {
      handle = opts.forkOverride
        ? opts.forkOverride(workerPath, onWorkerError)
        : utility
          ? forkWithUtilityProcess(workerPath, utility, onWorkerError)
          : forkWithNode(workerPath, onWorkerError);
      // 先挂监听再发消息：error 可能在任何时刻到达
      handle.onMessage(onMessage);
      handle.onExit(onExit);
      handle.onError(onWorkerError);
      handle.postMessage(job);
    } catch (e) {
      onWorkerError(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
