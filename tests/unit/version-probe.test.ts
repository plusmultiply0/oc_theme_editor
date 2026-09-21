/**
 * version-probe 探测脚本（tools/version-probe.cjs）单元测试 —— 计划 V2。
 *
 * 各场景全部对着**合成归档**跑（@electron/asar 真实打包），不触碰真实安装：
 *   1. 正常归档（锚点 1 次、无补丁文件、unpacked 在位）→ 全 PASS，退出 0；
 *   2. 锚点缺失 → 检查 4 FAIL，退出 1；
 *   3. 锚点两次 → 检查 4 FAIL，退出 1（S1 起判据收紧：落点不唯一即拒绝，不再 WARN）；
 *   4. 已含第三方 oc-theme-custom.css（无归属标记）→ 检查 5 FAIL，退出 1；
 *   5. 包名不符 → 检查 2 FAIL，退出 1；
 *   6. 版本不在白名单 → 检查 7 标 unknown，其余照常执行，退出 0。
 *
 * 注入缝：probeInstall(root) 只吃目录路径，检查 4/5/6 消费 out/core/patch/compat-check
 * ——判据与产品链路单一来源，测试与真机跑的是同一套检查逻辑。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeSyntheticInstall } from '../fixtures/synthetic-install';

const requireCjs = createRequire(import.meta.url);
const probe = requireCjs('../../tools/version-probe.cjs') as {
  probeInstall: (root: string, opts?: Record<string, unknown>) => Promise<ProbeReport>;
};

interface ProbeCheck {
  id: number;
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  basis: string;
  detail: string | null;
}
interface ProbeReport {
  root: string;
  adapterId: string | null;
  version: string | null;
  fingerprint16: string | null;
  support: string;
  checks: ProbeCheck[];
  conclusion: 'PASS' | 'WARN' | 'FAIL';
  exitCode: number;
  nextStep: string;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function makeProbeInstall(
  opts: Parameters<typeof makeSyntheticInstall>[0] & { withUnpacked?: boolean } = {},
): Promise<string> {
  const { withUnpacked = true, ...installOpts } = opts;
  const inst = await makeSyntheticInstall(installOpts);
  cleanups.push(inst.cleanup);
  if (withUnpacked) {
    const dir = path.join(inst.root, 'resources', 'app.asar.unpacked');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'native.node'), 'fake-native');
  }
  return inst.root;
}

function check(rep: ProbeReport, id: number): ProbeCheck {
  const c = rep.checks.find((x) => x.id === id);
  if (!c) throw new Error(`缺少检查项 ${id}`);
  return c;
}

describe('version-probe：七项检查与退出码约定', () => {
  it('场景 1：正常归档 → 七项全 PASS，退出 0', async () => {
    const rep = await probe.probeInstall(await makeProbeInstall());
    expect(rep.checks).toHaveLength(7);
    expect(rep.checks.every((c) => c.status === 'PASS')).toBe(true);
    expect(rep.conclusion).toBe('PASS');
    expect(rep.exitCode).toBe(0);
    expect(rep.support).toBe('supported');
    expect(rep.fingerprint16).toMatch(/^[0-9a-f]{16}$/);
  });

  it('场景 2：HTML 无 </head> → 检查 4 FAIL，退出 1', async () => {
    const root = await makeProbeInstall({
      files: { 'out/renderer/index.html': '<html><body>no head here</body></html>' },
    });
    const rep = await probe.probeInstall(root);
    expect(check(rep, 4).status).toBe('FAIL');
    expect(check(rep, 4).detail).toContain('0 次');
    expect(rep.conclusion).toBe('FAIL');
    expect(rep.exitCode).toBe(1);
  });

  it('场景 3：</head> 出现两次 → 检查 4 FAIL，退出 1（落点不唯一即拒绝）', async () => {
    const root = await makeProbeInstall({
      files: {
        'out/renderer/index.html':
          '<html><head><title>a</title></head><head><title>b</title></head><body></body></html>',
      },
    });
    const rep = await probe.probeInstall(root);
    expect(check(rep, 4).status).toBe('FAIL');
    expect(check(rep, 4).detail).toContain('2 次');
    expect(rep.conclusion).toBe('FAIL');
    expect(rep.exitCode).toBe(1);
  });

  it('场景 3b：归档已含本工具产物（注入标记+生成标记齐全）→ 检查 5 PASS，再应用可覆盖', async () => {
    const root = await makeProbeInstall({
      files: {
        'out/renderer/index.html':
          '<!doctype html><html><head><title>t</title>' +
          '<link rel="stylesheet" href="./oc-theme-custom.css"> <!-- opencode-theme-switcher -->\n' +
          '</head><body></body></html>',
        'out/renderer/oc-theme-custom.css': '/* 由 OpenCode 换肤助手生成；示例 */\nhtml{}',
      },
    });
    const rep = await probe.probeInstall(root);
    expect(check(rep, 4).status).toBe('PASS');
    expect(check(rep, 5).status).toBe('PASS');
    expect(check(rep, 5).detail).toContain('本工具产物');
    expect(rep.exitCode).toBe(0);
  });

  it('场景 4：归档已含 oc-theme-custom.css → 检查 5 FAIL，退出 1', async () => {
    const root = await makeProbeInstall({
      files: { 'out/renderer/oc-theme-custom.css': 'body{}' },
    });
    const rep = await probe.probeInstall(root);
    expect(check(rep, 5).status).toBe('FAIL');
    expect(check(rep, 5).detail).toContain('oc-theme-custom.css');
    expect(rep.conclusion).toBe('FAIL');
    expect(rep.exitCode).toBe(1);
  });

  it('场景 5：包名不符 → 检查 2 FAIL，退出 1', async () => {
    const root = await makeProbeInstall({ pkgName: 'org.unrelated.app' });
    const rep = await probe.probeInstall(root);
    expect(check(rep, 2).status).toBe('FAIL');
    expect(check(rep, 2).detail).toContain('org.unrelated.app');
    expect(rep.exitCode).toBe(1);
  });

  it('场景 6：版本不在白名单 → 检查 7 标 unknown，其余照常，退出 0', async () => {
    const root = await makeProbeInstall({ version: '9.9.9' });
    const rep = await probe.probeInstall(root);
    expect(check(rep, 7).status).toBe('WARN');
    expect(check(rep, 7).detail).toContain('9.9.9');
    expect(rep.support).toBe('unknown');
    // 不中断：其余检查照常给出真实结论
    for (const id of [1, 2, 3, 4, 5, 6]) expect(check(rep, id).status).toBe('PASS');
    expect(rep.exitCode).toBe(0);
  });

  it('目录不存在 → 结构错误，退出 2', async () => {
    const rep = await probe.probeInstall(path.join(':', 'definitely-not-here-ots'));
    expect(rep.exitCode).toBe(2);
    expect(rep.conclusion).toBe('FAIL');
  });
});
