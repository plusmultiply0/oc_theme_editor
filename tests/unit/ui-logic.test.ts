/**
 * 界面纯逻辑测试（T51、T54、T55）。
 * 状态判定写错最容易造成「明明不能应用却放行」或「失败后不说清有没有改过安装」，
 * 这部分规则必须可测，不能只靠肉眼看界面。
 */
import { describe, expect, it } from 'vitest';
import {
  blockedReason,
  canStage,
  clampSpec,
  errorScope,
  formatBytes,
  formatDateTime,
  isBusy,
  makeSpec,
  resetSpec,
  scopeText,
} from '../../src/renderer/logic';
import { ERROR_CODES } from '../../src/shared/errors';

const readyArgs = {
  hasImage: true,
  hasPreview: true,
  targetSupported: true,
  reportPassed: true,
  busy: false,
};

describe('参数（T52）', () => {
  it('默认参数落在允许范围内', () => {
    const spec = makeSpec('img-1');
    expect(spec.overlayOpacity).toBeGreaterThanOrEqual(0);
    expect(spec.overlayOpacity).toBeLessThanOrEqual(1);
    expect(spec.panelOpacity).toBeGreaterThanOrEqual(0);
    expect(spec.panelOpacity).toBeLessThanOrEqual(1);
    expect(spec.blurPx).toBeGreaterThanOrEqual(0);
    expect(spec.blurPx).toBeLessThanOrEqual(20);
  });

  it('重置参数保留当前图片', () => {
    const spec = { ...makeSpec('img-1'), overlayOpacity: 0.9, blurPx: 12 };
    const reset = resetSpec(spec);
    expect(reset.imageId).toBe('img-1');
    expect(reset.overlayOpacity).toBe(makeSpec().overlayOpacity);
    expect(reset.blurPx).toBe(0);
  });

  it('越界值被夹紧，不会把非法参数送到主进程', () => {
    const spec = clampSpec({ ...makeSpec(), overlayOpacity: 3, panelOpacity: -1, blurPx: 99 });
    expect(spec.overlayOpacity).toBe(1);
    expect(spec.panelOpacity).toBe(0);
    expect(spec.blurPx).toBe(20);
  });
});

describe('应用按钮可用条件（T54）', () => {
  it('条件齐备才允许进入准备阶段', () => {
    expect(canStage(readyArgs)).toBe(true);
  });

  it.each([
    ['未选图片', { hasImage: false }],
    ['配色尚未生成', { hasPreview: false }],
    ['目标未验证', { targetSupported: false }],
    ['可读性未达标', { reportPassed: false }],
    ['正在忙', { busy: true }],
  ])('%s 时一律不允许应用', (_name, patch) => {
    expect(canStage({ ...readyArgs, ...patch })).toBe(false);
  });

  it('被阻断时给出可行动的中文原因', () => {
    expect(blockedReason({ hasImage: false, hasPreview: false, targetSupported: true, reportPassed: true })).toContain('图片');
    expect(blockedReason({ hasImage: true, hasPreview: true, targetSupported: false, reportPassed: true })).toContain('预览');
    expect(blockedReason({ hasImage: true, hasPreview: true, targetSupported: true, reportPassed: false })).toContain('遮罩');
    expect(blockedReason({ hasImage: true, hasPreview: true, targetSupported: true, reportPassed: true })).toBeNull();
  });
});

describe('失败状态判定（T55）', () => {
  it('提交前失败：安装未被修改', () => {
    for (const code of ['TARGET_RUNNING', 'PERMISSION_DENIED', 'DISK_FULL', 'BACKUP_HASH_MISMATCH', 'CONTRAST_BELOW_TARGET'] as const) {
      expect(errorScope(code)).toBe('unmodified');
    }
  });

  it('提交后无法自证：如实告知可能已修改', () => {
    for (const code of ['NEEDS_RECOVERY', 'ROLLBACK_FAILED', 'TARGET_HASH_MISMATCH'] as const) {
      expect(errorScope(code)).toBe('maybe-modified');
    }
  });

  it('每个错误码都有明确归类，不留下含糊的默认分支', () => {
    for (const code of ERROR_CODES) {
      expect(['unmodified', 'maybe-modified', 'unknown']).toContain(errorScope(code));
    }
    // 只有 INTERNAL / MANIFEST_CORRUPT 这类无法判定的才允许 unknown
    expect(errorScope('INTERNAL')).toBe('unknown');
  });

  it('状态文案说明「有没有改过安装」', () => {
    expect(scopeText('unmodified')).toContain('未被修改');
    expect(scopeText('maybe-modified')).toContain('可能已被修改');
    expect(scopeText('unknown')).toContain('无法自动判定');
  });
});

describe('状态机（T51）', () => {
  it('仅三类状态视为忙，避免界面在忙时重复提交', () => {
    expect(isBusy({ kind: 'analyzing' })).toBe(true);
    expect(isBusy({ kind: 'staging' })).toBe(true);
    expect(isBusy({ kind: 'applying', phase: '写入中' })).toBe(true);
    expect(isBusy({ kind: 'ready' })).toBe(false);
    expect(isBusy({ kind: 'confirming' })).toBe(false);
    expect(isBusy({ kind: 'empty' })).toBe(false);
  });
});

describe('格式化', () => {
  it('字节数按 MB / KB 显示', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(230 * 1024 * 1024)).toBe('230 MB');
  });

  it('时间显示到分钟，非法输入原样返回', () => {
    expect(formatDateTime('2026-09-10T08:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
