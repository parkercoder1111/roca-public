import React, { useRef, useState, useEffect, useCallback } from 'react'
import type { Task } from '@shared/types'

interface BrowserTab {
  id: number
  url: string
  title: string
}

interface Props {
  task: Task
  isActive: boolean
  visible?: boolean
  pendingUrl?: string | null
  onPendingUrlConsumed?: () => void
  pendingInstruction?: string | null
  onPendingInstructionConsumed?: () => void
}

function normalizeUrl(raw: string): string {
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    return 'https://' + raw
  }
  return raw
}

export default function TaskBrowser({ task, isActive, visible, pendingUrl, onPendingUrlConsumed, pendingInstruction, onPendingInstructionConsumed }: Props) {
  const extMenuRef = useRef<HTMLDivElement | null>(null)
  const tabIdCounter = useRef(0)
  const webviewRefs = useRef<Map<number, Electron.WebviewTag>>(new Map())

  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [isSessionActive, setIsSessionActive] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<{ code: number; description: string } | null>(null)
  const [claudeInstruction, setClaudeInstruction] = useState('')
  const [isClaudeActive, setIsClaudeActive] = useState(false)
  const [claudeStatus, setClaudeStatus] = useState<string | null>(null)
  const [thoughts, setThoughts] = useState<{ id: number; text: string }[]>([])
  const [thoughtsExpanded, setThoughtsExpanded] = useState(false)
  const thoughtIdRef = useRef(0)
  const thoughtsEndRef = useRef<HTMLDivElement | null>(null)
  const [extensions, setExtensions] = useState<{ id: string; name: string; path: string }[]>([])
  const [showExtMenu, setShowExtMenu] = useState(false)
  const [showExtDialog, setShowExtDialog] = useState(false)
  const [extPathInput, setExtPathInput] = useState('')
  const [extLoadError, setExtLoadError] = useState<string | null>(null)

  // --- Extension management (unchanged) ---
  const refreshExtensions = useCallback(async () => {
    try {
      const exts = await window.electronAPI.listExtensions()
      setExtensions(exts)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { refreshExtensions() }, [refreshExtensions])

  useEffect(() => {
    if (!showExtMenu) return
    const handler = (e: MouseEvent) => {
      if (extMenuRef.current && !extMenuRef.current.contains(e.target as Node)) {
        setShowExtMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showExtMenu])

  const hasClaudeExtension = extensions.some(e =>
    e.name.toLowerCase().includes('claude')
  )

  const handleLoadExtension = useCallback(() => {
    setExtPathInput('')
    setExtLoadError(null)
    setShowExtDialog(true)
  }, [])

  const handleExtDialogSubmit = useCallback(async () => {
    const path = extPathInput.trim()
    if (!path) return
    setExtLoadError(null)
    const result = await window.electronAPI.loadExtension(path)
    if (result.ok) {
      await refreshExtensions()
      setShowExtDialog(false)
      setExtPathInput('')
    } else {
      setExtLoadError(result.error || 'Failed to load extension')
    }
  }, [extPathInput, refreshExtensions])

  const handleRemoveExtension = useCallback(async (id: string) => {
    await window.electronAPI.removeExtension(id)
    await refreshExtensions()
  }, [refreshExtensions])

  // --- Tab helpers ---
  const createTab = useCallback((url: string): number => {
    const id = ++tabIdCounter.current
    const normalizedUrl = normalizeUrl(url)
    setTabs(prev => [...prev, { id, url: normalizedUrl, title: normalizedUrl }])
    setActiveTabId(id)
    setUrlInput(normalizedUrl)
    return id
  }, [])

  const closeTab = useCallback((tabId: number) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId)
      // If we're closing the active tab, switch to neighbor
      setActiveTabId(current => {
        if (current !== tabId) return current
        const idx = prev.findIndex(t => t.id === tabId)
        if (next.length === 0) return null
        return next[Math.min(idx, next.length - 1)].id
      })
      return next
    })
    // Clean up webview ref
    webviewRefs.current.delete(tabId)
  }, [])

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null

  // --- Persist tabs to DB so they survive app restart / update ---
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistTabs = useCallback((currentTabs: BrowserTab[], currentActiveId: number | null) => {
    if (currentTabs.length === 0) return
    // Debounce to avoid spamming DB on rapid navigations
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      const serialized = currentTabs.map(t => ({ url: t.url, title: t.title }))
      const activeIdx = currentActiveId != null ? currentTabs.findIndex(t => t.id === currentActiveId) : 0
      window.electronAPI.browserSaveTabs(task.id, serialized, Math.max(0, activeIdx)).catch(() => {})
    }, 300)
  }, [task.id])

  // Save whenever tabs or activeTabId change
  useEffect(() => {
    if (isSessionActive && tabs.length > 0) {
      persistTabs(tabs, activeTabId)
    }
  }, [tabs, activeTabId, isSessionActive, persistTabs])

  // --- Session management ---
  const ensureSession = useCallback(async () => {
    if (isSessionActive) return
    try {
      await window.electronAPI.createBrowserSession(task.id, 'local')
      setIsSessionActive(true)
    } catch (err) {
      console.error('[TaskBrowser] Failed to start session:', err)
    }
  }, [task.id, isSessionActive])

  const handleStartSession = useCallback(async () => {
    await ensureSession()
    if (tabs.length > 0) return // Already have tabs (restored)

    // Try restoring saved tabs from a previous session
    try {
      const saved = await window.electronAPI.browserLoadTabs(task.id)
      if (saved && saved.tabs.length > 0) {
        const restored: BrowserTab[] = saved.tabs.map(t => ({
          id: ++tabIdCounter.current,
          url: t.url,
          title: t.title,
        }))
        setTabs(restored)
        const activeId = restored[Math.min(saved.activeIndex, restored.length - 1)]?.id ?? restored[0]?.id
        setActiveTabId(activeId)
        setUrlInput(restored.find(t => t.id === activeId)?.url ?? '')
        return
      }
    } catch { /* ignore — fall through to default */ }

    createTab('https://www.google.com')
  }, [ensureSession, tabs.length, createTab, task.id])

  const handleStopSession = useCallback(async () => {
    await window.electronAPI.browserStopClaude(task.id).catch(() => {})
    await window.electronAPI.destroyBrowserSession(task.id).catch(() => {})
    // Explicit "End" — clear saved tabs so they don't restore next time
    await window.electronAPI.browserDeleteTabs(task.id).catch(() => {})
    setIsSessionActive(false)
    setTabs([])
    setActiveTabId(null)
    webviewRefs.current.clear()
  }, [task.id])

  // --- Register active tab's webContentsId with main process (for Claude screenshots) ---
  useEffect(() => {
    if (!activeTabId || !isSessionActive) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (!wv) return
    const register = () => {
      try {
        const wcId = wv.getWebContentsId()
        if (wcId) window.electronAPI.browserRegisterWebContents(task.id, wcId)
      } catch { /* webview not ready yet */ }
    }
    // Try now (may already be ready), and also on next dom-ready
    register()
    wv.addEventListener('dom-ready', register)
    return () => { wv.removeEventListener('dom-ready', register) }
  }, [activeTabId, isSessionActive, task.id])

  // --- Claude status + thought listeners ---
  useEffect(() => {
    const removeSt = window.electronAPI.onBrowserStatus(task.id, (status) => {
      setIsClaudeActive(status.isClaudeActive)
      setClaudeStatus(status.claudeStatus)
    })
    const removeTh = window.electronAPI.onBrowserThought(task.id, (thought) => {
      setThoughts(prev => [...prev, { id: thoughtIdRef.current++, text: thought }].slice(-200))
    })
    return () => { removeSt(); removeTh() }
  }, [task.id])

  // Auto-scroll thoughts
  useEffect(() => {
    thoughtsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [thoughts])

  const handleSendClaude = useCallback(async () => {
    if (!claudeInstruction.trim() || !isSessionActive) return
    setThoughts([])
    setIsClaudeActive(true)
    setClaudeStatus('Starting...')
    setThoughtsExpanded(true)
    await window.electronAPI.browserSendInstruction(task.id, claudeInstruction.trim())
    setClaudeInstruction('')
  }, [task.id, claudeInstruction, isSessionActive])

  const handleStopClaude = useCallback(() => {
    window.electronAPI.browserStopClaude(task.id)
      .then(() => { setIsClaudeActive(false); setClaudeStatus(null) })
      .catch(() => { setIsClaudeActive(false); setClaudeStatus(null) })
  }, [task.id])

  // --- Pending URL from terminal link click → new tab ---
  useEffect(() => {
    if (!pendingUrl) return
    const url = normalizeUrl(pendingUrl)

    const open = async () => {
      await ensureSession()
      createTab(url)
      onPendingUrlConsumed?.()
    }
    open()
  }, [pendingUrl, ensureSession, createTab, onPendingUrlConsumed])

  // --- Pending instruction from /browse command → send once session + webview ready ---
  useEffect(() => {
    if (!pendingInstruction || !isSessionActive) return
    const send = async () => {
      try {
        await window.electronAPI.browserSendInstruction(task.id, pendingInstruction)
      } catch (err) {
        console.error('[TaskBrowser] Failed to send instruction:', err)
      }
      onPendingInstructionConsumed?.()
    }
    send()
  }, [pendingInstruction, isSessionActive, task.id, onPendingInstructionConsumed])

  // --- Webview event wiring per tab ---
  const attachWebviewEvents = useCallback((tabId: number, webview: Electron.WebviewTag) => {
    const wv = webview as any

    const onDomReady = () => {
      try {
        const wcId = wv.getWebContentsId()
        if (wcId) {
          window.electronAPI.browserRegisterWebContents(task.id, wcId)
        }
      } catch { /* not ready */ }
    }

    const onDidNavigate = (e: any) => {
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, url: e.url } : t))
      setActiveTabId(current => {
        if (current === tabId) setUrlInput(e.url)
        return current
      })
    }

    const onTitleUpdate = (e: any) => {
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title: e.title || t.url } : t))
    }

    const onNewWindow = (e: any) => {
      e.preventDefault()
      const targetUrl = e.url
      if (targetUrl && targetUrl !== 'about:blank') {
        createTab(targetUrl)
      }
    }

    const onDidFailLoad = (e: any) => {
      if (e.errorCode === -3) return
      const messages: Record<string, string> = {
        '-6': 'Connection refused',
        '-21': 'Network unreachable',
        '-105': 'DNS lookup failed',
        '-106': 'Internet disconnected',
        '-130': 'SSL certificate error',
        '-137': 'Connection timed out',
      }
      setActiveTabId(current => {
        if (current === tabId) {
          setLoadError({ code: e.errorCode, description: messages[e.errorCode] ?? (e.errorDescription || `Error ${e.errorCode}`) })
        }
        return current
      })
    }

    const onDidStartLoading = () => {
      setActiveTabId(current => {
        if (current === tabId) { setIsLoading(true); setLoadError(null) }
        return current
      })
    }

    const onDidStopLoading = () => {
      setActiveTabId(current => {
        if (current === tabId) setIsLoading(false)
        return current
      })
    }

    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('did-navigate', onDidNavigate)
    webview.addEventListener('did-navigate-in-page', onDidNavigate)
    webview.addEventListener('page-title-updated', onTitleUpdate)
    webview.addEventListener('new-window', onNewWindow)
    webview.addEventListener('did-fail-load', onDidFailLoad)
    webview.addEventListener('did-start-loading', onDidStartLoading)
    webview.addEventListener('did-stop-loading', onDidStopLoading)

    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigate)
      webview.removeEventListener('page-title-updated', onTitleUpdate)
      webview.removeEventListener('new-window', onNewWindow)
      webview.removeEventListener('did-fail-load', onDidFailLoad)
      webview.removeEventListener('did-start-loading', onDidStartLoading)
      webview.removeEventListener('did-stop-loading', onDidStopLoading)
    }
  }, [task.id, createTab])

  // --- Active tab switching: sync URL bar + loading state ---
  useEffect(() => {
    if (!activeTab) return
    setUrlInput(activeTab.url)
    setLoadError(null)
    setIsLoading(false)
  }, [activeTabId]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Navigation on active tab ---
  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv && typeof wv.loadURL === 'function') {
      const target = normalizeUrl(urlInput)
      wv.loadURL(target)
      setUrlInput(target)
    }
  }, [activeTabId, urlInput])

  const handleBack = useCallback(() => {
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv?.canGoBack?.()) wv.goBack()
  }, [activeTabId])

  const handleForward = useCallback(() => {
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv?.canGoForward?.()) wv.goForward()
  }, [activeTabId])

  const handleRefresh = useCallback(() => {
    if (!activeTabId) return
    const wv = webviewRefs.current.get(activeTabId) as any
    if (wv?.reload) wv.reload()
  }, [activeTabId])

  // --- Auto-start session when panel becomes visible ---
  useEffect(() => {
    if (!visible || isSessionActive || tabs.length > 0) return
    // If there's a pending URL, let its own effect handle tab creation
    if (pendingUrl) {
      ensureSession()
    } else {
      handleStartSession() // starts session + opens Google tab
    }
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Tab bar */}
      {tabs.length > 0 && (
        <div className="shrink-0 flex items-center bg-surface-1 border-b border-black/[0.06] overflow-x-auto">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`group flex items-center gap-1 min-w-0 max-w-[180px] px-2.5 py-1.5 border-r border-black/[0.06] cursor-pointer transition-colors ${
                tab.id === activeTabId
                  ? 'bg-surface-0 text-text-1'
                  : 'text-text-3 hover:text-text-2 hover:bg-black/[0.02]'
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="text-[10px] truncate flex-1">{tab.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                className="shrink-0 w-3.5 h-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-black/[0.1] transition-all"
                aria-label="Close tab"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
          {/* New tab button */}
          <button
            onClick={() => createTab('https://www.google.com')}
            className="shrink-0 p-1.5 text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all"
            aria-label="New tab"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      )}

      {/* Control bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-surface-0 border-b border-black/[0.06]">
        <button onClick={handleBack} aria-label="Go back" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-2 transition-all">
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button onClick={handleForward} aria-label="Go forward" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-2 transition-all">
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button onClick={handleRefresh} aria-label="Refresh" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-2 transition-all">
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <form onSubmit={handleNavigate} className="flex-1 mx-2">
          <input
            type="text"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            className="w-full bg-black/[0.04] border border-black/[0.06] rounded-md px-3 py-1 text-[10px] text-text-2 focus:outline-none focus:border-purple-1/30"
            placeholder="Enter URL..."
          />
        </form>

        {/* Extension indicator / menu */}
        <div className="relative" ref={extMenuRef}>
          <button
            onClick={() => setShowExtMenu(prev => !prev)}
            className={`p-1 rounded hover:bg-black/[0.06] transition-all ${
              hasClaudeExtension ? 'text-green-1' : 'text-text-3 hover:text-text-2'
            }`}
            aria-label={hasClaudeExtension ? 'Claude extension active' : 'Manage extensions'}
            aria-haspopup="menu"
            aria-expanded={showExtMenu}
            title={hasClaudeExtension ? 'Claude extension active' : 'Manage extensions'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
            </svg>
          </button>
          {showExtMenu && (
            <div
              role="menu"
              onKeyDown={(e) => { if (e.key === 'Escape') setShowExtMenu(false) }}
              className="absolute right-0 top-full mt-1 w-56 bg-surface-0 border border-black/[0.08] rounded-lg shadow-lg z-50 py-1">
              <div className="px-3 py-1.5 text-[9px] font-medium text-text-3 uppercase tracking-wide">Extensions</div>
              {extensions.map(ext => (
                <div key={ext.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-black/[0.04]">
                  <span className="text-[10px] text-text-2 truncate flex-1">{ext.name}</span>
                  <button
                    onClick={() => handleRemoveExtension(ext.id)}
                    className="text-[9px] text-red-1 hover:text-red-1/70 ml-2"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {extensions.length === 0 && (
                <div className="px-3 py-1.5 text-[10px] text-text-3">No extensions loaded</div>
              )}
              <div className="border-t border-black/[0.06] mt-1 pt-1">
                <button
                  onClick={() => { handleLoadExtension(); setShowExtMenu(false) }}
                  className="w-full px-3 py-1.5 text-left text-[10px] text-purple-1 hover:bg-black/[0.04]"
                >
                  Load Extension...
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={handleStopSession}
          className="px-2.5 py-1 rounded-lg text-[10px] font-medium text-red-1 hover:bg-red-2 transition-all"
        >
          End
        </button>
      </div>

      {/* Extension path dialog */}
      {showExtDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Load Chrome Extension"
          className="shrink-0 px-3 py-2.5 bg-surface-1 border-b border-black/[0.06]"
          onKeyDown={e => { if (e.key === 'Escape') { setShowExtDialog(false); setExtLoadError(null) } }}
        >
          <p className="text-[10px] font-medium text-text-2 mb-1.5">Load Chrome Extension</p>
          <input
            type="text"
            value={extPathInput}
            onChange={e => setExtPathInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleExtDialogSubmit(); if (e.key === 'Escape') { setShowExtDialog(false); setExtLoadError(null) } }}
            placeholder="/path/to/unpacked/extension"
            className="w-full bg-black/[0.04] border border-black/[0.06] rounded-lg px-2.5 py-1.5 text-[10px] text-text-2 placeholder-text-3 focus:outline-none focus:border-purple-1/30 mb-1.5"
            autoFocus
          />
          {extLoadError && (
            <p className="text-[10px] text-red-1 mb-1.5">{extLoadError}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleExtDialogSubmit}
              disabled={!extPathInput.trim()}
              className="px-2.5 py-1 rounded-md text-[10px] font-medium bg-purple-2 text-purple-1 hover:opacity-80 disabled:opacity-30 transition-all"
            >
              Load
            </button>
            <button
              onClick={() => { setShowExtDialog(false); setExtLoadError(null) }}
              className="px-2.5 py-1 rounded-md text-[10px] font-medium text-text-3 hover:bg-black/[0.06] transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Webviews — one per tab, only active is visible */}
      <div className="flex-1 relative">
        {tabs.map(tab => (
          <WebviewTab
            key={tab.id}
            tabId={tab.id}
            url={tab.url}
            taskTitle={task.title}
            taskId={task.id}
            visible={tab.id === activeTabId}
            webviewRefs={webviewRefs}
            attachEvents={attachWebviewEvents}
          />
        ))}
        {activeTabId && isLoading && !loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-0/80 z-10 pointer-events-none">
            <div className="w-5 h-5 rounded-full border-2 border-purple-1/30 border-t-purple-1 animate-spin" />
          </div>
        )}
        {activeTabId && loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-0/95 z-10">
            <svg className="w-10 h-10 text-red-1 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="text-[12px] font-medium text-text-1">{loadError.description}</p>
            <button
              onClick={handleRefresh}
              className="px-3 py-1.5 rounded-lg text-[10px] font-medium bg-black/[0.06] text-text-2 hover:bg-black/[0.1] transition-colors"
            >
              Retry
            </button>
          </div>
        )}
        {tabs.length === 0 && isSessionActive && (
          <div className="absolute inset-0 flex items-center justify-center text-text-3">
            <p className="text-[11px]">No tabs open</p>
          </div>
        )}
      </div>

      {/* Thought stream */}
      {thoughts.length > 0 && (
        <div className="shrink-0 border-t border-black/[0.06] bg-surface-0">
          <button
            onClick={() => setThoughtsExpanded(prev => !prev)}
            className="w-full flex items-center justify-between px-3 py-1 hover:bg-black/[0.02] transition-colors"
          >
            <span className="text-[9px] font-medium text-text-3 flex items-center gap-1.5">
              <svg className={`w-2.5 h-2.5 transition-transform ${thoughtsExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Claude thoughts
              <span className="text-text-3">({thoughts.length})</span>
            </span>
            {isClaudeActive && <span className="w-1.5 h-1.5 rounded-full bg-purple-1 animate-pulse" />}
          </button>
          {thoughtsExpanded && (
            <div className="max-h-[140px] overflow-y-auto px-3 pb-2 space-y-0.5">
              {thoughts.map(({ id, text: t }) => (
                <div key={id} className={`text-[9px] leading-relaxed font-mono ${
                  t.startsWith('[error]') ? 'text-red-1' :
                  t.startsWith('[action]') ? 'text-blue-1' :
                  t.startsWith('[done]') ? 'text-green-1' :
                  t.startsWith('[system]') ? 'text-text-3/50' :
                  t.startsWith('User:') ? 'text-purple-1' :
                  'text-text-3'
                }`}>
                  {t}
                </div>
              ))}
              <div ref={thoughtsEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Claude status — driven from terminal via /browse */}
      {claudeStatus && (
        <div className="shrink-0 border-t border-black/[0.06] bg-surface-0 px-3 py-1.5">
          <div className="flex items-center gap-2 text-[10px]">
            {isClaudeActive && <span className="w-1.5 h-1.5 rounded-full bg-purple-1 animate-pulse" />}
            {!isClaudeActive && claudeStatus.startsWith('Error') && <span className="w-1.5 h-1.5 rounded-full bg-red-1" />}
            {!isClaudeActive && claudeStatus.startsWith('Done') && <span className="w-1.5 h-1.5 rounded-full bg-green-1" />}
            <span className="truncate text-text-3">{claudeStatus}</span>
            {isClaudeActive && (
              <button
                onClick={handleStopClaude}
                className="ml-auto px-2 py-0.5 rounded text-[9px] font-medium text-red-1 hover:bg-red-2 transition-all"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Individual webview wrapper — mounts once per tab, navigates after dom-ready */
function WebviewTab({ tabId, url, taskTitle, taskId, visible, webviewRefs, attachEvents }: {
  tabId: number
  url: string
  taskTitle: string
  taskId: number
  visible: boolean
  webviewRefs: React.MutableRefObject<Map<number, Electron.WebviewTag>>
  attachEvents: (tabId: number, webview: Electron.WebviewTag) => () => void
}) {
  const localRef = useRef<Electron.WebviewTag | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const initialUrlRef = useRef(url)

  // Register ref, wait for dom-ready, THEN navigate + attach events
  const setRef = useCallback((el: Electron.WebviewTag | null) => {
    if (el && el !== localRef.current) {
      localRef.current = el
      webviewRefs.current.set(tabId, el)

      const onReadyOnce = () => {
        el.removeEventListener('dom-ready', onReadyOnce)
        // Register webContentsId immediately — available after first dom-ready
        try {
          const wcId = (el as any).getWebContentsId()
          if (wcId) window.electronAPI.browserRegisterWebContents(taskId, wcId)
        } catch { /* not ready */ }
        // Now safe to call webview methods
        try {
          ;(el as any).loadURL(initialUrlRef.current)
        } catch (err) {
          console.error('[WebviewTab] loadURL failed:', err)
        }
        if (cleanupRef.current) cleanupRef.current()
        cleanupRef.current = attachEvents(tabId, el)
      }
      el.addEventListener('dom-ready', onReadyOnce)
    }
  }, [tabId, taskId, webviewRefs, attachEvents])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current()
      webviewRefs.current.delete(tabId)
    }
  }, [tabId, webviewRefs])

  return (
    <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
      <webview
        ref={setRef as any}
        src="about:blank"
        title={`${taskTitle} — tab`}
        className="w-full h-full"
        {...{ allowpopups: '' } as any}
      />
    </div>
  )
}
