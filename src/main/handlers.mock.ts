/**
 * P1 用的 mock 处理器：用假数据贯通 F1–F5 五项界面行为，
 * 让 renderer 可以在 P2/P3 未完成时先行联调（计划 G1）。
 *
 * 这些实现不访问真实安装、不写任何文件、不读取图片内容。
 * P2/P3 完成后由真实服务替换，接口与返回形状保持不变。
 */
import type { IpcMain } from 'electron';
import { fail, ok } from '../shared/errors';
import type {
  AnalyzeContrastInput,
  ApplyThemeInput,
  GenerateThemeInput,
  PickedImage,
  RestoreThemeInput,
  StageThemeInput,
  ThemeTokens,
} from '../shared/types';

const MOCK_IMAGE_ID = 'img_mock_0001';
const MOCK_TARGET_ID = 'tgt_mock_0001';
const MOCK_OPERATION_ID = 'op_mock_0001';

const baseTokens: ThemeTokens = {
  background: '#f5f7fa',
  panel: '#ffffff',
  text: '#1a1a1a',
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

/** 与真实实现共用同一份模板的占位版本，保证预览与输出同源（T53） */
function renderCss(tokens: ThemeTokens): string {
  const lines = Object.entries(tokens)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `  --ts-${k}: ${v as string};`);
  const status = Object.entries(tokens.status).map(([k, v]) => `  --ts-status-${k}: ${v};`);
  const diff = Object.entries(tokens.diff).map(([k, v]) => `  --ts-diff-${k}: ${v};`);
  return [':root {', ...lines, ...status, ...diff, '}'].join('\n');
}

export function registerMockHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('pickImage', async (): Promise<ReturnType<typeof ok<PickedImage>>> => {
    return ok({ imageId: MOCK_IMAGE_ID, fileName: 'mock-wallpaper.jpg', byteSize: 1709733 });
  });

  ipcMain.handle('importImage', async (_e, imageId: string) => {
    if (!imageId) return fail('INVALID_PARAMS', '缺少图片标识', '请重新选择图片。');
    return ok({
      imageId,
      hash: 'c903b31597d486dcc34bc997e1251fc741a0c84e882cb3295ebd3d6c4d319ed3',
      width: 2800,
      height: 1200,
      thumbnailId: 'thumb_mock_0001',
    });
  });

  ipcMain.handle('generateTheme', async (_e, input: GenerateThemeInput) => {
    if (!input?.imageId) return fail('INVALID_PARAMS', '缺少图片标识', '请先导入图片。');
    return ok({ tokens: baseTokens, css: renderCss(baseTokens) });
  });

  ipcMain.handle('analyzeContrast', async (_e, input: AnalyzeContrastInput) => {
    if (!input?.tokens) return fail('INVALID_PARAMS', '尚未生成主题', '请先生成配色。');
    return ok({
      entries: [
        {
          element: '正文',
          state: 'default',
          foreground: baseTokens.text,
          background: baseTokens.panel,
          ratio: 12.9,
          required: 4.5,
          target: 'text' as const,
          pass: true,
        },
        {
          element: '主按钮文字',
          state: 'default',
          foreground: baseTokens.onPrimary,
          background: baseTokens.primary,
          ratio: 5.02,
          required: 4.5,
          target: 'text' as const,
          pass: true,
        },
        {
          element: '输入框边框',
          state: 'default',
          foreground: baseTokens.border,
          background: baseTokens.panel,
          ratio: 1.32,
          required: 3,
          target: 'ui' as const,
          pass: false,
        },
      ],
      passed: false,
      scope: 'mock：仅覆盖示例元素，不代表完整界面',
      sampling: 'mock：未做真实像素采样',
      verified: false,
    });
  });

  ipcMain.handle('discoverTargets', async () => {
    return ok([
      {
        targetId: MOCK_TARGET_ID,
        installPath: '<mock 安装路径>',
        channel: 'mock',
        version: '1.18.29',
        adapterId: 'mock',
        fingerprint: 'mock-fingerprint',
        support: 'unsupported' as const,
        rejectReason: 'P1 阶段为 mock 目标，真实识别在 P3 实现',
      },
    ]);
  });

  ipcMain.handle('inspectTarget', async (_e, targetId: string) => {
    if (targetId !== MOCK_TARGET_ID) {
      return fail('TARGET_NOT_FOUND', '未找到该目标', '请在列表中重新选择安装位置。');
    }
    return ok({
      targetId: MOCK_TARGET_ID,
      installPath: '<mock 安装路径>',
      channel: 'mock',
      version: '1.18.29',
      adapterId: 'mock',
      fingerprint: 'mock-fingerprint',
      support: 'unsupported' as const,
      rejectReason: 'P1 阶段为 mock 目标，真实识别在 P3 实现',
    });
  });

  ipcMain.handle('stageTheme', async (_e, input: StageThemeInput) => {
    if (!input?.targetId) return fail('INVALID_PARAMS', '缺少目标标识', '请先选择安装目标。');
    return ok({
      operationId: MOCK_OPERATION_ID,
      manifest: {
        schema: 1,
        operationId: MOCK_OPERATION_ID,
        targetId: input.targetId,
        version: '1.18.29',
        adapterId: 'mock',
        beforeHash: 'mock-before',
        afterHash: 'mock-after',
        backupHash: 'mock-backup',
        backupPath: '<mock 备份路径>',
        themeSummary: 'mock 主题',
        status: 'staged' as const,
        createdAt: new Date().toISOString(),
      },
    });
  });

  ipcMain.handle('applyTheme', async (_e, input: ApplyThemeInput) => {
    if (!input?.operationId) return fail('INVALID_PARAMS', '缺少操作标识', '请重新执行应用。');
    return fail(
      'TARGET_UNSUPPORTED',
      'mock 目标不允许真实应用',
      'P3 完成后将接入真实适配器；当前仅可预览。',
    );
  });

  ipcMain.handle('listBackups', async () => {
    return ok([
      {
        operationId: MOCK_OPERATION_ID,
        createdAt: new Date().toISOString(),
        kind: 'original' as const,
        themeSummary: '原始未定制版本',
        applicableVersion: '1.18.29',
      },
    ]);
  });

  ipcMain.handle('restoreTheme', async (_e, _input: RestoreThemeInput) => {
    return fail('TARGET_UNSUPPORTED', 'mock 目标不允许恢复操作', 'P3 完成后可用。');
  });

  ipcMain.handle('getOperation', async (_e, operationId: string) => {
    if (operationId !== MOCK_OPERATION_ID) {
      return fail('MANIFEST_CORRUPT', '未找到该操作记录', '请刷新后重试。');
    }
    return ok({
      schema: 1,
      operationId: MOCK_OPERATION_ID,
      targetId: MOCK_TARGET_ID,
      version: '1.18.29',
      adapterId: 'mock',
      beforeHash: 'mock-before',
      afterHash: 'mock-after',
      backupHash: 'mock-backup',
      backupPath: '<mock 备份路径>',
      themeSummary: 'mock 主题',
      status: 'staged' as const,
      createdAt: new Date().toISOString(),
    });
  });
}
