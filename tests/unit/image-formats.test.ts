/**
 * 图片格式与扩展名别名声明（T1，见 handoff/format-review-2026-09-12/NEXT_EXECUTION_PLAN.md）。
 *
 * 这份声明必须只有一处，且是**纯数据 + 纯函数**：
 * 系统文件对话框、主进程校验、界面文案都从它生成，
 * 不允许各自手写扩展名列表（那正是 .jfif 打不开的原因）。
 *
 * 注意：它会被 renderer 侧的文案引用，因此不能引入 sharp、node:fs 之类的运行时依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EXTENSIONS,
  DIALOG_EXTENSIONS,
  IMAGE_FORMATS,
  SUPPORTED_FORMATS_HINT,
  extensionOf,
  formatIdForExtension,
  imageFormatIdSchema,
  isAllowedExtension,
  labelForFormatId,
  mimeTypesForFormatId,
} from '../../src/shared/image-formats';

describe('格式声明本身', () => {
  it('JPEG 把 jfif / jpe 作为同义扩展名，不再只有 jpg/jpeg', () => {
    const jpeg = IMAGE_FORMATS.find((f) => f.id === 'jpeg');
    expect(jpeg).toBeDefined();
    expect(jpeg?.extensions).toEqual(['jpg', 'jpeg', 'jfif', 'jpe']);
  });

  it('PNG 与 WebP 保持原样', () => {
    expect(IMAGE_FORMATS.find((f) => f.id === 'png')?.extensions).toEqual(['png']);
    expect(IMAGE_FORMATS.find((f) => f.id === 'webp')?.extensions).toEqual(['webp']);
  });

  it('允许扩展名与对话框扩展名从同一份声明派生，且一一对应', () => {
    const fromRegistry = IMAGE_FORMATS.flatMap((f) => f.extensions.map((e) => `.${e}`));
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual([...fromRegistry].sort());
    expect([...DIALOG_EXTENSIONS].sort()).toEqual(
      [...IMAGE_FORMATS.flatMap((f) => f.extensions)].sort(),
    );
    // 对话框用的不带点
    for (const e of DIALOG_EXTENSIONS) expect(e.startsWith('.')).toBe(false);
    for (const e of ALLOWED_EXTENSIONS) expect(e.startsWith('.')).toBe(true);
  });

  it('界面提示覆盖全部别名，包含 jfif 与 jpe', () => {
    for (const e of ['jpg', 'jpeg', 'jfif', 'jpe', 'png', 'webp']) {
      expect(SUPPORTED_FORMATS_HINT).toContain(e);
    }
  });

  it('枚举值与内容识别用的 ImageFormat 对齐', () => {
    expect(imageFormatIdSchema).toEqual(['png', 'jpeg', 'webp']);
    expect(labelForFormatId('jpeg')).toBe('JPEG');
    expect(mimeTypesForFormatId('jpeg')).toContain('image/jpeg');
  });
});

describe('扩展名解析（大小写不敏感、扩展名只用于筛选）', () => {
  it.each([
    ['a.JFIF', '.jfif'],
    ['photo.jpe', '.jpe'],
    ['some.dir/图片.JpEg', '.jpeg'],
    ['noext', ''],
    ['trailing.', ''],
    ['中文名称.jfif', '.jfif'],
  ])('%s → %s', (name, want) => {
    expect(extensionOf(name)).toBe(want);
  });

  it('别名映射到内容格式 jpeg，不新增 jfif 枚举值', () => {
    for (const ext of ['jpg', 'jpeg', 'jfif', 'jpe', '.JFIF', 'JPE']) {
      expect(formatIdForExtension(ext)).toBe('jpeg');
    }
    expect(formatIdForExtension('png')).toBe('png');
    expect(formatIdForExtension('svg')).toBeNull();
    expect(formatIdForExtension('')).toBeNull();
  });

  it('允许判定对完整文件名与扩展名都成立', () => {
    expect(isAllowedExtension('图.JFIF')).toBe(true);
    expect(isAllowedExtension('.jpe')).toBe(true);
    expect(isAllowedExtension('a.svg')).toBe(false);
    expect(isAllowedExtension('noext')).toBe(false);
  });
});

describe('这份声明必须保持纯净（界面会引用它）', () => {
  it('不 import sharp / node:fs / node:path / electron', () => {
    const file = path.resolve(__dirname, '..', '..', 'src', 'shared', 'image-formats.ts');
    const source = fs.readFileSync(file, 'utf8');
    // 只看真正的 import 语句：注释里提到这些名字是说明，不是依赖
    const imports = source
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line))
      .join('\n');
    expect(imports).toBe('');
    for (const forbidden of ['sharp', 'node:fs', 'node:path', 'electron']) {
      expect(source.includes(`from '${forbidden}'`), `不应 import ${forbidden}`).toBe(false);
    }
  });
});
