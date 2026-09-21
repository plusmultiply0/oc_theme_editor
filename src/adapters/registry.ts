/**
 * adapter 注册表。新增兼容目标必须在这里显式登记，并写明取证来源。
 */
import { OPENCODE_DESKTOP_ADAPTER } from './opencode-desktop';
import type { TargetAdapter } from './types';

export const ADAPTERS: readonly TargetAdapter[] = [OPENCODE_DESKTOP_ADAPTER];

/** 扫描用的安装目录名候选，只取明确登记过的，避免全盘搜索 */
export function knownInstallDirNames(): string[] {
  return ADAPTERS.flatMap((a) => [...a.installDirNames]);
}

export function adapterById(id: string): TargetAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

/**
 * 按归档 package.json 找到 adapter；匹配不上返回 null（调用方应判为 unknown）。
 * 版本不在白名单时也返回 adapter，由调用方按两通道定 support（S5 口径刷新）：
 * 名单命中→whitelist；未命中→结构验证决定 structural 或 unknown——
 * 「认得出但没验证」和「完全不认识」要能区分开。
 */
export function adapterForPackage(pkg: { name?: string; version?: string }): TargetAdapter | null {
  return ADAPTERS.find((a) => a.matches(pkg)) ?? null;
}
