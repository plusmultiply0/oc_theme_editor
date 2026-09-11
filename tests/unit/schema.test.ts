import { describe, expect, it } from 'vitest';
import { fail, ok, toAppError } from '../../src/shared/errors';
import {
  PARAM_RANGES,
  SCHEMA_VERSION,
  TargetInfoSchema,
  ThemeSpecSchema,
  ThemeTokensSchema,
} from '../../src/shared/schema';

const validTokens = {
  background: '#f5f7fa',
  panel: '#ffffff',
  text: '#1a1a1a',
  accentText: '#1a4fa0',
  muted: '#5a5a5a',
  primary: '#3b6fd4',
  onPrimary: '#ffffff',
  hover: '#5a8ae0',
  pressed: '#2f5cae',
  border: '#d7dce5',
  focus: '#3b6fd4',
  selection: '#cfe0ff',
  status: { error: '#c0392b', warning: '#b7791f', success: '#2f855a', info: '#2b6cb0' },
  diff: { added: '#2f855a', removed: '#c0392b', context: '#6b7280' },
};

const validSpec = {
  schemaVersion: SCHEMA_VERSION,
  imageId: 'img_1',
  mode: 'auto' as const,
  palette: ['#404558', '#787e9f'],
  overlayOpacity: 0.35,
  panelOpacity: 0.86,
  blurPx: 4,
  reducedTransparency: false,
};

describe('ThemeTokens', () => {
  it('接受合法 token 集合', () => {
    expect(ThemeTokensSchema.safeParse(validTokens).success).toBe(true);
  });

  it('拒绝非法颜色写法', () => {
    const r = ThemeTokensSchema.safeParse({ ...validTokens, text: 'rgb(0,0,0)' });
    expect(r.success).toBe(false);
  });

  it('语义状态色缺失时报错，避免与主色混淆', () => {
    const { status, ...rest } = validTokens;
    expect(ThemeTokensSchema.safeParse(rest).success).toBe(false);
    expect(status).toBeDefined();
  });
});

describe('ThemeSpec 参数范围（T24）', () => {
  it('接受边界值', () => {
    const at = {
      ...validSpec,
      overlayOpacity: PARAM_RANGES.overlayOpacity.min,
      panelOpacity: PARAM_RANGES.panelOpacity.max,
      blurPx: PARAM_RANGES.blurPx.max,
    };
    expect(ThemeSpecSchema.safeParse(at).success).toBe(true);
  });

  it.each([
    ['overlayOpacity', PARAM_RANGES.overlayOpacity.max + 0.01],
    ['panelOpacity', PARAM_RANGES.panelOpacity.min - 0.01],
    ['blurPx', PARAM_RANGES.blurPx.max + 1],
  ])('拒绝越界的 %s', (key, value) => {
    expect(ThemeSpecSchema.safeParse({ ...validSpec, [key]: value }).success).toBe(false);
  });
});

describe('TargetInfo', () => {
  const target = {
    targetId: 't1',
    installPath: 'C:/Program Files/demo',
    channel: 'github',
    version: '1.18.29',
    adapterId: 'asar-resource',
    fingerprint: 'abc123',
    support: 'supported' as const,
  };

  it('接受受支持目标', () => {
    expect(TargetInfoSchema.safeParse(target).success).toBe(true);
  });

  it('未受支持时必须能携带拒绝原因', () => {
    const r = TargetInfoSchema.parse({ ...target, support: 'unsupported', rejectReason: '版本未验证' });
    expect(r.rejectReason).toBe('版本未验证');
  });
});

describe('Result 契约', () => {
  it('ok 携带数据', () => {
    const r = ok({ a: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.a).toBe(1);
  });

  it('fail 必须带恢复建议', () => {
    const r = fail('TARGET_RUNNING', 'OpenCode 正在运行', '请保存任务后退出应用。');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('TARGET_RUNNING');
      expect(r.error.recoveryHint).not.toBe('');
    }
  });

  it('未知异常收敛为 INTERNAL 且保留细节', () => {
    const e = toAppError(new Error('boom'));
    expect(e.code).toBe('INTERNAL');
    expect(e.detail).toContain('boom');
  });
});
