/**
 * 目标识别与环境预检（T30–T33）的合成安装测试。
 *
 * 全部使用临时目录内构造的合法 ASAR，不触碰任何真实安装。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  candidateRoots,
  discoverTargets,
  inspectRoot,
  onlySupported,
  parseRegDump,
  registryRoots,
  type InspectOutcome,
} from '../../src/core/patch/discover';
import { listAsarFiles, readAsar, sha256File } from '../../src/core/patch/asar';
import {
  canWriteDir,
  precheckTarget,
  requiredBytes,
  type ProcessProbe,
} from '../../src/core/patch/precheck';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import type { TargetInfo } from '../../src/shared/schema';

const installs: SyntheticInstall[] = [];

async function fixture(opts: Parameters<typeof makeSyntheticInstall>[0] = {}) {
  const inst = await makeSyntheticInstall(opts);
  installs.push(inst);
  return inst;
}

async function expectTarget(outcome: InspectOutcome): Promise<TargetInfo> {
  expect(outcome.kind).toBe('target');
  if (outcome.kind !== 'target') throw new Error('not a target');
  return outcome.target;
}

afterEach(() => {
  while (installs.length) installs.pop()?.cleanup();
});

describe('目标识别（T30、T31）', () => {
  it('识别已验证版本为 supported，并给出归档指纹', async () => {
    const inst = await fixture();
    const r = await inspectRoot(inst.root);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const t = await expectTarget(r.data);
    expect(t.support).toBe('supported');
    expect(t.version).toBe('1.18.29');
    expect(t.channel).toBe('windows-local-user-install');
    expect(t.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(t.fingerprint).toBe(await sha256File(inst.archivePath));
    expect(t.targetId).toContain('opencode-desktop-win-asar');
  });

  it('未验证版本判为 unknown，并给出原因，且不会被当成可应用目标', async () => {
    const inst = await fixture({ version: '9.9.9' });
    const r = await inspectRoot(inst.root);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const t = await expectTarget(r.data);
    expect(t.support).toBe('unknown');
    expect(t.rejectReason ?? '').toContain('未经验证');
    expect(onlySupported([r.data])).toHaveLength(0);
  });

  it('同名归档但包名不认识时判为 unsupported', async () => {
    const inst = await fixture({ pkgName: 'some-other-app' });
    const r = await inspectRoot(inst.root);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.kind).toBe('rejected');
    if (r.data.kind === 'rejected') {
      expect(r.data.rejected.support).toBe('unsupported');
      expect(r.data.rejected.code).toBe('TARGET_UNSUPPORTED');
      expect(r.data.rejected.message).toContain('some-other-app');
    }
  });

  it('目录里没有归档时判为 unknown，不猜测兼容', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-empty-'));
    installs.push({
      root: dir,
      srcDir: dir,
      archivePath: dir,
      exePath: dir,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    });
    const r = await inspectRoot(dir);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.kind).toBe('rejected');
    if (r.data.kind === 'rejected') expect(r.data.rejected.code).toBe('TARGET_NOT_FOUND');
  });

  it('路径不存在时识别直接失败', async () => {
    const r = await inspectRoot(path.join(os.tmpdir(), 'ots-no-such-dir-xyz'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('TARGET_NOT_FOUND');
  });

  it('候选位置只来自明确登记，不做全盘搜索', () => {
    const roots = candidateRoots({ localAppData: 'C:\\Users\\someone\\AppData\\Local' });
    expect(roots).toEqual(['C:\\Users\\someone\\AppData\\Local\\Programs\\@opencode-aidesktop']);
    expect(candidateRoots({ localAppData: '', useRegistry: false })).toEqual([]);
  });

  it('按候选位置扫描可发现目标，不存在的目录不出现在结果里', async () => {
    const inst = await fixture();
    const missing = path.join(os.tmpdir(), 'ots-missing-root-xyz');
    const { outcomes } = await discoverTargets({
      localAppData: '',
      extraRoots: [missing, inst.root],
      useRegistry: false,
    });
    expect(outcomes).toHaveLength(1);
    const t = await expectTarget(outcomes[0]);
    expect(t.support).toBe('supported');
  });
});

describe('卸载登记表的过滤（回归：真机上扫出满屏无关软件）', () => {
  /** 一段贴近 reg query 实际输出的样本 */
  const DISPLAY_DUMP = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{FIDDLER}',
    '    DisplayName    REG_SZ    Fiddler',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{POSTMAN}',
    '    DisplayName    REG_SZ    Postman',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{VSC}',
    '    DisplayName    REG_SZ    Microsoft VS Code',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{OC}',
    '    DisplayName    REG_SZ    OpenCode',
  ].join('\n');

  const INSTALL_DUMP =
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{OC}\n' +
    '    InstallLocation    REG_SZ    "C:\\Users\\someone\\AppData\\Local\\Programs\\@opencode-aidesktop\\"';

  const runner = (args: string[]): string => {
    if (args[args.length - 1] === 'DisplayName') return DISPLAY_DUMP;
    return INSTALL_DUMP;
  };

  it('只把名称相关的登记项当候选，无关软件一个都不扫', () => {
    const roots = candidateRoots({ localAppData: '', useRegistry: true, regRunner: runner });
    expect(roots).toEqual(['C:\\Users\\someone\\AppData\\Local\\Programs\\@opencode-aidesktop']);
  });

  it('登记值里的引号与尾部反斜杠会被清掉', () => {
    expect(registryRoots(runner)).toEqual([
      'C:\\Users\\someone\\AppData\\Local\\Programs\\@opencode-aidesktop',
    ]);
  });

  it('解析器按子键分组，认得出 DisplayName 与 InstallLocation', () => {
    const entries = parseRegDump(DISPLAY_DUMP);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ displayName: 'Fiddler' });
    expect(entries[3]).toMatchObject({ displayName: 'OpenCode' });
  });

  it('目录里没有归档的候选不算「未通过」，只计入已检查位置', async () => {
    const inst = await fixture();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-unrelated-'));
    installs.push({
      root: empty,
      srcDir: empty,
      archivePath: empty,
      exePath: empty,
      cleanup: () => fs.rmSync(empty, { recursive: true, force: true }),
    });

    const { outcomes, scanned } = await discoverTargets({
      localAppData: '',
      extraRoots: [empty, inst.root],
      useRegistry: false,
    });

    // 只有真正的目标出现在结果里；无关目录不再刷屏
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('target');
    // 但两个位置都确实被检查过
    expect(scanned).toHaveLength(2);
  });
});

describe('归档只读访问（T31、T36）', () => {
  it('能列出归档条目并读到 HTML 入口', async () => {
    const inst = await fixture();
    const snap = await readAsar(inst.archivePath);
    expect(snap.success).toBe(true);
    if (!snap.success) return;
    const files = listAsarFiles(snap.data.header);
    expect(files).toContain('package.json');
    expect(files).toContain('out/renderer/index.html');
    expect(snap.data.size).toBe(fs.statSync(inst.archivePath).size);
  });

  it('归档被改写后指纹随之变化，可用于提交前复核（T37）', async () => {
    const inst = await fixture();
    const before = await sha256File(inst.archivePath);
    fs.appendFileSync(inst.archivePath, 'x');
    const after = await sha256File(inst.archivePath);
    expect(after).not.toBe(before);
  });
});

describe('应用前预检（T32、T33）', () => {
  const idle: ProcessProbe = async () => 'idle';
  const running: ProcessProbe = async () => 'running';
  const unknownProbe: ProcessProbe = async () => 'unknown';

  async function target(root: string): Promise<TargetInfo> {
    const r = await inspectRoot(root);
    if (!r.success || r.data.kind !== 'target') throw new Error('fixture 不是可识别目标');
    return r.data.target;
  }

  it('目标正在运行时拒绝，并提示用户自行退出', async () => {
    const inst = await fixture();
    const r = await precheckTarget(await target(inst.root), { probe: running });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('TARGET_RUNNING');
      expect(r.error.recoveryHint).toContain('退出');
    }
  });

  it('无法确认进程状态时按「未退出」处理，不冒险写入', async () => {
    const inst = await fixture();
    const r = await precheckTarget(await target(inst.root), { probe: unknownProbe });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('TARGET_RUNNING');
      expect(r.error.message).toContain('无法确认');
    }
  });

  it('磁盘空间不足时在开始写入前拒绝', async () => {
    const inst = await fixture();
    const r = await precheckTarget(await target(inst.root), {
      probe: idle,
      archiveSize: 1024 * 1024 * 1024 * 1024,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('DISK_FULL');
  });

  it('目录不可写时拒绝', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-nowrite-'));
    installs.push({
      root: dir,
      srcDir: dir,
      archivePath: dir,
      exePath: dir,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    });
    expect(await canWriteDir(dir)).toBe(true);
    expect(await canWriteDir(path.join(dir, 'not-exist'))).toBe(false);
  });

  it('预检通过时报告归档大小与所需空间', async () => {
    const inst = await fixture();
    const size = fs.statSync(inst.archivePath).size;
    const r = await precheckTarget(await target(inst.root), { probe: idle });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.archiveSize).toBe(size);
      expect(r.data.processState).toBe('idle');
      expect(r.data.writable).toBe(true);
      expect(r.data.requiredBytes).toBe(requiredBytes(size));
      expect(r.data.requiredBytes).toBeGreaterThan(size * 2);
      expect(r.data.archivePath).toBe(inst.archivePath);
    }
  });

  it('所需空间覆盖备份、staged 与临时文件三份开销', () => {
    const size = 100 * 1024 * 1024;
    expect(requiredBytes(size)).toBeGreaterThanOrEqual(size * 3);
  });
});
