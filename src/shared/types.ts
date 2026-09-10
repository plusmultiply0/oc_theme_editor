/** 契约统一出口：类型与少量常量都从这里取，避免各处深引用。 */
export * from './schema';
export * from './ipc';
export type { AppError, ErrorCode, Result } from './errors';
export { ERROR_CODES, fail, isOk, ok, toAppError } from './errors';
