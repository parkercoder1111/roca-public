// src/renderer/lib/view-mode.ts
import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_VIEW_MODE,
  VIEW_MODE_STORAGE_KEY,
  isViewMode,
  type ViewMode,
} from '@shared/view-mode'

function readInitialViewMode(): ViewMode {
  const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
  return isViewMode(saved) ? saved : DEFAULT_VIEW_MODE
}

document.documentElement.setAttribute('data-view-mode', readInitialViewMode())

type Listener = (m: ViewMode) => void
const listeners = new Set<Listener>()

export function useViewMode(): [ViewMode, () => void] {
  const [mode, setMode] = useState<ViewMode>(readInitialViewMode)

  useEffect(() => {
    const l: Listener = (m) => setMode(m)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])

  const toggle = useCallback(() => {
    const next: ViewMode = readInitialViewMode() === 'terminal' ? 'optical' : 'terminal'
    document.documentElement.setAttribute('data-view-mode', next)
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, next)
    listeners.forEach((l) => l(next))
  }, [])

  return [mode, toggle]
}
