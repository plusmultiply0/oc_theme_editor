/**
 * 统一错误码与 Result 契约。
 * 约定：绝不允许把异常吞成成功；所有失败必须带 recoveryHint 供 UI 显示下一步。
 */

export const ERROR_CODES = [
  'INVALID_PARAMS',
  'INTERNAL',

  // 图片
  'IMAGE_NOT_FOUND',
  'IMAGE_INVALID_FORMAT',
  'IMAGE_DECODE_FAILED',
  'IMAGE_TOO_LARGE',
  'IMAGE_UNCHANGED',

  // 目标识别
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'TARGET_UNSUPPORTED',
  'TARGET_VERSION_MISMATCH',
  'TARGET_RUNNING',
  'TARGET_HASH_MISMATCH',
  'TARGET_SIGNATURE_PROTECTED',

  // 环境
  'PERMISSION_DENIED',
  'DISK_FULL',
  'FILE_LOCKED',

  // 事务
  'TRANSACTION_IN_PROGRESS',
  'STAGE_FAILED',
  'BACKUP_FAILED',
  'BACKUP_HASH_MISMATCH',
  'BACKUP_MISSING',
  'MANIFEST_CORRUPT',
  'NEEDS_RECOVERY',
  'ROLLBACK_FAILED',

  // 主题
  'CONTRAST_BELOW_TARGET',
  'THEME_GENERATION_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  code: ErrorCode;
  /** 面向用户的中文说明，说明「发生了什么」 */
  message: string;
  /** 面向用户的下一步建议，说明「该怎么办」 */
  recoveryHint: string;
  /** 原始错误的技术细节，仅用于日志，默认不展示给用户 */
  detail?: string;
}

export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: AppError };

export function ok<T>(data: T): Result<T> {
  return { success: true, data };
}

export function fail(
  code: ErrorCode,
  message: string,
  recoveryHint: string,
  detail?: string,
): Result<never> {
  const error: AppError = { code, message, recoveryHint };
  if (detail !== undefined) error.detail = detail;
  return { success: false, error };
}

/** 把未知异常收敛为 AppError，保留 detail 供日志排查。 */
export function toAppError(e: unknown, fallback: ErrorCode = 'INTERNAL'): AppError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const maybe = e as Partial<AppError> & { code?: unknown };
    if (typeof maybe.code === 'string' && (ERROR_CODES as readonly string[]).includes(maybe.code)) {
      return {
        code: maybe.code as ErrorCode,
        message: typeof maybe.message === 'string' ? maybe.message : '发生未知错误',
        recoveryHint: typeof maybe.recoveryHint === 'string' ? maybe.recoveryHint : '请重试；若持续失败请查看日志。',
        ...(typeof maybe.detail === 'string' ? { detail: maybe.detail } : {}),
      };
    }
  }
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return {
    code: fallback,
    message: '发生未预期的错误',
    recoveryHint: '操作未产生破坏性改动；请重试或查看日志定位。',
    detail,
  };
}

/** 把 try/catch 捕获到的未知异常直接包成一个失败的 Result。 */
export function errorResult(e: unknown, fallback: ErrorCode = 'INTERNAL'): Result<never> {
  return { success: false, error: toAppError(e, fallback) };
}

export function isOk<T>(r: Result<T>): r is { success: true; data: T } {
  return r.success;
}
