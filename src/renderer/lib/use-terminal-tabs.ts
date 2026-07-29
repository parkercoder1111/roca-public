import { useCallback, useEffect, useState } from 'react'
import type { TerminalTab, TerminalTabFork, TerminalTabMirror } from '../components/terminal-tab-strip'

const DEFAULT_TABS: TerminalTab[] = [{ id: '', label: 'Main' }]

function storageKey(scope: string): string {
  return `roca:terminalTabs:${scope}`
}

function activeKey(scope: string): string {
  return `roca:terminalActiveTab:${scope}`
}

/**
 * Persistent tab state for a terminal scope ("assistant", "task-42", etc).
 * First tab has id='' — its pty session uses the legacy (no-suffix) id for
 * backwards compatibility; additional tabs get short unique ids.
 *
 * onCloseTab fires for each closed tab so callers can kill the underlying pty.
 */
export function useTerminalTabs(scope: string, onCloseTab?: (tabId: string) => void) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey(scope))
      if (saved) {
        const parsed = JSON.parse(saved)
        if (
          Array.isArray(parsed) && parsed.length > 0 &&
          parsed.every(t => typeof t?.id === 'string' && typeof t?.label === 'string')
        ) return parsed
      }
    } catch {}
    return DEFAULT_TABS
  })
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    return localStorage.getItem(activeKey(scope)) ?? ''
  })

  useEffect(() => {
    localStorage.setItem(storageKey(scope), JSON.stringify(tabs))
  }, [tabs, scope])
  useEffect(() => {
    localStorage.setItem(activeKey(scope), activeTabId)
  }, [activeTabId, scope])

  // Self-heal: if the persisted active tab isn't in the list, pick the first.
  useEffect(() => {
    if (!tabs.some(t => t.id === activeTabId)) {
      setActiveTabId(tabs[0]?.id ?? '')
    }
  }, [tabs, activeTabId])

  const addTab = useCallback((opts?: {
    label?: string
    fork?: TerminalTabFork
    mirror?: TerminalTabMirror
    host?: string
  }) => {
    const id = Date.now().toString(36)
    setTabs(prev => {
      let label = opts?.label
      if (!label) {
        if (opts?.fork) label = `⑂ ${opts.fork.sourceTitle}`
        else if (opts?.mirror) label = `↔ ${opts.mirror.sourceTitle}`
        else label = `Tab ${prev.length + 1}`
      }
      return [...prev, { id, label, fork: opts?.fork, mirror: opts?.mirror, host: opts?.host }]
    })
    setActiveTabId(id)
    return id
  }, [])

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      if (prev.length <= 1) return prev
      onCloseTab?.(id)
      const next = prev.filter(t => t.id !== id)
      setActiveTabId(cur => cur === id ? (next[next.length - 1]?.id ?? '') : cur)
      return next
    })
  }, [onCloseTab])

  const renameTab = useCallback((id: string, newLabel: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, label: newLabel } : t))
  }, [])

  return { tabs, activeTabId, setActiveTabId, addTab, closeTab, renameTab }
}
