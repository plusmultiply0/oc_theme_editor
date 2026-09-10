/**
 * 运行数据布局（T34、T36、T40）。
 *
 * 所有运行数据放在系统用户数据目录，不进源码、不进安装目录、不进 OpenCode 用户配置。
 * 备份与事务按「安装实例 ID / 操作 ID」隔离。
 */
import path from 'node:path';
import fs from 'node:fs/promises';

export interface RuntimeDirs {
  root: string;
  locks: string;
  stage: string;
  backups: string;
  transactions: string;
  /** 实例隔离目录 */
  instance: string;
}

export interface RuntimeLayout extends RuntimeDirs {
  instanceId: string;
  backupsDir: string;
  txDir: string;
  stageDir: string;
}

export function runtimeDirs(root: string, instanceId: string): RuntimeLayout {
  const instance = path.join(root, 'instances', instanceId);
  return {
    root,
    instanceId,
    instance,
    locks: path.join(root, 'locks'),
    stage: path.join(root, 'stage'),
    backups: path.join(root, 'backups'),
    transactions: path.join(root, 'transactions'),
    backupsDir: path.join(instance, 'backups'),
    txDir: path.join(instance, 'transactions'),
    stageDir: path.join(instance, 'stage'),
  };
}

export async function ensureDirs(layout: RuntimeLayout): Promise<void> {
  for (const d of [
    layout.locks,
    layout.stage,
    layout.backups,
    layout.transactions,
    layout.instance,
    layout.backupsDir,
    layout.txDir,
    layout.stageDir,
  ]) {
    await fs.mkdir(d, { recursive: true });
  }
}

export function originalDir(layout: RuntimeLayout): string {
  return path.join(layout.backupsDir, 'original');
}

export function previousDir(layout: RuntimeLayout): string {
  return path.join(layout.backupsDir, 'previous');
}

/** 恢复前的现场备份，避免恢复失败把用户推到更糟的状态（T41） */
export function preRestoreDir(layout: RuntimeLayout): string {
  return path.join(layout.backupsDir, 'pre-restore');
}
