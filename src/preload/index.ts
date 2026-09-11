/**
 * 最小允许列表桥接：只暴露契约中声明的方法，不暴露 ipcRenderer 本身，
 * 也不提供任意路径写入或 shell 能力（计划第 3 节、T14）。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ThemeSwitcherApi } from '../shared/ipc';

const api: ThemeSwitcherApi = {
  pickImage: () => ipcRenderer.invoke('pickImage'),
  importImage: (imageId) => ipcRenderer.invoke('importImage', imageId),
  generateTheme: (input) => ipcRenderer.invoke('generateTheme', input),
  analyzeContrast: (input) => ipcRenderer.invoke('analyzeContrast', input),
  discoverTargets: () => ipcRenderer.invoke('discoverTargets'),
  inspectTarget: (targetId) => ipcRenderer.invoke('inspectTarget', targetId),
  stageTheme: (input) => ipcRenderer.invoke('stageTheme', input),
  applyTheme: (input) => ipcRenderer.invoke('applyTheme', input),
  listBackups: (targetId) => ipcRenderer.invoke('listBackups', targetId),
  restoreTheme: (input) => ipcRenderer.invoke('restoreTheme', input),
  getOperation: (operationId) => ipcRenderer.invoke('getOperation', operationId),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  onOperationEvent: (listener) => {
    const handler = (_event: unknown, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on('operation-event', handler);
    return () => {
      ipcRenderer.removeListener('operation-event', handler);
    };
  },
};

contextBridge.exposeInMainWorld('themeSwitcher', api);
