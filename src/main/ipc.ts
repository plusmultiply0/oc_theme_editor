/**
 * IPC 处理器注册（T13、T14）。
 *
 * 三条硬规则：
 * - renderer 传进来的只能是 ID 与参数对象，任何路径一律不接受。
 * - 每个处理器都 try/catch，异常收敛成 AppError，绝不抛给 renderer，也绝不吞成成功。
 * - 外链只放行 https，交给主进程打开（T56）。
 */
import type { IpcMain } from 'electron';
import { errorResult, fail, ok, type Result } from '../shared/errors';
import type {
  AnalyzeContrastInput,
  ApplyThemeInput,
  RestoreThemeInput,
  StageThemeInput,
  GenerateThemeInput,
} from '../shared/ipc';
import type { ImageStore } from './services/image-store';
import type { TargetService } from './services/target-service';
import type { ThemeService } from './services/theme-service';
import type { OperationService } from './services/operation-service';
import type { OperationEventBus } from './services/events';

export interface HandlerDeps {
  images: ImageStore;
  targets: TargetService;
  themes: ThemeService;
  operations: OperationService;
  bus: OperationEventBus;
  openExternal(url: string): Promise<void>;
}

function requireString(v: unknown, name: string): Result<string> {
  if (typeof v !== 'string' || v.length === 0) {
    return fail('INVALID_PARAMS', `缺少${name}`, '请重试；若持续失败请重启应用。');
  }
  return ok(v);
}

export function registerHandlers(ipcMain: IpcMain, deps: HandlerDeps): void {
  const wrap = async <T>(fn: () => Promise<Result<T>>): Promise<Result<T>> => {
    try {
      return await fn();
    } catch (e) {
      return errorResult(e);
    }
  };

  ipcMain.handle('pickImage', () => wrap(() => deps.images.pick()));

  ipcMain.handle('importImage', (_e, imageId: unknown) =>
    wrap(async () => {
      const id = requireString(imageId, '图片标识');
      if (!id.success) return id;
      return deps.images.import(id.data);
    }),
  );

  ipcMain.handle('generateTheme', (_e, input: GenerateThemeInput) =>
    wrap(() => deps.themes.generate(input)),
  );

  ipcMain.handle('analyzeContrast', (_e, input: AnalyzeContrastInput) =>
    wrap(() => deps.themes.analyze(input)),
  );

  ipcMain.handle('discoverTargets', () => wrap(() => deps.targets.discover()));

  ipcMain.handle('inspectTarget', (_e, targetId: unknown) =>
    wrap(async () => {
      const id = requireString(targetId, '目标标识');
      if (!id.success) return id;
      return deps.targets.refresh(id.data);
    }),
  );

  ipcMain.handle('stageTheme', (_e, input: StageThemeInput) =>
    wrap(() => deps.operations.stage(input)),
  );

  ipcMain.handle('applyTheme', (_e, input: ApplyThemeInput) =>
    wrap(() => deps.operations.apply(input)),
  );

  ipcMain.handle('listBackups', (_e, targetId: unknown) =>
    wrap(async () => {
      const id = requireString(targetId, '目标标识');
      if (!id.success) return id;
      return deps.operations.listBackups(id.data);
    }),
  );

  ipcMain.handle('restoreTheme', (_e, input: RestoreThemeInput) =>
    wrap(() => deps.operations.restore(input)),
  );

  ipcMain.handle('getOperation', (_e, operationId: unknown) =>
    wrap(async () => {
      const id = requireString(operationId, '操作标识');
      if (!id.success) return id;
      return deps.operations.getOperation(id.data);
    }),
  );

  ipcMain.handle('openExternal', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      return ok(false);
    }
    try {
      await deps.openExternal(url);
      return ok(true);
    } catch (e) {
      return errorResult(e);
    }
  });
}
