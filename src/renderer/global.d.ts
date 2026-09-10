import type { ThemeSwitcherApi } from '../shared/ipc';

declare global {
  interface Window {
    themeSwitcher: ThemeSwitcherApi;
  }
}

export {};
