import type { RoutineApi } from '../shared/ipc';

declare global {
  /** vite.config.ts define 注入，取自 package.json version */
  const __APP_VERSION__: string;

  interface Window {
    api: RoutineApi;
  }
}

export {};
