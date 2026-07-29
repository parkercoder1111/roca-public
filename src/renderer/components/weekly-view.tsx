import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { TaskList } from './task-list'
import type { Task, Folder, Week } from '@shared/types'
import { currentIsoWeek, isoWeeksInYear } from '../lib/format-date'

interface Props {
  week: string
  weekData: Week | null
  objectives: Task[]
  results: Task[]
  folders?: Folder[]
  selectedTaskId: number | null
  sourceFilter: string | null
  syncing: boolean
  organizing?: boolean
  folderColors?: string[]
  onSelectTask: (id: number) => void
  // Flow State only: select a task AND jump straight to its terminal. Drives the
  // Shift+↑/↓ "switch between active sessions" gesture.
  onNavigateToTaskTerminal?: (id: number) => void
  onCreateTask: (title: string, priority: string) => void
  onToggleTask: (id: number) => void
  onToggleUrgent?: (id: number) => void
  onSync: () => void
  syncError?: string | null
  onOrganize?: () => void
  organizeError?: string | null
  onNavigateWeek: (delta: number) => void
  onGoToCurrentWeek: () => void
  onSetSourceFilter: (source: string | null) => void
  onSaveChallenges: (text: string) => void
  onToggleRecurring: (taskId: number, isRecurring: boolean) => void
  onCreateFolder?: () => void
  onRenameFolder?: (folderId: number, name: string) => void
  onToggleFolderCollapse?: (folderId: number) => void
  onDeleteFolder?: (folderId: number) => void
  onSetTaskFolder?: (taskId: number, folderId: number | null) => void
  onUpdateFolderColor?: (folderId: number, color: string) => void
  onReorderFolders?: (folderIds: number[]) => void
  onReorderTasks?: (taskIds: number[]) => void
  onMergeTasks?: (sourceId: number, destId: number) => void
  ptyStatuses?: Record<string, string>
  onAssistant?: () => void
  assistantActive?: boolean
  assistantHasUpdates?: boolean
}

// Stable noop handlers for optional folder props — defined at module scope so references never change
const noopVoid = () => {}
const noopNum = (_id: number) => {}
const noopNumStr = (_id: number, _s: string) => {}
const noopNumNull = (_id: number, _fid: number | null) => {}
const noopArr = (_ids: number[]) => {}

// Task source options — the filter strip is gone; source now lives in a
// dropdown so the primary row can belong to Active/Stale/Old.
const SOURCE_OPTIONS: { key: string | null; label: string }[] = [
  { key: null, label: 'All sources' },
  { key: 'crm', label: 'CRM' },
  { key: 'voice_notes', label: 'Voice Notes' },
  { key: 'meeting_notes', label: 'Meeting Notes' },
  { key: 'google_tasks', label: 'Google Tasks' },
  { key: 'recurring', label: 'Recurring' },
  { key: 'manual', label: 'Manual' },
]

export type AgeFilter = 'all' | 'active' | 'stale' | 'old'

// 'active' (Flow State) hijacks the bucket key for compatibility with the saved
// localStorage value but now means "has a live PTY session" — stale/old still
// use the time-decay buckets below.
const AGE_FILTERS: { key: AgeFilter; label: string; activeClass: string }[] = [
  { key: 'all',    label: 'All',        activeClass: 'bg-surface-2 text-text-1' },
  { key: 'active', label: 'Flow State', activeClass: 'bg-emerald-400/10 text-emerald-600' },
  { key: 'stale',  label: 'Stale',      activeClass: 'bg-amber-400/10 text-amber-500' },
  { key: 'old',    label: 'Old',        activeClass: 'bg-surface-2 text-text-2' },
]

export function bucketForAge(lastActivityAt: string | undefined, now = Date.now()): AgeFilter {
  if (!lastActivityAt) return 'old'
  const diffDays = (now - new Date(lastActivityAt).getTime()) / 86400000
  if (diffDays <= 2) return 'active'
  if (diffDays <= 7) return 'stale'
  return 'old'
}



function friendlyWeekLabel(week: string): string {
  const now = currentIsoWeek()
  if (week === now) return 'This week'
  // Compute previous week — ISO years can have 52 or 53 weeks
  const m = now.match(/^(\d{4})-W(\d{2})$/)
  if (m) {
    const y = parseInt(m[1]), w = parseInt(m[2])
    const prevW = w === 1 ? isoWeeksInYear(y - 1) : w - 1
    const prevY = w === 1 ? y - 1 : y
    const prev = `${prevY}-W${String(prevW).padStart(2, '0')}`
    if (week === prev) return 'Last week'
  }
  const wm = week.match(/^(\d{4})-W(\d{2})$/)
  if (wm) return `Week ${parseInt(wm[2])}, ${wm[1]}`
  return week
}

function weekDateRange(isoWeek: string): string {
  const m = isoWeek.match(/^(\d{4})-W(\d{2})$/)
  if (!m) return ''
  const year = parseInt(m[1])
  const weekNum = parseInt(m[2])
  // Jan 4 is always in ISO week 1; find its Monday
  const jan4 = new Date(year, 0, 4)
  const dow = (jan4.getDay() + 6) % 7 // 0=Mon, 6=Sun
  const week1Mon = new Date(jan4)
  week1Mon.setDate(jan4.getDate() - dow)
  const monday = new Date(week1Mon)
  monday.setDate(week1Mon.getDate() + (weekNum - 1) * 7)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(monday)} – ${fmt(sunday)}`
}

export function WeeklyView({
  week, weekData, objectives, results, folders = [], selectedTaskId,
  sourceFilter, syncing, organizing = false, folderColors = [],
  onSelectTask, onNavigateToTaskTerminal, onCreateTask, onToggleTask, onToggleUrgent,
  onSync, syncError, onOrganize, organizeError, onNavigateWeek, onGoToCurrentWeek,
  onSetSourceFilter, onSaveChallenges, onToggleRecurring,
  onCreateFolder, onRenameFolder, onToggleFolderCollapse,
  onDeleteFolder, onSetTaskFolder, onUpdateFolderColor, onReorderFolders, onReorderTasks,
  onMergeTasks,
  ptyStatuses = {},
  onAssistant, assistantActive = false, assistantHasUpdates = false,
}: Props) {
  const [newTitle, setNewTitle] = useState('')
  const [challengesText, setChallengesText] = useState(weekData?.challenges ?? '')
  const challengesTimer = useRef<ReturnType<typeof setTimeout>>()
  const challengesRef = useRef<HTMLTextAreaElement>(null)
  // Ref to avoid stale closure in cleanup effect
  const challengesTextRef = useRef(challengesText)
  challengesTextRef.current = challengesText
  // Track which week's data has been loaded so we only sync once per week (not on every save)
  const challengesLoadedWeekRef = useRef<string | null>(null)

  // Sync challengesText from weekData when week changes or weekData first loads for a week
  useEffect(() => {
    if (weekData === null) {
      challengesLoadedWeekRef.current = null
      setChallengesText('')
    } else if (challengesLoadedWeekRef.current !== week) {
      challengesLoadedWeekRef.current = week
      setChallengesText(weekData.challenges ?? '')
    }
  }, [week, weekData])

  // Auto-grow challenges textarea up to max-height cap
  useLayoutEffect(() => {
    const el = challengesRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [challengesText])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    onCreateTask(newTitle.trim(), 'medium')
    setNewTitle('')
  }

  // Flush + cancel any pending challenges save on week change or unmount
  // Capture onSaveChallenges in the closure (not via ref) so cleanup saves to the correct (old) week
  useEffect(() => {
    const saveFn = onSaveChallenges
    return () => {
      if (challengesTimer.current) {
        clearTimeout(challengesTimer.current)
        saveFn(challengesTextRef.current)
      }
    }
  }, [week, onSaveChallenges])

  function handleChallengesChange(text: string) {
    if (challengesTimer.current) clearTimeout(challengesTimer.current)
    challengesTimer.current = setTimeout(() => { onSaveChallenges(text); challengesTimer.current = undefined }, 1000)
  }

  const [ageFilter, setAgeFilter] = useState<AgeFilter>(() => {
    const saved = localStorage.getItem('roca:ageFilter')
    return saved === 'active' || saved === 'stale' || saved === 'old' || saved === 'all' ? saved : 'all'
  })

  useEffect(() => {
    localStorage.setItem('roca:ageFilter', ageFilter)
  }, [ageFilter])

  // Flow State is the only filter that crosses week boundaries — any task with
  // a live tmux session counts, regardless of which week it was created in.
  // tmux runs out-of-process, so this signal survives ROCA restarts (unlike the
  // in-memory ptyManager which empties on launch). Poll on a 5s cadence so new
  // sessions appear without manual refresh.
  const [flowStateTasks, setFlowStateTasks] = useState<Task[]>([])
  const lastIdsKeyRef = useRef('')
  useEffect(() => {
    if (ageFilter !== 'active') return
    let cancelled = false
    const tick = async () => {
      try {
        const ids = await window.electronAPI.getLiveTaskIds()
        const key = ids.slice().sort((a, b) => a - b).join(',')
        if (cancelled || key === lastIdsKeyRef.current) return
        lastIdsKeyRef.current = key
        if (ids.length === 0) { setFlowStateTasks([]); return }
        const rows = await window.electronAPI.getTasksByIds(ids)
        if (cancelled) return
        setFlowStateTasks(rows.filter(t => !t.completed_at && t.status !== 'done'))
      } catch { /* swallow — keep last good state */ }
    }
    lastIdsKeyRef.current = ''
    tick()
    const interval = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [ageFilter])

  // Shift+↑/↓ cycles the selection through the Flow State list and jumps
  // straight to each task's terminal — the "switch between active sessions"
  // gesture. Only armed while Flow State is showing; everywhere else Shift+Arrow
  // keeps its native meaning (text selection, terminal input). Capture phase so
  // it wins over xterm, which otherwise swallows arrow keys when a terminal has
  // focus (the very case where the user wants to hop to the next session).
  useEffect(() => {
    if (ageFilter !== 'active' || !onNavigateToTaskTerminal) return
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      // Leave ROCA's own text fields alone (Shift+Arrow = select). The hidden
      // xterm helper textarea is a TEXTAREA too, but it's inside `.xterm` — that
      // one we DO steal, so navigating works while a terminal is focused.
      const el = e.target as HTMLElement | null
      if (el && !el.closest('.xterm')) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return
      }
      // Read the visible order straight from the DOM — the list is grouped by
      // status, so this is the only source that always matches what the user sees.
      const container = document.getElementById('task-lists')
      if (!container) return
      const ids = Array.from(container.querySelectorAll('[data-task-id]'))
        .map(node => Number(node.getAttribute('data-task-id')))
        .filter(n => Number.isFinite(n))
      if (ids.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const cur = ids.indexOf(selectedTaskId ?? -1)
      const next = e.key === 'ArrowDown'
        ? (cur < 0 ? 0 : Math.min(cur + 1, ids.length - 1))
        : (cur < 0 ? ids.length - 1 : Math.max(cur - 1, 0))
      const target = ids[next]
      if (target != null && target !== selectedTaskId) onNavigateToTaskTerminal(target)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [ageFilter, selectedTaskId, onNavigateToTaskTerminal])

  // Recompute once per render — the "now" stays stable within a filter pass.
  const now = Date.now()
  let filteredObjectives: Task[]
  let filteredFolders: Folder[]
  if (ageFilter === 'all') {
    filteredObjectives = objectives
    filteredFolders = folders
  } else if (ageFilter === 'active') {
    // Cross-week: strip folder_id so cross-week tasks render even when their
    // home folder isn't loaded for the current week.
    filteredObjectives = flowStateTasks.map(t => ({ ...t, folder_id: null }))
    filteredFolders = []
  } else {
    filteredObjectives = objectives.filter(t => bucketForAge(t.last_activity_at, now) === ageFilter)
    filteredFolders = folders.map(f => ({
      ...f,
      tasks: (f.tasks || []).filter(t => bucketForAge(t.last_activity_at, now) === ageFilter),
    }))
  }

  const totalOpen = filteredObjectives.length

  const isCurrentWeek = week === currentIsoWeek()

  return (
    <div className="w-full h-full shrink-0 hairline-r overflow-y-auto">
      <div className="px-7 py-6">
        {/* ══════ Editorial week header ══════
            Date range is the hero (serif italic, optical size) — it's the thing
            the user glances at first to orient themselves. Below sits a mono meta row
            that keeps counts on a rigid baseline as weeks tick over. Controls
            live on the right but read as secondary. */}
        <header className="mb-7">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="min-w-0">
              <h1 className="text-[18px] font-semibold text-text-1 tracking-[-0.02em] truncate">
                {weekDateRange(week)}
              </h1>
              <div className="mt-2 flex items-center gap-2.5 mono-caps">
                <span className="tabular">{friendlyWeekLabel(week)}</span>
                <span aria-hidden="true" className="text-text-3/40">—</span>
                <span>
                  <span className="tabular text-text-1" aria-hidden="true">{String(totalOpen).padStart(2, '0')}</span>
                  <span className="sr-only">{totalOpen} open tasks including folders</span>
                  <span aria-hidden="true" className="ml-1">open</span>
                </span>
                <span aria-hidden="true" className="text-text-3/40">·</span>
                <span>
                  <span className="tabular text-text-1">{String(results.length).padStart(2, '0')}</span>
                  <span className="ml-1">done</span>
                </span>
              </div>
            </div>

            {/* Week navigation — three tight mono chips */}
            <div className="flex items-center shrink-0 hairline rounded-lg overflow-hidden" style={{ background: 'var(--color-surface-0)' }}>
              <button
                onClick={() => onNavigateWeek(-1)}
                className="px-2.5 py-1.5 text-text-3 hover:text-text-1 hover:bg-surface-1 transition-colors cursor-pointer"
                aria-label="Previous week"
                title="Previous week"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
              <div className="w-px h-4 self-center" style={{ background: 'var(--color-hairline)' }} aria-hidden="true" />
              <button
                onClick={onGoToCurrentWeek}
                disabled={isCurrentWeek}
                className="mono text-[10px] tabular px-2.5 py-1.5 text-text-2 hover:text-text-1 hover:bg-surface-1 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                aria-label="Go to current week"
                title="Go to current week"
              >
                NOW
              </button>
              <div className="w-px h-4 self-center" style={{ background: 'var(--color-hairline)' }} aria-hidden="true" />
              <button
                onClick={() => onNavigateWeek(1)}
                className="px-2.5 py-1.5 text-text-3 hover:text-text-1 hover:bg-surface-1 transition-colors cursor-pointer"
                aria-label="Next week"
                title="Next week"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          </div>

          {/* Action row — Sync + Organize on a hairline band. Both buttons still
              own their full loading treatments (action-btn-loading) so the
              conic border spinner still tells the user something's happening. */}
          <div className="flex items-center gap-1 hairline-t pt-2.5">
            <button
              onClick={onSync}
              disabled={syncing}
              aria-busy={syncing}
              className={`sync-action-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-md mono text-[10px] tabular text-text-3 hover:text-text-1 hover:bg-surface-1 transition-all cursor-pointer relative min-w-[60px] disabled:cursor-not-allowed ${
                syncing ? 'action-btn-loading' : ''
              }`}
            >
              <svg className={`w-3 h-3 sync-icon ${syncing ? 'animate-spin-smooth' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              <span className={`sync-btn-label uppercase tracking-[0.1em] ${syncing ? 'invisible' : ''}`}>Sync</span>
            </button>
            {syncError && <span className="text-[9px] text-red-1/80 whitespace-nowrap ml-1">{syncError}</span>}

            {onOrganize && (
              <button
                onClick={onOrganize}
                disabled={organizing}
                aria-busy={organizing}
                className={`sync-action-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-md mono text-[10px] tabular text-text-3 hover:text-purple-1 hover:bg-purple-2 transition-all cursor-pointer relative disabled:cursor-not-allowed ${
                  organizing ? 'action-btn-loading action-btn-loading-purple' : ''
                }`}
                title="AI-powered task organization"
              >
                <svg className={`w-3 h-3 sync-icon ${organizing ? 'animate-spin-smooth' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                </svg>
                <span className={`organize-btn-label uppercase tracking-[0.1em] ${organizing ? 'invisible' : ''}`}>Organize</span>
              </button>
            )}
            {organizeError && <span className="text-[9px] text-red-1/80 whitespace-nowrap ml-1">{organizeError}</span>}
          </div>
        </header>

        {/* ══════ Quick-add — command-style ══════
            A single editorial "/" prefix signals this is a command field, not
            a plain input. Assistant button sits inline, enter submits, esc
            clears. Focus ring is oxblood (inherited from input:focus). */}
        <form onSubmit={handleSubmit} className="mb-5">
          <div
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl hairline transition-colors focus-within:border-purple-1/40"
            style={{ background: 'var(--color-surface-0)' }}
          >
            <span className="text-[14px] font-semibold leading-none text-text-3/55 select-none" aria-hidden="true">+</span>
            <input
              type="text"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setNewTitle('') }}
              aria-label="Add a new task"
              placeholder="capture a task, a thought, a thing to do…"
              className="flex-1 min-w-0 bg-transparent text-[12.5px] focus:outline-none text-text-1 placeholder-text-3/55 border-0"
            />
            <span className="kbd shrink-0 hidden md:inline-flex" aria-hidden="true">↵</span>
            {onAssistant && (
              <button
                type="button"
                onClick={onAssistant}
                className={`relative shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors cursor-pointer ${
                  assistantActive
                    ? ''
                    : 'text-text-3 hover:text-purple-1 hover:bg-purple-2'
                }`}
                style={assistantActive ? { background: 'var(--color-purple-1)', color: 'var(--color-paper-cream)' } : undefined}
                title="Assistant (⌘⇧A)"
                aria-label="Assistant (⌘⇧A)"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                {assistantHasUpdates && !assistantActive && (
                  <span
                    className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
                    style={{ background: 'var(--color-oxblood)', boxShadow: '0 0 0 2px var(--color-paper-cream)' }}
                  />
                )}
              </button>
            )}
            <button
              type="submit"
              disabled={!newTitle.trim()}
              aria-label="Add task"
              className="shrink-0 mono text-[10px] px-2 py-1 rounded-md text-text-3 hover:text-text-1 hover:bg-surface-2 disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors cursor-pointer"
            >
              ADD
            </button>
          </div>
        </form>

        {/* ══════ Filter row — age pills + source dropdown ══════
            Primary axis is recency (Active / Stale / Old), so those get the pill
            treatment. Source collapses into a right-aligned dropdown since
            the user rarely filters by it. */}
        <div className="flex items-center gap-2 mb-5">
          <div
            role="radiogroup"
            aria-label="Filter tasks by recency"
            className="flex gap-1 text-[10px] flex-nowrap"
            onKeyDown={(e) => {
              const keys = AGE_FILTERS.map(f => f.key)
              const idx = keys.indexOf(ageFilter)
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setAgeFilter(keys[(idx + 1) % keys.length]) }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setAgeFilter(keys[(idx - 1 + keys.length) % keys.length]) }
            }}
          >
            {AGE_FILTERS.map(({ key, label, activeClass }) => {
              const isActive = ageFilter === key
              return (
                <button
                  key={key}
                  role="radio"
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setAgeFilter(key)}
                  aria-checked={isActive}
                  title={
                    key === 'active' ? 'Tasks that have ever had a session'
                    : key === 'stale' ? 'Last touched 3–7 days ago'
                    : key === 'old' ? 'Untouched for more than 7 days'
                    : 'No recency filter'
                  }
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    isActive ? activeClass : 'text-text-3 hover:text-text-1 hover:bg-surface-1'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <div className="ml-auto relative">
            <label htmlFor="source-filter-select" className="sr-only">Task source</label>
            <select
              id="source-filter-select"
              value={sourceFilter ?? ''}
              onChange={(e) => onSetSourceFilter(e.target.value || null)}
              className="appearance-none hairline rounded-lg text-[10px] font-medium text-text-2 pl-3 pr-7 py-1.5 cursor-pointer hover:text-text-1 focus:outline-none focus:border-purple-1/40 transition-colors"
              style={{ background: 'var(--color-surface-0)' }}
              title="Filter by task source"
            >
              {SOURCE_OPTIONS.map(({ key, label }) => (
                <option key={key ?? 'all'} value={key ?? ''}>
                  {key == null ? 'Task Source: All' : `Task Source: ${label}`}
                </option>
              ))}
            </select>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-3"
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Task lists + folders + results */}
        <TaskList
          openTasks={filteredObjectives}
          completedTasks={results}
          folders={filteredFolders}
          selectedTaskId={selectedTaskId}
          week={week}
          isFlowState={ageFilter === 'active'}
          onSelectTask={onSelectTask}
          onToggleTask={onToggleTask}
          onToggleUrgent={onToggleUrgent || noopNum}
          onCreateFolder={onCreateFolder || noopVoid}
          onRenameFolder={onRenameFolder || noopNumStr}
          onToggleFolderCollapse={onToggleFolderCollapse || noopNum}
          onDeleteFolder={onDeleteFolder || noopNum}
          onSetTaskFolder={onSetTaskFolder || noopNumNull}
          onUpdateFolderColor={onUpdateFolderColor || noopNumStr}
          onReorderFolders={onReorderFolders || noopArr}
          onReorderTasks={onReorderTasks || noopArr}
          onMergeTasks={onMergeTasks}
          folderColors={folderColors}
          ptyStatuses={ptyStatuses}
        />

        {/* Challenges — editorial "what's in the way?" prompt block */}
        <section className="mt-4">
          <label htmlFor="challenges-input" className="mb-2 px-1 flex items-center gap-2">
            <span className="mono-caps">Challenges</span>
            <span className="flex-1 h-px" style={{ background: 'var(--color-hairline)' }} aria-hidden="true" />
          </label>
          <textarea
            ref={challengesRef}
            id="challenges-input"
            rows={3}
            value={challengesText}
            onChange={e => { setChallengesText(e.target.value); handleChallengesChange(e.target.value) }}
            placeholder="What's blocking progress?"
            className="w-full px-4 py-3 text-[12px] hairline rounded-xl focus:outline-none text-text-1 placeholder-text-3/50 resize-none overflow-x-hidden overflow-y-auto max-h-[120px] transition-colors"
            style={{ background: 'var(--color-surface-0)' }}
          />
        </section>
      </div>
    </div>
  )
}
