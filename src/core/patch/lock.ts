/**
 * 安装实例独占锁（T34）。
 *
 * 界面按钮禁用只是辅助手段，后端必须有真正的并发保护：
 * 锁文件用 `wx` 独占创建，进程号写进文件用于识别残留锁。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fail, ok, type Result } from '../../shared/errors';

export interface LockHandle {
  instanceId: string;
  file: string;
  release(): Promise<void>;
}

/**
 * 同进程内已持有的锁。
 * 单进程里连开两次事务时，锁文件的持有者就是自己，
 * 若只靠「pid 是自己就当残留锁清理」会把并发保护整个绕过。
 */
const heldInProcess = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(file, 'utf8')).trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 获取实例独占锁。已被其他进程持有时返回 TRANSACTION_IN_PROGRESS，
 * 不会因为界面没禁按钮就放行第二次事务。
 */
export async function acquireLock(locksDir: string, instanceId: string): Promise<Result<LockHandle>> {
  await fs.mkdir(locksDir, { recursive: true });
  const file = path.join(locksDir, `${instanceId}.lock`);

  if (heldInProcess.has(instanceId)) {
    return fail(
      'TRANSACTION_IN_PROGRESS',
      '该安装已有操作正在进行',
      '请等待当前操作结束；界面按钮禁用只是辅助，真正的并发保护在后端。',
    );
  }

  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(String(process.pid), 'utf8');
    await handle.close();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      return fail('FILE_LOCKED', '无法创建锁文件', '请检查运行数据目录是否可写。', String(e));
    }
    // 残留锁：持有进程已不在则清理，否则判定为并发事务
    const pid = await readPid(file);
    if (pid !== null && pid !== process.pid && pidAlive(pid)) {
      return fail(
        'TRANSACTION_IN_PROGRESS',
        '该安装已有操作正在进行',
        '请等待当前操作结束；界面按钮禁用只是辅助，真正的并发保护在后端。',
      );
    }
    try {
      await fs.rm(file, { force: true });
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(String(process.pid), 'utf8');
      await handle.close();
    } catch (e2) {
      return fail('FILE_LOCKED', '获取锁失败', '请稍后重试。', String(e2));
    }
  }

  heldInProcess.add(instanceId);
  return ok({
    instanceId,
    file,
    async release() {
      heldInProcess.delete(instanceId);
      try {
        const current = await readPid(file);
        if (current === null || current === process.pid) {
          await fs.rm(file, { force: true });
        }
      } catch {
        // 释放失败不掩盖主流程结果，交由启动扫描处理
      }
    },
  });
}

/** 在锁内执行；无论成功失败都释放锁 */
export async function withLock<T>(
  locksDir: string,
  instanceId: string,
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const lock = await acquireLock(locksDir, instanceId);
  if (!lock.success) return lock;
  try {
    return await fn();
  } finally {
    await lock.data.release();
  }
}
