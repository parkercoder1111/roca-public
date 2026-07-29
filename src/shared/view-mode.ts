// src/shared/view-mode.ts
export type ViewMode = 'terminal' | 'optical'
export const DEFAULT_VIEW_MODE: ViewMode = 'terminal'
export const VIEW_MODE_STORAGE_KEY = 'roca:view-mode'
export function isViewMode(v: unknown): v is ViewMode {
  return v === 'terminal' || v === 'optical'
}
