/**
 * 图片格式与扩展名别名的**唯一声明处**（T1）。
 *
 * 为什么要有这个文件：此前系统文件对话框、主进程校验、界面文案各自手写扩展名列表，
 * 结果 `.jfif` / `.jpe`（都是标准 JPEG 别名，本机 sharp 明确支持）在选择框里看不见、
 * 选到了也会被校验拒绝 —— 是入口支持不完整，不是解码能力不足。
 *
 * 纪律：
 * - 纯数据 + 纯函数。**不引入 sharp / node:fs / electron**，
 *   因为这个模块同时被 renderer 的文案与主进程的校验引用。
 * - 扩展名只用于**筛选**，不是安全凭证：内容必须通过 magic bytes 识别与真实解码。
 * - 同一个内容格式可以有多个扩展名（别名），枚举值仍是内容格式，不新增 `jfif` 之类的伪格式。
 */

/** 内容格式枚举：与 `core/theme/validate.ts` 的 `ImageFormat` 取值一致 */
export type ImageFormatId = 'png' | 'jpeg' | 'webp';

/** 供运行时校验用（Array 形式，便于测试比对） */
export const imageFormatIdSchema: readonly ImageFormatId[] = ['png', 'jpeg', 'webp'];

export interface ImageFormatSpec {
  id: ImageFormatId;
  /** 界面上显示的格式名 */
  label: string;
  /** 不带点、全小写的扩展名别名 */
  extensions: readonly string[];
  mimeTypes: readonly string[];
  /** 界面提示用的一句话说明 */
  note: string;
}

export const IMAGE_FORMATS: readonly ImageFormatSpec[] = [
  {
    id: 'jpeg',
    label: 'JPEG',
    // jfif / jpe 是标准别名：同一份 JPEG 字节，换名字不该被拒
    extensions: ['jpg', 'jpeg', 'jfif', 'jpe'],
    mimeTypes: ['image/jpeg'],
    note: '照片常用；不支持透明',
  },
  {
    id: 'png',
    label: 'PNG',
    extensions: ['png'],
    mimeTypes: ['image/png'],
    note: '支持透明',
  },
  {
    id: 'webp',
    label: 'WebP',
    extensions: ['webp'],
    mimeTypes: ['image/webp'],
    note: '体积小；动图只取第一帧（后续版本）',
  },
];

/** 带点的允许扩展名（主进程校验用） */
export const ALLOWED_EXTENSIONS: readonly string[] = IMAGE_FORMATS.flatMap((f) =>
  f.extensions.map((e) => `.${e}`),
);

/** 不带点的扩展名（系统文件对话框 filters 用） */
export const DIALOG_EXTENSIONS: readonly string[] = IMAGE_FORMATS.flatMap((f) => f.extensions);

/** 界面提示：把别名写清楚，避免用户以为 .jfif 不支持 */
export const SUPPORTED_FORMATS_HINT = IMAGE_FORMATS.map(
  (f) => `${f.label}（${f.extensions.map((e) => `.${e}`).join('/')}）`,
).join('、');

/** 文件名的扩展名（带点、小写）；没有扩展名返回空串 */
export function extensionOf(fileName: string): string {
  const base = fileName.trim().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot).toLowerCase();
}

/** 扩展名（带点或不带点均可）→ 内容格式；未登记返回 null */
export function formatIdForExtension(ext: string): ImageFormatId | null {
  const normalized = (ext.startsWith('.') ? ext.slice(1) : ext).toLowerCase();
  if (!normalized) return null;
  const hit = IMAGE_FORMATS.find((f) => f.extensions.includes(normalized));
  return hit ? hit.id : null;
}

/** 是否属于允许的扩展名（传完整文件名或扩展名都行） */
export function isAllowedExtension(nameOrExt: string): boolean {
  const ext = nameOrExt.includes('.') && !nameOrExt.startsWith('.')
    ? extensionOf(nameOrExt)
    : (nameOrExt.startsWith('.') ? nameOrExt : extensionOf(nameOrExt));
  return formatIdForExtension(ext) !== null;
}

export function labelForFormatId(id: ImageFormatId): string {
  return IMAGE_FORMATS.find((f) => f.id === id)?.label ?? id;
}

export function mimeTypesForFormatId(id: ImageFormatId): readonly string[] {
  return IMAGE_FORMATS.find((f) => f.id === id)?.mimeTypes ?? [];
}

/**
 * 命名的后缀与实际内容不一致时的说明（都是受支持格式）。
 * 返回 null 表示一致或无法判断；调用方据此提示用户，但不阻断导入。
 */
export function describeExtensionMismatch(
  fileName: string,
  actual: ImageFormatId | null,
): string | null {
  if (!actual) return null;
  const byExt = formatIdForExtension(extensionOf(fileName));
  if (!byExt || byExt === actual) return null;
  return `文件后缀是 ${labelForFormatId(byExt)}，实际内容是 ${labelForFormatId(actual)}；已按实际内容处理。`;
}
