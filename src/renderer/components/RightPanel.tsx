import React, { useState, useCallback, useEffect, useRef } from 'react'
import type { Task, Upload } from '@shared/types'
import { ASSISTANT_TASK_ID } from '@shared/constants'
import TaskDetail from './TaskDetail'
import TaskTerminal from './TaskTerminal'
import TaskBrowser from './TaskBrowser'
import FileSidebar from './FileSidebar'
import VoiceMode from './VoiceMode'
import { renderMarkdownStyled } from '../lib/renderMarkdown'

export type PanelTab = 'notes' | 'terminal'

const BROWSER_MIN_WIDTH = 360
const BROWSER_MAX_WIDTH = 2000
const BROWSER_DEFAULT_WIDTH = 600

function BrowserPanel({ taskId, task, browserTaskIds, browserTasksRef, pendingUrl, onPendingUrlConsumed, pendingInstruction, onPendingInstructionConsumed, visible }: {
  taskId: number
  task: Task
  browserTaskIds: Set<number>
  browserTasksRef: React.MutableRefObject<Map<number, Task>>
  pendingUrl?: string | null
  onPendingUrlConsumed?: () => void
  pendingInstruction?: string | null
  onPendingInstructionConsumed?: () => void
  visible: boolean
}) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('roca:browserWidth')
    return saved ? Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, parseInt(saved, 10))) : BROWSER_DEFAULT_WIDTH
  })
  const [dragging, setDragging] = useState(false)
  const isResizing = useRef(false)
  const widthRef = useRef(width)
  widthRef.current = width

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    setDragging(true)
    const startX = e.clientX
    const startWidth = widthRef.current

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, startWidth + (startX - ev.clientX)))
      setWidth(newWidth)
    }
    const onMouseUp = () => {
      isResizing.current = false
      setDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem('roca:browserWidth', String(widthRef.current))
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  return (
    <div className="relative shrink-0 bg-surface-0 border-l border-black/[0.06] flex flex-col h-full" style={{ width }}>
      {/* Resize drag handle (left edge) */}
      <div
        className="absolute top-0 left-0 w-[4px] h-full cursor-col-resize hover:bg-purple-1/20 transition-colors z-10"
        onMouseDown={handleResizeStart}
      />
      {/* Block pointer events on webview during resize to prevent it from stealing mouse */}
      {dragging && <div className="absolute inset-0 z-[5]" />}
      {Array.from(browserTaskIds).map(tid => (
        <div key={tid} className={`h-full ${tid === taskId ? 'flex flex-col' : 'hidden'}`}>
          <TaskBrowser
            task={tid === taskId ? task : browserTasksRef.current.get(tid)!}
            isActive={tid === taskId}
            visible={visible && tid === taskId}
            pendingUrl={tid === taskId ? pendingUrl : undefined}
            onPendingUrlConsumed={tid === taskId ? onPendingUrlConsumed : undefined}
            pendingInstruction={tid === taskId ? pendingInstruction : undefined}
            onPendingInstructionConsumed={tid === taskId ? onPendingInstructionConsumed : undefined}
          />
        </div>
      ))}
    </div>
  )
}

interface Props {
  task: Task
  onDataChange: () => void
  onToggleRecurring: (taskId: number, isRecurring: boolean) => void
  onComplete: (taskId: number) => void
  onStatusChange: (taskId: number, status: string) => void
  onPriorityChange: (taskId: number, priority: string) => void
  onTitleChange: (taskId: number, title: string) => void
  initialTab?: PanelTab
  onTabChanged?: () => void
  autoCommand?: string | null
  onAutoCommandConsumed?: () => void
  pendingVoiceText?: string | null
  onVoiceTextConsumed?: () => void
  onClaudeResponse?: (text: string) => void
  voiceTextToSpeak?: string
  onVoiceTextToSpeakConsumed?: () => void
  onVoiceTranscript?: (text: string) => void
  onSlashCommand?: (command: string, args: string) => void
  onDuplicateTask?: (taskId: number) => void
  onCollapseTaskList?: () => void
  taskListCollapsed?: boolean
}

export default function RightPanel({
  task, onDataChange, onToggleRecurring, onComplete,
  onStatusChange, onPriorityChange, onTitleChange,
  initialTab, onTabChanged,
  autoCommand, onAutoCommandConsumed, pendingVoiceText, onVoiceTextConsumed,
  onClaudeResponse, voiceTextToSpeak, onVoiceTextToSpeakConsumed, onVoiceTranscript,
  onSlashCommand, onDuplicateTask,
  onCollapseTaskList, taskListCollapsed,
}: Props) {
  const [activeTab, setActiveTab] = useState<PanelTab>('notes')
  const [browserOpen, _setBrowserOpen] = useState(false)
  // Track browser-open state per task so it persists across task switches
  const browserOpenPerTaskRef = useRef<Set<number>>(new Set())
  const setBrowserOpen = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    _setBrowserOpen(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      if (next) {
        browserOpenPerTaskRef.current.add(task.id)
      } else {
        browserOpenPerTaskRef.current.delete(task.id)
      }
      return next
    })
  }, [task.id])
  const [filesSidebarOpen, setFilesSidebarOpen] = useState(false)
  const [uploads, setUploads] = useState<Upload[]>([])

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(task.title)
  const titleInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (titleInputRef.current !== document.activeElement) {
      setEditingTitle(task.title)
    }
  }, [task.id, task.title])

  const handleTitleBlur = useCallback(() => {
    const trimmed = editingTitle.trim()
    if (trimmed && trimmed !== task.title) {
      onTitleChange(task.id, trimmed)
    } else {
      setEditingTitle(task.title)
    }
  }, [editingTitle, task.id, task.title, onTitleChange])

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); titleInputRef.current?.blur() }
    if (e.key === 'Escape') { setEditingTitle(task.title); titleInputRef.current?.blur() }
  }, [task.title])

  // Track which tabs are popped out (keyed by "taskId-tab")
  const [poppedOut, setPoppedOut] = useState<Set<string>>(new Set())

  // Listen for popout window closing
  useEffect(() => {
    const unsub = window.electronAPI.onPopoutClosed(({ taskId: tid, tab }) => {
      setPoppedOut(prev => {
        const next = new Set(prev)
        next.delete(`${tid}-${tab}`)
        return next
      })
    })
    return unsub
  }, [])

  const isAssistant = task.id === ASSISTANT_TASK_ID

  // Alignment doc easter egg (assistant only)
  const [alignmentOpen, setAlignmentOpen] = useState(false)
  const [alignmentContent, setAlignmentContent] = useState('')

  const toggleAlignment = useCallback(async () => {
    if (!alignmentOpen) {
      const content = await window.electronAPI.getAlignment()
      setAlignmentContent(content)
    }
    setAlignmentOpen(prev => !prev)
  }, [alignmentOpen])

  const handlePopout = useCallback(() => {
    if (isAssistant) return // assistant can't be popped out
    const tab = browserOpen ? 'browser' : activeTab
    const key = `${task.id}-${tab}`
    setPoppedOut(prev => new Set(prev).add(key))
    window.electronAPI.popoutOpen({ taskId: task.id, tab, taskTitle: task.title })
  }, [task.id, task.title, activeTab, browserOpen, isAssistant])

  const effectiveTab = browserOpen ? 'browser' : activeTab
  const isCurrentTabPoppedOut = poppedOut.has(`${task.id}-${effectiveTab}`)

  // Remember last active tab per task so switching back restores the terminal tab
  const tabPerTaskRef = useRef<Map<number, PanelTab>>(new Map())

  const handleSetActiveTab = useCallback((tab: PanelTab) => {
    setActiveTab(tab)
    tabPerTaskRef.current.set(task.id, tab)
  }, [task.id])

  // Terminal pool — keeps terminals alive across task switches (capped to prevent memory leaks)
  const MAX_POOL_SIZE = 8
  const MAX_BROWSER_POOL_SIZE = 8 // Browser sessions are evicted independently of terminal pool
  const terminalTasksRef = useRef<Map<number, Task>>(new Map())
  const [terminalTaskIds, setTerminalTaskIds] = useState<Set<number>>(new Set())
  // Track access order for LRU eviction
  const terminalAccessOrderRef = useRef<number[]>([])

  // Browser pool — keeps browser sessions alive across task switches
  const browserTasksRef = useRef<Map<number, Task>>(new Map())
  const [browserTaskIds, setBrowserTaskIds] = useState<Set<number>>(new Set())
  // Track access order for LRU browser eviction (mirrors terminal LRU pattern)
  const browserAccessOrderRef = useRef<number[]>([])

  // Fetch uploads for current task (skip for virtual assistant task)
  const refreshUploads = useCallback(async () => {
    if (task.id < 0) { setUploads([]); return }
    const list = await window.electronAPI.getUploadsForTask(task.id)
    setUploads(list || [])
  }, [task.id])

  // Refresh uploads AND auto-open the sidebar (used when files are dropped on terminal)
  const refreshUploadsAndOpen = useCallback(async () => {
    await refreshUploads()
    setFilesSidebarOpen(true)
  }, [refreshUploads])

  useEffect(() => { refreshUploads() }, [refreshUploads])

  // Add current task to pool when first seen; evict LRU entries when pool exceeds max size
  // Also restore remembered tab for this task
  useEffect(() => {
    // Update LRU access order
    const order = terminalAccessOrderRef.current
    const idx = order.indexOf(task.id)
    if (idx >= 0) order.splice(idx, 1)
    order.push(task.id) // most recently accessed at end

    if (!terminalTasksRef.current.has(task.id)) {
      terminalTasksRef.current.set(task.id, task)

      // Evict oldest terminal entries if pool exceeds max
      while (order.length > MAX_POOL_SIZE) {
        const evictId = order.shift()!
        terminalTasksRef.current.delete(evictId)
        tabPerTaskRef.current.delete(evictId)
        // Browser sessions are NOT evicted here — they have their own pool limit
      }
      setTerminalTaskIds(new Set(terminalTasksRef.current.keys()))
    }
    // Update browser LRU access order
    const browserOrder = browserAccessOrderRef.current
    const browserIdx = browserOrder.indexOf(task.id)
    if (browserIdx >= 0) browserOrder.splice(browserIdx, 1)
    browserOrder.push(task.id)

    // Evict oldest browser entries if pool exceeds max — unconditional so eviction runs
    // even when navigating back to a task that already has a terminal session
    let browserEvicted = false
    while (browserTasksRef.current.size > MAX_BROWSER_POOL_SIZE) {
      const evictBrowserId = browserAccessOrderRef.current.shift() ??
        (browserTasksRef.current.size > 0 ? browserTasksRef.current.keys().next().value : null)
      if (evictBrowserId != null) {
        browserTasksRef.current.delete(evictBrowserId)
        browserOpenPerTaskRef.current.delete(evictBrowserId)
        window.electronAPI.destroyBrowserSession(evictBrowserId).catch(() => {})
        browserEvicted = true
      }
    }
    if (!browserTasksRef.current.has(task.id)) {
      browserTasksRef.current.set(task.id, task)
      setBrowserTaskIds(new Set(browserTasksRef.current.keys()))
    } else if (browserEvicted) {
      setBrowserTaskIds(new Set(browserTasksRef.current.keys()))
    }
    // Restore the tab the user was on for this task
    const remembered = tabPerTaskRef.current.get(task.id)
    if (remembered) {
      setActiveTab(remembered)
    }
    // Restore per-task browser panel state
    _setBrowserOpen(browserOpenPerTaskRef.current.has(task.id))
  }, [task.id])

  // Switch to requested tab (e.g. from feedback modal)
  useEffect(() => {
    if (initialTab && initialTab !== 'notes') {
      handleSetActiveTab(initialTab)
      onTabChanged?.()
    }
  }, [initialTab, task.id, handleSetActiveTab, onTabChanged])

  // Force terminal tab when autoCommand arrives
  useEffect(() => {
    if (autoCommand) {
      handleSetActiveTab('terminal')
    }
  }, [autoCommand, handleSetActiveTab])

  const handleOpenSession = useCallback(() => {
    handleSetActiveTab('terminal')
  }, [handleSetActiveTab])

  // URL that a terminal link click wants the browser to load
  const [pendingBrowserUrl, setPendingBrowserUrl] = useState<string | null>(null)
  // Claude instruction to send once browser is ready
  const [pendingBrowseInstruction, setPendingBrowseInstruction] = useState<string | null>(null)

  // Listen for RPC browser:open events
  useEffect(() => {
    const cleanup = window.electronAPI.onBrowserOpen((data: { taskId?: number; url: string }) => {
      // Only handle if no taskId specified (use active task) or taskId matches
      if (!data.taskId || data.taskId === task.id) {
        setBrowserOpen(true)
        setPendingBrowserUrl(data.url)
      }
    })
    return cleanup
  }, [task.id, setBrowserOpen])

  const handleTerminalLinkClick = useCallback((url: string) => {
    setBrowserOpen(true)
    setPendingBrowserUrl(url)
  }, [])

  // Ref to write browser thoughts into the terminal
  const browserThoughtWriterRef = useRef<((text: string) => void) | null>(null)

  const handleBrowseCommand = useCallback((instruction: string) => {
    // Open browser panel — TaskBrowser auto-starts the session on mount
    setBrowserOpen(true)
    // If instruction contains a URL, navigate directly instead of starting at Google
    const urlMatch = instruction.match(/(?:go to |open |navigate to |visit )?((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)/i)
    if (urlMatch) {
      const url = urlMatch[1].startsWith('http') ? urlMatch[1] : 'https://' + urlMatch[1]
      setPendingBrowserUrl(url)
    }
    // Queue instruction — TaskBrowser sends once webview is ready
    setPendingBrowseInstruction(instruction)
  }, [])

  // Listen for browser status — only surface start/done/error to terminal (thoughts stay in browser panel)
  useEffect(() => {
    const removeStatus = window.electronAPI.onBrowserStatus(task.id, (status) => {
      if (!status.claudeStatus || !browserThoughtWriterRef.current) return
      // Only write completion and error states to terminal
      if (!status.isClaudeActive && status.claudeStatus.startsWith('Done')) {
        browserThoughtWriterRef.current(`\x1b[32m[browse] ${status.claudeStatus}\x1b[0m\r\n`)
        browserThoughtWriterRef.current(`\x1b[90m[browse] Send another instruction or type "stop browsing" to close\x1b[0m\r\n`)
      } else if (!status.isClaudeActive && status.claudeStatus.startsWith('Error')) {
        browserThoughtWriterRef.current(`\x1b[31m[browse] ${status.claudeStatus}\x1b[0m\r\n`)
      } else if (!status.isClaudeActive && status.claudeStatus.startsWith('Stopped')) {
        browserThoughtWriterRef.current(`\x1b[33m[browse] ${status.claudeStatus}\x1b[0m\r\n`)
      }
    })
    // Thoughts stay in browser panel only — don't write to terminal
    const removeThought = window.electronAPI.onBrowserThought(task.id, () => {})
    return () => { removeStatus(); removeThought() }
  }, [task.id])

  const handleTerminalSlashCommand = useCallback((cmd: string, args: string) => {
    if (cmd === 'notes') { setBrowserOpen(false); setActiveTab('notes'); return }
    if (cmd === 'files') { setFilesSidebarOpen(prev => !prev); return }
    if (cmd === 'terminal') { setBrowserOpen(false); setActiveTab('terminal'); return }
    if (cmd === 'browser') { setBrowserOpen(prev => !prev); return }
    if (cmd === 'browse') {
      // Echo command in terminal so it doesn't vanish silently
      if (browserThoughtWriterRef.current) {
        browserThoughtWriterRef.current(`\x1b[35m[browse] ${args.trim() || 'Opening browser...'}\x1b[0m\r\n`)
      }
      if (args.trim()) {
        handleBrowseCommand(args.trim())
      } else {
        setBrowserOpen(true)
        setPendingBrowserUrl('https://www.google.com')
      }
      return
    }
    if (cmd === 'popout') { handlePopout(); return }
    onSlashCommand?.(cmd, args)
  }, [onSlashCommand, handlePopout, handleBrowseCommand])

  const tabs: { id: PanelTab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'notes',
      label: 'Notes',
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      ),
    },
    {
      id: 'terminal',
      label: 'Terminal',
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
  ]

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Tab bar — simplified for assistant (terminal-only) */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-1.5 bg-surface-0 border-b border-black/[0.06]">
        {isAssistant ? (
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-text-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            ROCA Assistant
          </span>
        ) : (
          <>
            <div role="tablist" aria-label="Task panel tabs" className="flex items-center gap-1 shrink-0">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  role="tab"
                  aria-selected={!browserOpen && activeTab === tab.id}
                  aria-controls={`tabpanel-${tab.id}`}
                  onClick={() => handleSetActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                    !browserOpen && activeTab === tab.id
                      ? 'bg-black/[0.06] text-text-1'
                      : 'text-text-3 hover:text-text-2 hover:bg-black/[0.04]'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>
            {/* Editable session title */}
            <input
              ref={titleInputRef}
              type="text"
              value={editingTitle}
              onChange={e => setEditingTitle(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              aria-label="Session title"
              className="flex-1 min-w-0 mx-2 px-2 py-1 bg-transparent text-[11px] font-medium text-text-2 truncate rounded-md border border-transparent hover:border-black/[0.06] focus:border-purple-1/30 focus:text-text-1 focus:outline-none transition-all"
              title="Click to rename session"
            />
          </>
        )}

        {isAssistant && (
          <div className="flex-1" />
        )}

        {/* Alignment doc easter egg — assistant only */}
        {isAssistant && (
          <button
            onClick={toggleAlignment}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
              alignmentOpen
                ? 'bg-black/[0.08] text-text-1'
                : 'text-text-3/40 hover:text-text-2 hover:bg-black/[0.04]'
            }`}
            title="North Stars"
            aria-label="North Stars"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          </button>
        )}

        {/* Browser toggle — globe icon */}
        {!isAssistant && (
          <button
            onClick={() => setBrowserOpen(prev => !prev)}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
              browserOpen
                ? 'bg-black/[0.08] text-text-1'
                : 'text-text-3 hover:text-text-2 hover:bg-black/[0.04]'
            }`}
            title={browserOpen ? "Close browser" : "Open browser"}
            aria-label={browserOpen ? "Close browser" : "Open browser"}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
          </button>
        )}

        {/* Collapse/expand task list */}
        {onCollapseTaskList && (
          <button
            onClick={onCollapseTaskList}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer"
            title={taskListCollapsed ? "Show task list" : "Hide task list"}
            aria-label={taskListCollapsed ? "Show task list" : "Hide task list"}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {taskListCollapsed ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              )}
            </svg>
          </button>
        )}

        {/* Duplicate / Pop-out / Files — not available for assistant */}
        {!isAssistant && (
          <>
            {onDuplicateTask && (
              <button
                onClick={() => onDuplicateTask(task.id)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer"
                title="Duplicate session"
                aria-label="Duplicate session"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            <button
              onClick={handlePopout}
              disabled={isCurrentTabPoppedOut}
              className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all ${
                isCurrentTabPoppedOut
                  ? 'opacity-40 pointer-events-none text-text-3'
                  : 'text-text-3 hover:text-text-2 hover:bg-black/[0.04] cursor-pointer'
              }`}
              title={isCurrentTabPoppedOut ? 'Already open in separate window' : 'Pop out to separate window'}
              aria-label={isCurrentTabPoppedOut ? 'Already open in separate window' : 'Pop out to separate window'}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>

            <button
              onClick={() => setFilesSidebarOpen(!filesSidebarOpen)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                filesSidebarOpen
                  ? 'bg-black/[0.08] text-text-1'
                  : 'text-text-3 hover:text-text-2 hover:bg-black/[0.04]'
              }`}
              title="Toggle files sidebar"
              aria-label="Toggle files sidebar"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
              {uploads.length > 0 && (
                <span className="bg-black/[0.1] text-text-2 px-1.5 py-0 rounded-full text-[9px] leading-[16px]">
                  {uploads.length}
                </span>
              )}
            </button>
          </>
        )}
      </div>

      {/* Tab content + optional file sidebar */}
      <div className="flex-1 overflow-hidden flex">
        {/* Tab content — terminal stays mounted (hidden) to preserve PTY session */}
        <div className="flex-1 overflow-hidden relative">
          {/* Popped-out placeholder overlay */}
          {isCurrentTabPoppedOut && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-0/95 backdrop-blur-sm">
              <div className="w-12 h-12 rounded-2xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center mb-4">
                <svg className="w-5 h-5 text-text-3/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </div>
              <p className="text-[11px] font-medium text-text-2 mb-1">Opened in separate window</p>
              <p className="text-[10px] text-text-3/50 mb-4">This tab is in its own window</p>
              <button
                onClick={() => {
                  window.electronAPI.popoutClose({ taskId: task.id, tab: effectiveTab })
                  setPoppedOut(prev => {
                    const next = new Set(prev)
                    next.delete(`${task.id}-${effectiveTab}`)
                    return next
                  })
                }}
                className="px-4 py-1.5 rounded-lg text-[10px] font-medium bg-black/[0.05] hover:bg-black/[0.08] text-text-2 transition-colors cursor-pointer"
              >
                Show here
              </button>
            </div>
          )}

          <div role="tabpanel" id="tabpanel-notes" aria-labelledby="tab-notes" aria-hidden={activeTab !== 'notes'} className={`h-full transition-opacity duration-150 ${activeTab === 'notes' ? 'opacity-100 overflow-y-auto' : 'opacity-0 overflow-hidden invisible pointer-events-none absolute inset-0'}`}>
            <TaskDetail
              task={task}
              onNotesChange={onDataChange}
              onToggleRecurring={onToggleRecurring}
              onComplete={onComplete}
              onStatusChange={onStatusChange}
              onPriorityChange={onPriorityChange}
              onTitleChange={onTitleChange}
              onOpenTerminal={handleOpenSession}
              onUploadsChanged={refreshUploads}
            />
          </div>

          {/* Terminal: use visibility:hidden (not display:none) to preserve WebGL context */}
          <div role="tabpanel" id="tabpanel-terminal" aria-labelledby="tab-terminal" aria-hidden={activeTab !== 'terminal'} className={`absolute inset-0 z-10 transition-opacity duration-150 ${activeTab === 'terminal' ? 'opacity-100 flex flex-col' : 'opacity-0 invisible pointer-events-none'}`}>
            {Array.from(terminalTaskIds).map(taskId => (
              <div key={taskId} className={`absolute inset-0 ${taskId === task.id ? 'flex flex-col' : 'invisible pointer-events-none'}`}>
                <TaskTerminal
                  task={taskId === task.id ? task : terminalTasksRef.current.get(taskId)!}
                  onNotesChange={onDataChange}
                  isActive={taskId === task.id && activeTab === 'terminal'}
                  autoCommand={taskId === task.id ? autoCommand : undefined}
                  onAutoCommandConsumed={onAutoCommandConsumed}
                  pendingVoiceText={taskId === task.id ? pendingVoiceText : undefined}
                  onVoiceTextConsumed={taskId === task.id ? onVoiceTextConsumed : undefined}
                  onClaudeResponse={taskId === task.id ? onClaudeResponse : undefined}
                  onUploadsChanged={taskId === task.id ? refreshUploadsAndOpen : undefined}
                  onSlashCommand={taskId === task.id ? handleTerminalSlashCommand : undefined}
                  onLinkClick={taskId === task.id ? handleTerminalLinkClick : undefined}
                  onRegisterWriter={taskId === task.id ? (writer: ((text: string) => void) | null) => { browserThoughtWriterRef.current = writer } : undefined}
                />
              </div>
            ))}
            {/* Alignment doc overlay — slides over terminal when open */}
            {isAssistant && alignmentOpen && (
              <div className="absolute inset-0 z-30 flex flex-col bg-surface-0 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-black/[0.06]">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-text-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                    </svg>
                    <span className="text-[11px] font-semibold text-text-1">North Stars</span>
                  </div>
                  <button
                    onClick={() => setAlignmentOpen(false)}
                    className="text-text-3 hover:text-text-1 transition-colors cursor-pointer p-1 rounded-lg hover:bg-black/[0.04]"
                    title="Close"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div
                  className="flex-1 overflow-y-auto px-5 py-4 text-[11px] text-text-2 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownStyled(alignmentContent) }}
                />
              </div>
            )}

            {/* Voice mode — bottom-right of terminal, inline with input area */}
            {onVoiceTranscript && (
              <div className="absolute bottom-3 right-3 z-20">
                <VoiceMode
                  onTranscript={onVoiceTranscript}
                  textToSpeak={voiceTextToSpeak}
                  onTextToSpeakConsumed={onVoiceTextToSpeakConsumed}
                  taskId={task.id}
                />
              </div>
            )}
          </div>


        </div>

        {/* Browser panel — always mounted, hidden when closed to preserve webview state */}
        <div className={browserOpen ? 'flex' : 'hidden'}>
          <BrowserPanel taskId={task.id} task={task} browserTaskIds={browserTaskIds} browserTasksRef={browserTasksRef} pendingUrl={pendingBrowserUrl} onPendingUrlConsumed={() => setPendingBrowserUrl(null)} pendingInstruction={pendingBrowseInstruction} onPendingInstructionConsumed={() => setPendingBrowseInstruction(null)} visible={browserOpen} />
        </div>

        {/* File sidebar */}
        {filesSidebarOpen && (
          <FileSidebar
            taskId={task.id}
            uploads={uploads}
            onUploadAdded={refreshUploads}
            onClose={() => setFilesSidebarOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
