import React, { useState, useCallback, useEffect, useRef } from 'react'
import type { Task, Upload } from '@shared/types'
import { ASSISTANT_TASK_ID } from '@shared/constants'
import { TaskDetail } from './task-detail'
import { TaskTerminal } from './task-terminal'
import { FileSidebar } from './file-sidebar'
import { useAgentRuns } from '../lib/use-agent-runs'
import { NotesPanel } from './notes/notes-panel'
import { TerminalTabStrip, type TerminalTab } from './terminal-tab-strip'
import { NewTabPopover, HostPicker } from './new-tab-popover'
import { tabPtyId } from '../lib/pty-id'

interface TabState {
  tabs: TerminalTab[]
  activeTabId: string
}

// Empty by default so a fresh task with no saved state shows the host picker
// instead of silently spawning a local Mac shell. Once the user picks a host,
// the first tab is created (see ensureTaskTabs flow + auto-open in render).
const DEFAULT_TAB_STATE: TabState = { tabs: [], activeTabId: '' }

function tabsStorageKey(taskId: number): string {
  return `roca:terminalTabs:task-${taskId}`
}
function activeTabStorageKey(taskId: number): string {
  return `roca:terminalActiveTab:task-${taskId}`
}

function loadTabState(taskId: number): TabState {
  let tabs: TerminalTab[] = []
  try {
    const saved = localStorage.getItem(tabsStorageKey(taskId))
    if (saved) {
      const parsed = JSON.parse(saved)
      if (
        Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every((t: any) => typeof t?.id === 'string' && typeof t?.label === 'string')
      ) {
        tabs = parsed
      }
    }
  } catch {}
  const savedActive = localStorage.getItem(activeTabStorageKey(taskId))
  const activeTabId = savedActive && tabs.some(t => t.id === savedActive) ? savedActive : (tabs[0]?.id ?? '')
  return { tabs, activeTabId }
}

// Ensure a task has at least one (local) terminal tab, creating one if the task
// has never had its terminal opened. Used by the voice/RPC "boot a session" path
// so it lands on a live terminal instead of the empty-state host picker. Writes
// the same localStorage keys the in-component tab state reads, then fires the
// `roca:task-tabs-changed` event a mounted RightPanel already listens for.
// Returns the pty id the task's terminal will use.
export function ensureLocalTerminalTab(taskId: number): string {
  const existing = loadTabState(taskId)
  if (existing.tabs.length > 0) {
    const active = existing.activeTabId || existing.tabs[0].id
    return `task-${taskId}${active ? `-${active}` : ''}`
  }
  const id = Date.now().toString(36)
  const newTabs: TerminalTab[] = [{ id, label: 'Tab 1' }]
  localStorage.setItem(tabsStorageKey(taskId), JSON.stringify(newTabs))
  localStorage.setItem(activeTabStorageKey(taskId), id)
  window.dispatchEvent(new CustomEvent('roca:task-tabs-changed', { detail: { taskId } }))
  return `task-${taskId}-${id}`
}

export type PanelTab = 'notes' | 'terminal'

const MIN_CONTENT_WIDTH = 300

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
  onOpenVoice?: () => void
  onSlashCommand?: (command: string, args: string) => void
  onCollapseTaskList?: () => void
  taskListCollapsed?: boolean
  // When task is the assistant, scope its terminal to a tab id (see AssistantOverlay)
  assistantTabId?: string
  // Host for the assistant's currently-rendered tab. Local/undefined = Mac;
  // 'main' / 'altura' / etc. = ssh alias spawned via mosh in pty-manager.
  // Regular-task host comes from tab.host on the per-task TerminalTab record.
  assistantHost?: string
  // Override the computed PTY id (used for mirror tabs that share the source's tmux).
  overridePtyId?: string
  // Switch the app-level selected task — used to focus a freshly ensured
  // browser companion when a link click / /browse / browser:open RPC fires
  // from a non-companion task.
  onSelectTaskId?: (taskId: number) => void
  // Open an arbitrary URL as a new dynamic tab in the top strip.
  onOpenUrlInNewTab?: (url: string) => void
}

export function RightPanel({
  task, onDataChange, onToggleRecurring, onComplete,
  onStatusChange, onPriorityChange, onTitleChange,
  initialTab, onTabChanged,
  autoCommand, onAutoCommandConsumed, onOpenVoice,
  onSlashCommand,
  onCollapseTaskList, taskListCollapsed,
  assistantTabId, assistantHost, overridePtyId,
  onSelectTaskId,
  onOpenUrlInNewTab,
}: Props) {
  const [activeTab, setActiveTab] = useState<PanelTab>('notes')
  const [filesSidebarOpen, setFilesSidebarOpen] = useState(false)
  const [uploads, setUploads] = useState<Upload[]>([])
  // Sub-agents this task's claude session spins up — shown in the files
  // sidebar. Watch the task's primary terminal (or the overridden pty for
  // assistant tabs); the virtual assistant task has no pty of its own.
  const agentRunPtyId = overridePtyId ?? (task.id >= 0 ? `task-${task.id}` : '')
  const { runs: agentRuns, getEvents: getAgentEvents } = useAgentRuns(agentRunPtyId)
  const agentRunning = agentRuns.some((r) => r.status === 'running')

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

  // Notes overlay (assistant only). The full note-taking surface — rich text,
  // multiple notebooks, week/quarter nav — lives in <NotesPanel variant="compact">,
  // which shares the same docs live with the top-level Notes tab via notesStore.
  const [notesOpen, setNotesOpen] = useState(false)
  const toggleNotes = useCallback(() => setNotesOpen(o => !o), [])

  const handlePopout = useCallback(() => {
    if (isAssistant) return // assistant can't be popped out
    const key = `${task.id}-${activeTab}`
    setPoppedOut(prev => new Set(prev).add(key))
    window.electronAPI.popoutOpen({ taskId: task.id, tab: activeTab, taskTitle: task.title })
  }, [task.id, task.title, activeTab, isAssistant])

  const isCurrentTabPoppedOut = poppedOut.has(`${task.id}-${activeTab}`)

  // Remember last active tab per task so switching back restores the terminal tab
  const tabPerTaskRef = useRef<Map<number, PanelTab>>(new Map())

  const handleSetActiveTab = useCallback((tab: PanelTab) => {
    setActiveTab(tab)
    tabPerTaskRef.current.set(task.id, tab)
  }, [task.id])

  // Per-task terminal tab state. Hydrated from localStorage on first encounter
  // with each pooled task. The assistant task is driven externally via the
  // assistantTabId prop, so we skip it here.
  const [tabsByTask, setTabsByTask] = useState<Record<number, TabState>>({})
  const ensureTaskTabs = useCallback((tid: number) => {
    setTabsByTask(prev => {
      if (prev[tid]) return prev
      return { ...prev, [tid]: loadTabState(tid) }
    })
  }, [])
  useEffect(() => {
    if (task.id !== ASSISTANT_TASK_ID) ensureTaskTabs(task.id)
  }, [task.id, ensureTaskTabs])

  const currentTabState: TabState = tabsByTask[task.id] ?? DEFAULT_TAB_STATE

  // Other parts of the app (e.g. task merge) can write directly to the same
  // localStorage keys we read from. Without this listener, the in-memory
  // `tabsByTask` would never refresh for a task we'd already loaded, so the
  // new tabs wouldn't appear until next mount.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId?: number }>).detail
      const tid = detail?.taskId
      if (typeof tid !== 'number' || tid === ASSISTANT_TASK_ID) return
      setTabsByTask(prev => ({ ...prev, [tid]: loadTabState(tid) }))
    }
    window.addEventListener('roca:task-tabs-changed', handler as EventListener)
    return () => window.removeEventListener('roca:task-tabs-changed', handler as EventListener)
  }, [])

  const addTerminalTab = useCallback((opts?: { fork?: TerminalTab['fork']; mirror?: TerminalTab['mirror']; host?: string }) => {
    const id = Date.now().toString(36)
    const tid = task.id
    setTabsByTask(prev => {
      const existing = prev[tid] ?? loadTabState(tid)
      let label: string
      if (opts?.fork) label = `⑂ ${opts.fork.sourceTitle}`
      else if (opts?.mirror) label = `↔ ${opts.mirror.sourceTitle}`
      else label = `Tab ${existing.tabs.length + 1}`
      // Mirror tabs inherit the source's host (we can't second-guess it).
      // Fork tabs run on the same host as the source — but fork is local-only
      // today (it depends on Mac-side `claude --resume` + a Mac cwd), so
      // leave it as 'local' until remote fork is wired up.
      const host = opts?.mirror ? undefined : opts?.host
      const newTabs: TerminalTab[] = [...existing.tabs, { id, label, fork: opts?.fork, mirror: opts?.mirror, host }]
      localStorage.setItem(tabsStorageKey(tid), JSON.stringify(newTabs))
      localStorage.setItem(activeTabStorageKey(tid), id)
      return { ...prev, [tid]: { tabs: newTabs, activeTabId: id } }
    })
  }, [task.id])

  const closeTerminalTab = useCallback((tabId: string) => {
    const tid = task.id
    setTabsByTask(prev => {
      const existing = prev[tid] ?? loadTabState(tid)
      if (existing.tabs.length <= 1) return prev
      const newTabs = existing.tabs.filter(t => t.id !== tabId)
      const newActive = existing.activeTabId === tabId
        ? (newTabs[newTabs.length - 1]?.id ?? '')
        : existing.activeTabId
      localStorage.setItem(tabsStorageKey(tid), JSON.stringify(newTabs))
      localStorage.setItem(activeTabStorageKey(tid), newActive)
      const ptyId = `task-${tid}${tabId ? `-${tabId}` : ''}`
      window.electronAPI.killPty(ptyId).catch(() => {})
      return { ...prev, [tid]: { tabs: newTabs, activeTabId: newActive } }
    })
  }, [task.id])

  const selectTerminalTab = useCallback((tabId: string) => {
    const tid = task.id
    setTabsByTask(prev => {
      const existing = prev[tid] ?? loadTabState(tid)
      if (existing.activeTabId === tabId) return prev
      localStorage.setItem(activeTabStorageKey(tid), tabId)
      return { ...prev, [tid]: { ...existing, activeTabId: tabId } }
    })
  }, [task.id])

  // Popover state for the tab strip "+" button. Task context offers fresh,
  // plus fork/mirror of the current task's main pty — no picker.
  //
  // First-time terminal open (no tabs yet) is driven by the centered
  // "Pick host" empty-state CTA below — deliberately NOT auto-opened. An
  // earlier auto-open effect lived here; it fought the empty-state CTA:
  // its backdrop covered the CTA (button unclickable) and it re-opened the
  // instant you dismissed it (un-closable). The CTA is the single entry
  // point now; the picker opens only on an explicit click.
  const [addOpen, setAddOpen] = useState(false)
  // The pty backing the *active* tab — every tab (incl. "Tab 1") carries a
  // base36 id, so the live pane is `task-<id>-<tabId>`, not the bare `task-<id>`.
  // Fork/Mirror "current" must act on this exact pane, or the main process finds
  // no pty record and fails with "No live session for that pane."
  const activeTabRec = currentTabState.tabs.find(t => t.id === currentTabState.activeTabId)
  const currentTabPtyId = tabPtyId(`task-${task.id}`, currentTabState.activeTabId, activeTabRec?.mirror?.ptyId)
  const handlePopoverFresh = useCallback((host?: string) => {
    addTerminalTab({ host })
    setAddOpen(false)
  }, [addTerminalTab])
  const handlePopoverForkCurrent = useCallback(async () => {
    const res = await window.electronAPI.forkSessionByPty(currentTabPtyId)
    if (!res.ok || !res.sessionId || !res.cwd) {
      throw new Error(res.error || 'Could not fork this session.')
    }
    addTerminalTab({
      fork: {
        sessionId: res.sessionId,
        cwd: res.cwd,
        sourceTaskId: task.id,
        sourceTitle: task.title,
      },
    })
    setAddOpen(false)
  }, [addTerminalTab, currentTabPtyId, task.id, task.title])
  const handlePopoverMirrorCurrent = useCallback(() => {
    addTerminalTab({
      mirror: {
        ptyId: currentTabPtyId,
        sourceTitle: task.title,
        sourceTaskId: task.id,
      },
    })
    setAddOpen(false)
  }, [addTerminalTab, currentTabPtyId, task.id, task.title])

  const renameTerminalTab = useCallback((tabId: string, newLabel: string) => {
    const tid = task.id
    setTabsByTask(prev => {
      const existing = prev[tid] ?? loadTabState(tid)
      const newTabs = existing.tabs.map(t => t.id === tabId ? { ...t, label: newLabel } : t)
      localStorage.setItem(tabsStorageKey(tid), JSON.stringify(newTabs))
      return { ...prev, [tid]: { ...existing, tabs: newTabs } }
    })
  }, [task.id])

  // Terminal pool — keeps terminals alive across task switches (capped to prevent memory leaks)
  const MAX_POOL_SIZE = 8
  const terminalTasksRef = useRef<Map<number, Task>>(new Map())
  const [terminalTaskIds, setTerminalTaskIds] = useState<Set<number>>(new Set())
  // Track access order for LRU eviction
  const terminalAccessOrderRef = useRef<number[]>([])

  // Fetch uploads for current task (skip for virtual assistant task)
  const refreshUploads = useCallback(async () => {
    if (task.id < 0) { setUploads([]); return }
    const list = await window.electronAPI.getUploadsForTask(task.id)
    setUploads(list || [])
  }, [task.id])

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
      }
      setTerminalTaskIds(new Set(terminalTasksRef.current.keys()))
    }
    // Restore the tab the user was on for this task
    const remembered = tabPerTaskRef.current.get(task.id)
    if (remembered) {
      setActiveTab(remembered)
    }
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


  // Listen for RPC browser:open events. Open the URL as a new top-level
  // dynamic tab (next to Tasks/Files/Gmail). data.taskId is ignored — the
  // browser tab is global, not per-task.
  useEffect(() => {
    const cleanup = window.electronAPI.onBrowserOpen((data: { taskId?: number; url: string }) => {
      onOpenUrlInNewTab?.(data.url)
    })
    return cleanup
  }, [onOpenUrlInNewTab])

  const handleTerminalLinkClick = useCallback((url: string) => {
    onOpenUrlInNewTab?.(url)
  }, [onOpenUrlInNewTab])

  // Ref to write browser thoughts into the terminal (legacy, no longer wired
  // since the docked side panel is gone).
  const browserThoughtWriterRef = useRef<((text: string) => void) | null>(null)

  const handleBrowseCommand = useCallback((instruction: string) => {
    // Extract a URL from the instruction; fall back to Google search for
    // anything else so /browse always lands on something useful.
    const urlMatch = instruction.match(/(?:go to |open |navigate to |visit )?((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)/i)
    let url: string
    if (urlMatch) {
      url = urlMatch[1].startsWith('http') ? urlMatch[1] : 'https://' + urlMatch[1]
    } else {
      url = `https://www.google.com/search?q=${encodeURIComponent(instruction)}`
    }
    onOpenUrlInNewTab?.(url)
  }, [onOpenUrlInNewTab])

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
    if (cmd === 'notes') { setActiveTab('notes'); return }
    if (cmd === 'files') { setFilesSidebarOpen(prev => !prev); return }
    if (cmd === 'terminal') { setActiveTab('terminal'); return }
    // /browser is deprecated — link clicks and /browse spawn a companion tab
    if (cmd === 'browse') {
      // Echo command in terminal so it doesn't vanish silently
      if (browserThoughtWriterRef.current) {
        browserThoughtWriterRef.current(`\x1b[35m[browse] ${args.trim() || 'Opening browser...'}\x1b[0m\r\n`)
      }
      if (args.trim()) {
        handleBrowseCommand(args.trim())
      } else {
        // Bare /browse — open Google in a new top-level tab
        onOpenUrlInNewTab?.('https://www.google.com')
      }
      return
    }
    if (cmd === 'popout') { handlePopout(); return }
    onSlashCommand?.(cmd, args)
  }, [onSlashCommand, handlePopout, handleBrowseCommand, onOpenUrlInNewTab])

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
            Assistant
          </span>
        ) : (
          <>
            <div role="tablist" aria-label="Task panel tabs" className="flex items-center gap-1 shrink-0">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`tabpanel-${tab.id}`}
                  onClick={() => handleSetActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                    activeTab === tab.id
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

        {/* Notes panel toggle — assistant only */}
        {isAssistant && (
          <button
            onClick={toggleNotes}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
              notesOpen
                ? 'bg-black/[0.08] text-text-1'
                : 'text-text-3/40 hover:text-text-2 hover:bg-black/[0.04]'
            }`}
            title="Notes"
            aria-label="Notes"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          </button>
        )}

        {/* Voice mode — assistant only, pops up the voice orb */}
        {isAssistant && onOpenVoice && (
          <button
            onClick={onOpenVoice}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium text-text-3/40 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer"
            title="Voice mode"
            aria-label="Voice mode"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
            </svg>
          </button>
        )}

        {/* Globe button deprecated — links and /browse now spawn a browser companion tab */}

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

        {/* Pop-out / Files — fork was here, now lives in the tab strip "+" popover */}
        {!isAssistant && (
          <>

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
              {agentRunning && (
                <span className="w-1.5 h-1.5 rounded-full bg-red-1 animate-pulse" title="Sub-agent running" />
              )}
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
        <div className="flex-1 overflow-hidden relative" style={{ minWidth: MIN_CONTENT_WIDTH }}>
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
                  window.electronAPI.popoutClose({ taskId: task.id, tab: activeTab })
                  setPoppedOut(prev => {
                    const next = new Set(prev)
                    next.delete(`${task.id}-${activeTab}`)
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
            {/* Tab strip — shown only for regular tasks (assistant's strip lives in AssistantOverlay) */}
            {!isAssistant && (
              <>
                <TerminalTabStrip
                  tabs={currentTabState.tabs}
                  activeTabId={currentTabState.activeTabId}
                  onSelect={selectTerminalTab}
                  onAdd={() => setAddOpen(true)}
                  onClose={closeTerminalTab}
                  onRename={renameTerminalTab}
                />
                <NewTabPopover
                  open={addOpen}
                  onClose={() => setAddOpen(false)}
                  onFresh={handlePopoverFresh}
                  onForkCurrent={currentTabState.tabs.length === 0 ? undefined : handlePopoverForkCurrent}
                  onMirrorCurrent={currentTabState.tabs.length === 0 ? undefined : handlePopoverMirrorCurrent}
                  currentSource={currentTabState.tabs.length === 0 ? undefined : { ptyId: currentTabPtyId, title: task.title, taskId: task.id }}
                  defaultHost={currentTabState.tabs[currentTabState.tabs.length - 1]?.host}
                  initialView={currentTabState.tabs.length === 0 ? 'pick-host' : undefined}
                />
              </>
            )}
            <div className="flex-1 relative">
              {!isAssistant && currentTabState.tabs.length === 0 && (
                // First-run: a single centered, on-palette environment-picker
                // card. Picking a host starts the session in one click — no
                // separate dropdown floating in the empty panel.
                <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
                  <div className="w-[300px] bg-surface-1 rounded-xl ring-1 ring-roca-border-1 shadow-[0_12px_32px_rgba(0,0,0,0.18)] overflow-hidden">
                    <HostPicker
                      variant="inline"
                      activeHost="local"
                      onPick={handlePopoverFresh}
                    />
                  </div>
                </div>
              )}
              {Array.from(terminalTaskIds).map(taskId => {
                const isCurrentTask = taskId === task.id
                const taskForRender = isCurrentTask ? task : terminalTasksRef.current.get(taskId)!
                const isAssistantPool = taskId === ASSISTANT_TASK_ID
                // For current task: mount all tabs (active visible). For pooled inactive
                // tasks: mount only active tab (tmux preserves others on return).
                const taskTabState = isAssistantPool
                  ? { tabs: [{ id: assistantTabId ?? '', label: 'Main', host: assistantHost }], activeTabId: assistantTabId ?? '' }
                  : (tabsByTask[taskId] ?? DEFAULT_TAB_STATE)
                const tabsToRender = isCurrentTask
                  ? taskTabState.tabs
                  : taskTabState.tabs.filter(t => t.id === taskTabState.activeTabId)

                return (
                  <div
                    key={taskId}
                    className={`absolute inset-0 ${isCurrentTask ? '' : 'invisible pointer-events-none'}`}
                  >
                    {tabsToRender.map(tab => {
                      const isVisibleTab = isCurrentTask && tab.id === taskTabState.activeTabId
                      // Only the current task's active tab receives event callbacks
                      const wired = isCurrentTask && isVisibleTab
                      // Fork tabs synthesize forked_session_id/cwd onto the task so
                      // TaskTerminal auto-launches `claude --resume <id> --fork-session`.
                      const taskForTab = tab.fork
                        ? { ...taskForRender, forked_session_id: tab.fork.sessionId, forked_source_cwd: tab.fork.cwd }
                        : taskForRender
                      return (
                        <div
                          key={tab.id || 'default'}
                          className={`absolute inset-0 flex flex-col ${isVisibleTab || !isCurrentTask ? '' : 'invisible pointer-events-none'}`}
                        >
                          <TaskTerminal
                            task={taskForTab}
                            isActive={wired && activeTab === 'terminal'}
                            autoCommand={wired ? autoCommand : undefined}
                            onAutoCommandConsumed={onAutoCommandConsumed}
                            onUploadsChanged={wired ? refreshUploads : undefined}
                            onSlashCommand={wired ? handleTerminalSlashCommand : undefined}
                            onLinkClick={wired ? handleTerminalLinkClick : undefined}
                            onRegisterWriter={wired ? (writer: ((text: string) => void) | null) => { browserThoughtWriterRef.current = writer } : undefined}
                            assistantTabId={isAssistantPool ? tab.id : tab.id}
                            overridePtyId={isAssistantPool ? overridePtyId : tab.mirror?.ptyId}
                            host={tab.host}
                          />
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
            {/* Notes overlay — slides over terminal when open. Same surface
                (and same live docs) as the top-level Notes tab. */}
            {isAssistant && notesOpen && (
              <div className="absolute inset-0 z-30 flex flex-col bg-surface-0 overflow-hidden">
                <NotesPanel variant="compact" onClose={() => setNotesOpen(false)} />
              </div>
            )}

          </div>


        </div>

        {/* Floating side-panel browser removed — browsers now live on companion tasks (see CompanionSplit). */}

        {/* File sidebar */}
        {filesSidebarOpen && (
          <FileSidebar
            taskId={task.id}
            uploads={uploads}
            onUploadAdded={refreshUploads}
            onClose={() => setFilesSidebarOpen(false)}
            agentRuns={agentRuns}
            getAgentEvents={getAgentEvents}
          />
        )}
      </div>
    </div>
  )
}
