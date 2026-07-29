import React from 'react'
import { isRemoteHost } from '../lib/hosts'

// Tab forked from a snapshot of another session. Auto-launches
// `claude --resume <sessionId> --fork-session` in the source's cwd.
// After fork, the two sessions diverge — separate JSONLs, separate processes.
export interface TerminalTabFork {
  sessionId: string
  cwd: string
  sourceTaskId: number
  sourceTitle: string
}

// Tab that's a live view of another tab's PTY. Same tmux, same Claude
// process, same JSONL — just a second xterm window. Typing in either
// view flows to the same shell.
export interface TerminalTabMirror {
  ptyId: string
  sourceTitle: string
  sourceTaskId?: number
}

export interface TerminalTab {
  id: string
  label: string
  fork?: TerminalTabFork
  mirror?: TerminalTabMirror
  // Where the underlying shell runs. Undefined / 'local' = Mac; anything
  // else (e.g. 'main', 'altura') is an SSH alias the main process passes
  // to mosh. Persisted to localStorage alongside the rest of the tab.
  host?: string
}

interface Props {
  tabs: TerminalTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
  onRename?: (id: string, newLabel: string) => void
  // Optional trailing slot (e.g. star / menu buttons) shown after the + button
  trailing?: React.ReactNode
}

/**
 * Horizontal tab strip for terminal sessions. Shared by AssistantOverlay
 * (assistant sessions) and RightPanel (per-task sessions).
 *
 * Visual language: each tab is a soft pill; the active one sits on a
 * white surface with a subtle lifted shadow; inactives blend into the
 * bar background. × appears on hover (always on the active tab).
 */
export function TerminalTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onAdd,
  onRename,
  trailing,
}: Props) {
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [draftLabel, setDraftLabel] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renamingId])

  const commitRename = () => {
    if (renamingId && onRename) {
      const trimmed = draftLabel.trim()
      if (trimmed) onRename(renamingId, trimmed)
    }
    setRenamingId(null)
    setDraftLabel('')
  }

  return (
    <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 bg-surface-1/40 hairline-b overflow-x-auto no-scrollbar">
      {tabs.map(tab => {
        const isActive = tab.id === activeTabId
        const isRenaming = renamingId === tab.id
        // The × only renders with 2+ tabs (line below). When it's absent the
        // right side has no button to balance against, so the tighter pr-1
        // (meant to sit snug against the ×) leaves the label lopsided. Pad
        // symmetrically in that case so the dot + label sit centered.
        const hasCloseButton = tabs.length > 1
        const remote = isRemoteHost(tab.host)
        const hostShort = remote
          ? (tab.host?.toUpperCase().slice(0, 4) ?? 'VM')
          : null
        return (
          <div
            key={tab.id || 'default'}
            onClick={() => !isRenaming && onSelect(tab.id)}
            onDoubleClick={() => {
              if (onRename) {
                setRenamingId(tab.id)
                setDraftLabel(tab.label)
              }
            }}
            className={`group relative flex items-center gap-1.5 ${hasCloseButton ? 'pl-2.5 pr-1' : 'px-2.5'} h-[28px] rounded-lg text-[11.5px] font-medium cursor-pointer select-none shrink-0 transition-all duration-200 ${
              isActive
                ? 'bg-surface-0 text-text-1 shadow-[0_1px_3px_rgba(0,0,0,0.07)] ring-1 ring-[color:var(--color-hairline)]'
                : 'text-text-3 hover:text-text-2 hover:bg-surface-1'
            }`}
            title={onRename
              ? `${tab.label}${remote ? ` (on ${tab.host})` : ''} — double-click to rename`
              : `${tab.label}${remote ? ` (on ${tab.host})` : ''}`}
          >
            {/* Active accent — a small oxblood dot, like a live indicator. */}
            {!isRenaming && !hostShort && (
              <span
                className={`shrink-0 rounded-full transition-all duration-200 ${
                  isActive ? 'w-1.5 h-1.5 bg-purple-1' : 'w-1 h-1 bg-text-3/40 group-hover:bg-text-3'
                }`}
                aria-hidden="true"
              />
            )}
            {hostShort && !isRenaming && (
              <span
                className="shrink-0 px-1 py-px rounded text-[8.5px] font-semibold tracking-wider bg-purple-2 text-purple-1"
                aria-label={`Runs on ${tab.host}`}
              >
                {hostShort}
              </span>
            )}
            {isRenaming ? (
              <input
                ref={inputRef}
                value={draftLabel}
                onChange={e => setDraftLabel(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') { setRenamingId(null); setDraftLabel('') }
                }}
                onClick={e => e.stopPropagation()}
                className="bg-transparent outline-none text-[11.5px] font-medium text-text-1 w-[90px] tracking-tight"
              />
            ) : (
              <span className="truncate max-w-[140px] tracking-tight">{tab.label}</span>
            )}
            {hasCloseButton && !isRenaming && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
                aria-label={`Close ${tab.label}`}
                className={`shrink-0 w-4 h-4 flex items-center justify-center rounded-md text-text-3 hover:text-red-1 hover:bg-red-1/10 transition-all ${
                  isActive ? 'opacity-50 hover:opacity-100' : 'opacity-0 group-hover:opacity-50 hover:!opacity-100'
                }`}
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )
      })}
      <button
        onClick={onAdd}
        aria-label="New tab"
        title="New tab"
        className="shrink-0 ml-0.5 w-[28px] h-[28px] flex items-center justify-center rounded-lg text-text-3 hover:text-purple-1 hover:bg-surface-1 transition-all cursor-pointer"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
      {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
    </div>
  )
}
