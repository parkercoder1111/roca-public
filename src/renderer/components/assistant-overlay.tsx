import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import { RightPanel } from './right-panel'
import { TerminalTabStrip } from './terminal-tab-strip'
import { VoicePanel } from './voice-overlay'
import { useTerminalTabs } from '../lib/use-terminal-tabs'
import { NewTabPopover } from './new-tab-popover'
import { tabPtyId } from '../lib/pty-id'

const MIN_WIDTH = 320
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 420
const STORAGE_KEY = 'roca:assistantOverlayWidth'

interface Props {
  active: boolean
  assistantTask: Task
  onOpenVoice?: () => void
  voiceMode?: boolean
  onExitVoice?: () => void
  onSlashCommand?: (command: string, args: string) => void
  // Switch the app-level selected task — needed so link clicks in the
  // assistant chat can focus the freshly-ensured browser companion.
  onSelectTaskId?: (taskId: number) => void
  // Open an arbitrary URL as a new top-level dynamic tab. Used for link
  // clicks and /browse in the assistant's own chat.
  onOpenUrlInNewTab?: (url: string) => void
}

/**
 * Global right-side assistant panel. Each tab is an independent pty session
 * (tmux-backed) so multiple Claude conversations can run in parallel.
 */
export function AssistantOverlay({
  active,
  assistantTask,
  onOpenVoice,
  voiceMode = false,
  onExitVoice,
  onSlashCommand,
  onSelectTaskId,
  onOpenUrlInNewTab,
}: Props) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    const n = saved ? Number(saved) : NaN
    return Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH ? n : DEFAULT_WIDTH
  })
  // `isResizing` exists purely to suppress the container's width transition
  // during active drag — without this, every mousemove kicks off a 200ms
  // animation and the panel chases the cursor with 100–200ms of visible lag.
  const [isResizing, setIsResizing] = useState(false)
  const resizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const pendingXRef = useRef(0)

  const handleCloseTab = useCallback((tabId: string) => {
    const ptyId = `task-assistant${tabId ? `-${tabId}` : ''}`
    window.electronAPI.killPty(ptyId).catch(() => {})
  }, [])

  const { tabs, activeTabId, setActiveTabId, addTab, closeTab, renameTab } =
    useTerminalTabs('assistant', handleCloseTab)

  // "+" opens a popover that can: start fresh, fork/mirror the currently-
  // active Assistant tab, or fork/mirror a picked task.
  const [addOpen, setAddOpen] = useState(false)

  // Source ref for the active Assistant tab — its pty id and a sensible label.
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0]
  const activePtyId = tabPtyId('task-assistant', activeTabId, activeTab?.mirror?.ptyId)
  const activeTitle = activeTab ? activeTab.label : 'Assistant'
  const currentSource = { ptyId: activePtyId, title: activeTitle }

  const handleStartFresh = useCallback((host?: string) => {
    addTab({ host })
    setAddOpen(false)
  }, [addTab])

  const handleForkCurrent = useCallback(async () => {
    const res = await window.electronAPI.forkSessionByPty(activePtyId)
    if (!res.ok || !res.sessionId || !res.cwd) {
      throw new Error(res.error || 'Could not fork this session.')
    }
    addTab({
      fork: {
        sessionId: res.sessionId,
        cwd: res.cwd,
        sourceTaskId: 0,
        sourceTitle: activeTitle,
      },
    })
    setAddOpen(false)
  }, [addTab, activePtyId, activeTitle])

  const handleMirrorCurrent = useCallback(() => {
    addTab({
      mirror: {
        ptyId: activePtyId,
        sourceTitle: activeTitle,
      },
    })
    setAddOpen(false)
  }, [addTab, activePtyId, activeTitle])

  const handleForkFromTask = useCallback(async (sourceTaskId: number) => {
    const res = await window.electronAPI.forkTaskSession(sourceTaskId)
    if (!res.ok || !res.sessionId || !res.cwd || !res.sourceTitle) {
      throw new Error(res.error || 'Could not fork that task.')
    }
    addTab({
      fork: {
        sessionId: res.sessionId,
        cwd: res.cwd,
        sourceTaskId,
        sourceTitle: res.sourceTitle,
      },
    })
    setAddOpen(false)
  }, [addTab])

  const handleMirrorFromPty = useCallback(async (
    ptyId: string,
    sourceTitle: string,
    sourceTaskId?: number,
  ) => {
    const res = await window.electronAPI.mirrorByPty(ptyId)
    if (!res.ok || !res.ptyId) {
      throw new Error(res.error || 'Could not mirror that tab.')
    }
    addTab({
      mirror: {
        ptyId: res.ptyId,
        sourceTitle,
        sourceTaskId,
      },
    })
    setAddOpen(false)
  }, [addTab])

  // Persist width only when we're not actively dragging — avoids ~60 synchronous
  // localStorage writes per second during a fast drag. The effect re-runs when
  // isResizing flips false at mouseup, capturing the final width.
  useEffect(() => {
    if (isResizing) return
    localStorage.setItem(STORAGE_KEY, String(width))
  }, [width, isResizing])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    startXRef.current = e.clientX
    startWidthRef.current = width
    setIsResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    // Coalesce mousemove ticks to one render per animation frame. Native
    // mousemove can fire faster than 60Hz; without this we render the heavy
    // RightPanel/xterm subtree multiple times per visible frame for nothing.
    const handleMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      pendingXRef.current = ev.clientX
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        if (!resizingRef.current) return
        const delta = startXRef.current - pendingXRef.current
        const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidthRef.current + delta))
        setWidth(next)
      })
    }
    const handleUp = () => {
      resizingRef.current = false
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [width])

  // Noop callbacks — ASSISTANT_TASK is virtual and has no mutable task state
  const noopNumBool = useCallback((_id: number, _val: boolean) => {}, [])
  const noopNumStr = useCallback((_id: number, _val: string) => {}, [])
  const noopNum = useCallback((_id: number) => {}, [])
  const noop = useCallback(() => {}, [])

  return (
    <div
      // relative + z-[55] keeps the assistant visible on top of the Settings
      // overlay (z-50): ⌘⇧A inside Settings should reveal the assistant, not
      // close Settings or silently toggle behind it. Stays below modal dialogs
      // (OAuth z-[60], feedback z-[100]).
      // Soft left-edge shadow (only when open) lifts the panel off the tab it
      // covers — depth instead of a flat hairline seam.
      className={`relative z-[55] shrink-0 overflow-hidden border-l border-black/[0.06] bg-surface-0 ${
        active ? 'shadow-[-10px_0_30px_-12px_rgba(0,0,0,0.18)]' : ''
      } ${
        isResizing ? '' : 'transition-[width] duration-200 ease-in-out'
      }`}
      style={{ width: active ? width : 0 }}
      aria-hidden={!active}
    >
      {/* Fixed-width inner, laid out once at the panel's full width and revealed
          by the outer's expanding clip. Pinning the width keeps the heavy
          RightPanel/xterm subtree from reflowing (and xterm from re-fitting) on
          every frame of the open — that reflow storm was the visible jank. */}
      <div
        className={`flex h-full transition-opacity duration-200 ease-in-out ${active ? 'opacity-100' : 'opacity-0'}`}
        style={{ width }}
      >
      {active && (
        // Wide invisible hit area (8px) for an easier grab, with a centered
        // 2px visual indicator that highlights on hover/drag.
        <div
          className="group relative w-[8px] shrink-0 cursor-col-resize"
          onMouseDown={handleResizeStart}
          title="Drag to resize"
        >
          <div
            className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] transition-colors ${
              isResizing
                ? 'bg-purple-1/40'
                : 'bg-transparent group-hover:bg-purple-1/30'
            }`}
          />
        </div>
      )}
      <div className="flex-1 flex flex-col overflow-hidden relative" style={{ pointerEvents: active ? 'auto' : 'none' }}>
        <TerminalTabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTabId}
          onClose={closeTab}
          onAdd={() => setAddOpen(true)}
          onRename={renameTab}
        />

        <NewTabPopover
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onFresh={handleStartFresh}
          onForkCurrent={handleForkCurrent}
          onMirrorCurrent={handleMirrorCurrent}
          onForkFromTask={handleForkFromTask}
          onMirrorFromPty={handleMirrorFromPty}
          currentSource={currentSource}
          allowPicker={true}
          defaultHost={tabs[tabs.length - 1]?.host}
        />

        <div className="flex-1 relative overflow-hidden">
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId
            // Fork tabs feed forked_session_id/cwd into the synthetic task so
            // TaskTerminal auto-launches `claude --resume <id> --fork-session`.
            // Mirror tabs override the pty id so multiple xterm views share
            // the source's tmux session.
            const taskForTab = tab.fork
              ? { ...assistantTask, forked_session_id: tab.fork.sessionId, forked_source_cwd: tab.fork.cwd }
              : assistantTask
            return (
              <div
                key={tab.id || 'default'}
                className={`absolute inset-0 flex ${isActive ? '' : 'invisible pointer-events-none'}`}
                aria-hidden={!isActive}
              >
                <RightPanel
                  task={taskForTab}
                  initialTab="terminal"
                  onDataChange={noop}
                  onToggleRecurring={noopNumBool}
                  onComplete={noopNum}
                  onStatusChange={noopNumStr}
                  onPriorityChange={noopNumStr}
                  onTitleChange={noopNumStr}
                  onOpenVoice={onOpenVoice}
                  onSlashCommand={isActive ? onSlashCommand : undefined}
                  assistantTabId={tab.id}
                  assistantHost={tab.host}
                  overridePtyId={tab.mirror?.ptyId}
                  onSelectTaskId={onSelectTaskId}
                  onOpenUrlInNewTab={onOpenUrlInNewTab}
                />
              </div>
            )
          })}
        </div>

        {/* Voice mode replaces the whole panel; back arrow returns to chat */}
        {voiceMode && (
          <div className="absolute inset-0 z-20">
            <VoicePanel active={active && voiceMode} onExit={() => onExitVoice?.()} />
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
