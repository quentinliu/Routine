import type { RoutineApi } from '../shared/ipc';

declare global {
  interface Window {
    api: RoutineApi;
  }
}

export {};
