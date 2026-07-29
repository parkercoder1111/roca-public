import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import { DEFAULT_CLOUD_HOST } from '../lib/hosts'

interface SshHost { alias: string; hostname?: string; user?: string }

export interface SessionSource {
  ptyId: string
  title: string
  taskId?: number
}

// Raw candidate returned by the main process — one per live tmux session.
// The renderer enriches it with a human label sourced from its own
// localStorage (which owns the per-tab labels).
interface MirrorCandidateRaw {
  ptyId: string
  taskId: number | null
  isAssistant: boolean
  tabSuffix: string | null
  task?: Task
}

interface MirrorCandidate extends MirrorCandidateRaw {
  label: string
  hint?: string
}

interface Props {
  open: boolean
  onClose: () => void
  // Optional host arg — when present, caller honors the picked host for the
  // fresh tab. Callers that don't care about host can ignore it.
  onFresh: (host?: string) => void
  // Fork "this session" — only rendered when currentSource is provided.
  onForkCurrent?: () => void | Promise<void>
  // Mirror "this session" — only rendered when currentSource is provided.
  onMirrorCurrent?: () => void | Promise<void>
  // Picker actions — only rendered when allowPicker is true. Fork still
  // works on task ids (only main task tabs are forkable). Mirror accepts
  // any live tab — passed as ptyId plus the rendered source title so the
  // new tab can label itself.
  onForkFromTask?: (sourceTaskId: number) => void | Promise<void>
  onMirrorFromPty?: (ptyId: string, sourceTitle: string, sourceTaskId?: number) => void | Promise<void>
  currentSource?: SessionSource | null
  // When true, "Fork from a task…" / "Mirror from a tab…" rows appear.
  allowPicker?: boolean
  // Default host shown selected when the picker opens (usually last-used
  // host for this scope). Undefined falls back to 'local'.
  defaultHost?: string
  // Initial sub-view. Defaults to the action menu; set to 'pick-host' to
  // skip the menu (used for first-time terminal open where Fork/Mirror
  // have no source to act on).
  initialView?: View
}

type View = 'menu' | 'pick-fork' | 'pick-mirror' | 'pick-host'

// Stored tab labels live in localStorage under
// `roca:terminalTabs:task-<id>` (for tasks) and `roca:terminalTabs:assistant`
// (for the assistant overlay). Each value is a JSON array of
// `{ id, label, ... }` matching `TerminalTab` from the strip.
function readStoredTabLabel(scopeKey: string, tabSuffix: string | null): string | null {
  try {
    const raw = localStorage.getItem(`roca:terminalTabs:${scopeKey}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Array<{ id: string; label: string }>
    if (!Array.isArray(parsed)) return null
    const target = parsed.find(t => (t.id || '') === (tabSuffix || ''))
    return target?.label ?? null
  } catch {
    return null
  }
}

/**
 * "+" menu for terminal tab strips. Up to five actions:
 *   - Start fresh
 *   - Fork this session       (current pty: snapshot, then diverge)
 *   - Mirror this session     (current pty: live shared view)
 *   - Fork from a task…       (pick from live tasks)
 *   - Mirror from a tab…      (pick from any live tab — task, sub-tab, assistant)
 *
 * The "this session" rows only render when `currentSource` is provided;
 * the picker rows only when `allowPicker` is true. Backdrop captures
 * outside clicks; Escape closes.
 */
export function NewTabPopover({
  open,
  onClose,
  onFresh,
  onForkCurrent,
  onMirrorCurrent,
  onForkFromTask,
  onMirrorFromPty,
  currentSource,
  allowPicker,
  defaultHost,
  initialView,
}: Props) {
  const [view, setView] = useState<View>(initialView ?? 'menu')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rawCandidates, setRawCandidates] = useState<MirrorCandidateRaw[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The "currently active" host is the tab strip's last-used choice — drives
  // the checkmark in the picker so the user can see at a glance which env is
  // active.
  const activeHost = defaultHost || 'local'

  useEffect(() => {
    if (!open) {
      setView(initialView ?? 'menu')
      setQuery('')
      setError(null)
      setBusy(false)
    }
  }, [open, initialView])

  useEffect(() => {
    // Only fetch live tabs when we're about to render the fork/mirror picker.
    if (view !== 'pick-fork' && view !== 'pick-mirror') return
    if (rawCandidates) return
    let cancelled = false
    window.electronAPI.listMirrorCandidates()
      .then(list => { if (!cancelled) setRawCandidates(list) })
      .catch(err => {
        console.error('[picker] listMirrorCandidates failed:', err)
        if (!cancelled) setError('Could not load tabs.')
      })
    return () => { cancelled = true }
  }, [view, rawCandidates])

  useEffect(() => {
    if (view !== 'menu') inputRef.current?.focus()
  }, [view])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey) }
  }, [open, onClose])

  // Hydrate the raw candidates with human labels from localStorage. For
  // sub-tabs we surface "<parent> › <tab>" so the user can tell which
  // conversation they're about to mirror.
  const candidates = useMemo<MirrorCandidate[]>(() => {
    if (!rawCandidates) return []
    return rawCandidates.map(c => {
      const parentName = c.isAssistant
        ? 'Assistant'
        : c.task?.title ?? `Task ${c.taskId}`
      if (c.tabSuffix == null) {
        return { ...c, label: parentName }
      }
      const scopeKey = c.isAssistant ? 'assistant' : `task-${c.taskId}`
      const tabLabel = readStoredTabLabel(scopeKey, c.tabSuffix) ?? 'Tab'
      return { ...c, label: tabLabel, hint: parentName }
    })
  }, [rawCandidates])

  // Fork only works on main task tabs — those are the only ones a Claude
  // session can be cloned from via `--fork-session`. Mirror works on any
  // live tab.
  const viewCandidates = useMemo<MirrorCandidate[]>(() => {
    if (view === 'pick-fork') {
      return candidates.filter(c => !c.isAssistant && c.tabSuffix == null)
    }
    return candidates
  }, [candidates, view])

  const sortedCandidates = useMemo(() => {
    return viewCandidates.slice().sort((a, b) => {
      // In-progress tasks first; then assistant rows; then task sort order.
      const aIp = !a.isAssistant && a.task?.status === 'in_progress' ? 0 : 1
      const bIp = !b.isAssistant && b.task?.status === 'in_progress' ? 0 : 1
      if (aIp !== bIp) return aIp - bIp
      if (a.isAssistant !== b.isAssistant) return a.isAssistant ? 1 : -1
      const aOrder = a.task?.sort_order ?? Number.MAX_SAFE_INTEGER
      const bOrder = b.task?.sort_order ?? Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }, [viewCandidates])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? sortedCandidates.filter(c =>
          c.label.toLowerCase().includes(q) ||
          (c.hint?.toLowerCase().includes(q) ?? false))
      : sortedCandidates
    return list.slice(0, 50)
  }, [sortedCandidates, query])

  const wrap = useCallback(async (action: () => void | Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      console.error('[popover action] failed:', err)
      setError(err instanceof Error ? err.message : 'Action failed.')
      setBusy(false)
    }
  }, [])

  if (!open) return null

  const pickLabel = view === 'pick-fork' ? 'Fork from…' : 'Mirror from…'
  const handlePick = (c: MirrorCandidate) => {
    if (view === 'pick-fork') {
      if (onForkFromTask && c.taskId != null) wrap(() => onForkFromTask(c.taskId!))
    } else if (onMirrorFromPty) {
      const fullTitle = c.hint ? `${c.hint} › ${c.label}` : c.label
      wrap(() => onMirrorFromPty(c.ptyId, fullTitle, c.taskId ?? undefined))
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden="true" />

      <div
        className="absolute z-30 top-[42px] left-2 w-[280px] bg-surface-0 rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.25)] ring-1 ring-roca-border-1 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {view === 'menu' ? (
          <div className="p-1">
            <MenuRow
              icon="plus"
              label="Start fresh"
              hint="pick host"
              onClick={() => setView('pick-host')}
            />

            {currentSource && onForkCurrent && (
              <MenuRow
                icon="fork"
                label={`Fork ${currentSource.title}`}
                hint="snapshot, then diverge"
                onClick={() => wrap(onForkCurrent)}
              />
            )}
            {currentSource && onMirrorCurrent && (
              <MenuRow
                icon="mirror"
                label={`Mirror ${currentSource.title}`}
                hint="live shared view"
                onClick={() => wrap(onMirrorCurrent)}
              />
            )}

            {allowPicker && onForkFromTask && (
              <MenuRow
                icon="fork"
                label="Fork from a task…"
                onClick={() => setView('pick-fork')}
              />
            )}
            {allowPicker && onMirrorFromPty && (
              <MenuRow
                icon="mirror"
                label="Mirror from a tab…"
                onClick={() => setView('pick-mirror')}
              />
            )}

            {error && (
              <div className="mt-1 px-3 py-2 text-[11px] text-red-1 bg-surface-2 rounded-md">
                {error}
              </div>
            )}
          </div>
        ) : view === 'pick-host' ? (
          <HostPicker
            variant="panel"
            activeHost={activeHost}
            onPick={(host) => onFresh(host)}
            onBack={() => {
              if (initialView === 'pick-host') { onClose() }
              else { setView('menu'); setError(null) }
            }}
          />
        ) : (
          <div className="flex flex-col max-h-[360px]">
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-roca-border-1">
              <button
                onClick={() => { setView('menu'); setQuery(''); setError(null) }}
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-purple-2 text-text-3 transition-colors"
                aria-label="Back"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={pickLabel}
                className="flex-1 bg-transparent outline-none text-[12px] text-text-1 placeholder:text-text-3"
              />
            </div>
            {error && (
              <div className="px-3 py-2 text-[11px] text-red-1 bg-surface-2 border-b border-roca-border-1">
                {error}
              </div>
            )}
            <div className="overflow-y-auto p-1">
              {rawCandidates === null ? (
                <div className="px-3 py-3 text-[11.5px] text-text-3 text-center">Loading…</div>
              ) : sortedCandidates.length === 0 ? (
                <div className="px-3 py-3 text-[11.5px] text-text-3 text-center leading-relaxed">
                  {view === 'pick-fork'
                    ? <>No tasks with live sessions.<br />Open a task in a terminal first, then come back.</>
                    : <>No live tabs to mirror.<br />Open a tab in a terminal first, then come back.</>}
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-3 text-[11.5px] text-text-3 text-center">No matching tabs.</div>
              ) : (
                filtered.map(c => (
                  <button
                    key={c.ptyId}
                    onClick={() => handlePick(c)}
                    disabled={busy}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] text-text-1 hover:bg-purple-2 text-left disabled:opacity-50 transition-colors"
                  >
                    <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-text-3" />
                    <span className="truncate flex-1 min-w-0">
                      {c.label}
                      {c.hint && (
                        <span className="ml-1.5 text-[10.5px] text-text-3">{c.hint}</span>
                      )}
                    </span>
                    {!c.isAssistant && c.task?.status === 'in_progress' && (
                      <span className="shrink-0 text-[10px] text-purple-1">live</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * Sectioned environment picker, modeled on Claude.ai's desktop env picker.
 * Self-contained: owns SSH-host loading + the "open ~/.ssh/config" plumbing,
 * so it drops into two places unchanged —
 *   - variant="panel"  → the "+" dropdown body (compact, with a back arrow)
 *   - variant="inline" → the centered first-run card in an empty terminal
 *
 * Three sections:
 *   - **Local**  — runs the shell on this machine.
 *   - **Cloud**  — named environments backed by a remote host (v1 ships a
 *                  single hardcoded "Default" pointing at the remote host).
 *   - **SSH**    — host aliases parsed from ~/.ssh/config, plus a row that
 *                  opens the config file so the user can add more.
 *
 * Clicking any row picks that host AND opens the tab in one shot — same
 * single-click behavior as Claude.ai (no separate Open button).
 */
export function HostPicker({
  activeHost,
  variant,
  onPick,
  onBack,
}: {
  activeHost: string
  variant: 'panel' | 'inline'
  onPick: (host: string) => void | Promise<void>
  // Panel renders a back arrow that calls this; inline omits the arrow.
  onBack?: () => void
}) {
  const [sshHosts, setSshHosts] = useState<SshHost[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lazy-load SSH aliases once. The file rarely changes mid-session, so cache
  // for the component's lifetime; openSshConfig drops the cache after an edit.
  useEffect(() => {
    if (sshHosts !== null) return
    let cancelled = false
    window.electronAPI.listSshHosts()
      .then(list => { if (!cancelled) setSshHosts(list ?? []) })
      .catch(err => {
        console.error('[picker] listSshHosts failed:', err)
        if (!cancelled) setSshHosts([])
      })
    return () => { cancelled = true }
  }, [sshHosts])

  const pick = useCallback(async (host: string) => {
    setBusy(true)
    setError(null)
    try {
      await onPick(host)
    } catch (err) {
      console.error('[picker] pick failed:', err)
      setError(err instanceof Error ? err.message : 'Could not open that host.')
      setBusy(false)
    }
  }, [onPick])

  const openSshConfig = useCallback(async () => {
    try {
      const res = await window.electronAPI.openSshConfig()
      if (!res.ok) {
        setError(res.reason === 'missing'
          ? `~/.ssh/config doesn't exist yet — create it and add a Host entry.`
          : `Couldn't open ~/.ssh/config${res.error ? `: ${res.error}` : ''}`)
        return
      }
      // After the user adds a host, drop the cache so the next render
      // re-fetches and shows the new alias.
      setSshHosts(null)
    } catch (err) {
      console.error('[picker] openSshConfig failed:', err)
      setError('Could not open SSH config file.')
    }
  }, [])

  // SSH section hides the alias we already surface as the "Default" cloud
  // env — otherwise the remote host would show twice.
  const filteredSshHosts = useMemo(
    () => (sshHosts ?? []).filter(h => h.alias !== DEFAULT_CLOUD_HOST),
    [sshHosts]
  )

  const inline = variant === 'inline'

  return (
    <div className={`flex flex-col ${inline ? '' : 'max-h-[420px]'}`}>
      {inline ? (
        <div className="px-4 pt-3.5 pb-1">
          <div className="text-[13px] font-semibold text-text-1 tracking-tight">Start a session</div>
          <div className="text-[11px] text-text-3 mt-0.5">Choose where this terminal runs.</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-roca-border-1">
          <button
            onClick={onBack}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-purple-2 text-text-3 transition-colors"
            aria-label="Back"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="flex-1 text-[12px] font-medium text-text-1">Choose environment</span>
        </div>
      )}

      <div className="overflow-y-auto p-1.5">
        <HostRow
          label="Local"
          sublabel="Mac — this machine"
          active={activeHost === 'local'}
          disabled={busy}
          onClick={() => pick('local')}
        />

        <SectionLabel>Cloud</SectionLabel>
        <HostRow
          label="Default"
          sublabel="remote host"
          active={activeHost === DEFAULT_CLOUD_HOST}
          disabled={busy}
          onClick={() => pick(DEFAULT_CLOUD_HOST)}
        />

        <SectionLabel>SSH</SectionLabel>
        {sshHosts === null ? (
          <div className="px-2.5 py-2 text-[11px] text-text-3">Loading…</div>
        ) : filteredSshHosts.length === 0 ? (
          <div className="px-2.5 py-2 text-[11px] text-text-3 leading-relaxed">
            No SSH hosts in ~/.ssh/config yet.
          </div>
        ) : (
          filteredSshHosts.map(h => (
            <HostRow
              key={h.alias}
              label={h.alias}
              sublabel={h.hostname || (h.user ? `${h.user}@…` : undefined)}
              active={activeHost === h.alias}
              disabled={busy}
              onClick={() => pick(h.alias)}
            />
          ))
        )}
        <button
          onClick={openSshConfig}
          disabled={busy}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11.5px] text-text-2 hover:bg-purple-2 text-left disabled:opacity-50 transition-colors"
        >
          <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center text-text-3">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </span>
          <span>Add SSH host…</span>
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-[11px] text-red-1 bg-surface-2 border-t border-roca-border-1">
          {error}
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-2.5 pb-1 text-[9.5px] font-semibold tracking-wider uppercase text-text-3">
      {children}
    </div>
  )
}

function HostRow({
  label, sublabel, active, disabled, onClick,
}: {
  label: string; sublabel?: string; active: boolean; disabled: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] text-left hover:bg-purple-2 disabled:opacity-50 transition-colors"
    >
      <span className="flex-1 min-w-0">
        <span className="block truncate text-text-1">{label}</span>
        {sublabel && <span className="block truncate text-[10.5px] text-text-3">{sublabel}</span>}
      </span>
      {active && (
        <svg className="w-3.5 h-3.5 text-purple-1 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  )
}

function MenuRow({ icon, label, hint, onClick }: { icon: 'plus' | 'fork' | 'mirror'; label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[12px] text-text-1 hover:bg-purple-2 text-left transition-colors"
    >
      <MenuIcon kind={icon} />
      <span className="truncate">{label}</span>
      {hint && <span className="ml-auto text-[10px] text-text-3 shrink-0">{hint}</span>}
    </button>
  )
}

function MenuIcon({ kind }: { kind: 'plus' | 'fork' | 'mirror' }) {
  if (kind === 'plus') {
    return (
      <svg className="w-3.5 h-3.5 text-text-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    )
  }
  if (kind === 'fork') {
    return (
      <svg className="w-3.5 h-3.5 text-text-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="18" r="2" strokeWidth={2} />
        <circle cx="6" cy="6" r="2" strokeWidth={2} />
        <circle cx="18" cy="6" r="2" strokeWidth={2} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 16V12M6 8v2c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V8" />
      </svg>
    )
  }
  return (
    <svg className="w-3.5 h-3.5 text-text-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
    </svg>
  )
}
