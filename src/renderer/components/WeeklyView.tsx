import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import TaskList from './TaskList'
import type { Task, Folder, Week } from '@shared/types'
import { currentIsoWeek, isoWeeksInYear } from '../lib/formatDate'

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
  ptyStatuses?: Record<string, string>
  onAssistant?: () => void
  assistantActive?: boolean
}

// Stable noop handlers for optional folder props — defined at module scope so references never change
const noopVoid = () => {}
const noopNum = (_id: number) => {}
const noopNumStr = (_id: number, _s: string) => {}
const noopNumNull = (_id: number, _fid: number | null) => {}
const noopArr = (_ids: number[]) => {}

// Source filter configs matching the Flask app
const SOURCE_FILTERS: { key: string | null; label: string; activeClass: string }[] = [
  { key: null, label: 'All', activeClass: 'bg-black/[0.06] text-text-1' },
  { key: 'clarify', label: 'Clarify', activeClass: 'bg-blue-2 text-blue-1' },
  { key: 'krisp', label: 'Krisp', activeClass: 'bg-emerald-400/10 text-emerald-400' },
  { key: 'granola', label: 'Granola', activeClass: 'bg-purple-2 text-purple-1' },
  { key: 'google_tasks', label: 'Google Tasks', activeClass: 'bg-black/[0.06] text-text-2' },
  { key: 'recurring', label: 'Recurring', activeClass: 'bg-amber-400/10 text-amber-400' },
  { key: 'manual', label: 'Manual', activeClass: 'bg-black/[0.06] text-text-2' },
]



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

export default function WeeklyView({
  week, weekData, objectives, results, folders = [], selectedTaskId,
  sourceFilter, syncing, organizing = false, folderColors = [],
  onSelectTask, onCreateTask, onToggleTask, onToggleUrgent,
  onSync, syncError, onOrganize, organizeError, onNavigateWeek, onGoToCurrentWeek,
  onSetSourceFilter, onSaveChallenges, onToggleRecurring,
  onCreateFolder, onRenameFolder, onToggleFolderCollapse,
  onDeleteFolder, onSetTaskFolder, onUpdateFolderColor, onReorderFolders, onReorderTasks,
  ptyStatuses = {},
  onAssistant, assistantActive = false,
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

  const totalOpen = objectives.length

  return (
    <div className="w-full h-full shrink-0 border-r border-black/[0.06] overflow-y-auto">
      <div className="px-6 py-6">
        {/* Week header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[15px] font-bold text-text-1 tracking-[-0.02em]">{weekDateRange(week)}</h1>
            <p className="text-[11px] text-text-3 mt-1 whitespace-nowrap" title={week}>{friendlyWeekLabel(week)}<span aria-hidden="true" className="mx-1.5 text-text-3/30">·</span><span><span aria-hidden="true">{totalOpen}</span><span className="sr-only">{totalOpen} open tasks including folders</span><span aria-hidden="true"> open</span></span><span aria-hidden="true" className="mx-1.5 text-text-3/30">·</span>{results.length} done</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Sync button */}
            <button
              onClick={onSync}
              disabled={syncing}
              aria-busy={syncing}
              className={`sync-action-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer relative min-w-[56px] disabled:cursor-not-allowed ${
                syncing ? 'action-btn-loading' : ''
              }`}
            >
              <svg className={`w-3.5 h-3.5 sync-icon transition-all duration-300 ${syncing ? 'animate-spin-smooth' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              <span className={`sync-btn-label ${syncing ? 'invisible' : ''}`}>Sync</span>
            </button>
            {syncError && <span className="text-[9px] text-red-1/70 whitespace-nowrap">{syncError}</span>}

            {/* Organize button */}
            {onOrganize && (
              <button
                onClick={onOrganize}
                disabled={organizing}
                aria-busy={organizing}
                className={`sync-action-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer relative disabled:cursor-not-allowed ${
                  organizing ? 'action-btn-loading action-btn-loading-purple' : ''
                }`}
                title="AI-powered task organization"
              >
                <svg className={`w-3.5 h-3.5 sync-icon ${organizing ? 'animate-spin-smooth' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                </svg>
                <span className={`organize-btn-label ${organizing ? 'invisible' : ''}`}>Organize</span>
              </button>
            )}
            {organizeError && <span className="text-[9px] text-red-1/70 whitespace-nowrap">{organizeError}</span>}

            {/* Week navigation */}
            <div className="flex gap-0.5 text-[10px]">
              <button
                onClick={() => onNavigateWeek(-1)}
                className="px-2 py-1.5 rounded-lg text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer"
                aria-label="Previous week"
                title="Previous week"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
              <button
                onClick={onGoToCurrentWeek}
                disabled={week === currentIsoWeek()}
                className="px-2 py-1.5 rounded-lg text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-3"
                aria-label="Go to current week"
                title="Go to current week"
              >
                Now
              </button>
              <button
                onClick={() => onNavigateWeek(1)}
                className="px-2 py-1.5 rounded-lg text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer"
                aria-label="Next week"
                title="Next week"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          </div>
        </div>

        {/* Quick add */}
        <form onSubmit={handleSubmit} className="mb-6">
          <div className="flex gap-1.5">
            {onAssistant && (
              <button
                type="button"
                onClick={onAssistant}
                className={`w-[36px] h-[36px] shrink-0 flex items-center justify-center rounded-xl transition-all cursor-pointer ${
                  assistantActive
                    ? 'bg-purple-1 text-white shadow-sm shadow-purple-1/30'
                    : 'bg-black/[0.03] border border-black/[0.06] text-text-3 hover:text-purple-1 hover:border-purple-1/30'
                }`}
                title="ROCA Assistant (⌘⇧A)"
                aria-label="ROCA Assistant (⌘⇧A)"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </button>
            )}
            <input
              type="text"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              aria-label="Add a new task"
              placeholder="Add a task..."
              className="flex-1 px-4 py-2.5 text-[12px] bg-black/[0.03] border border-black/[0.06] rounded-xl focus:outline-none text-text-1 placeholder-text-3/50 transition-all hover:border-black/[0.1] focus:border-purple-1/30"
            />
            <button
              type="submit"
              disabled={!newTitle.trim()}
              aria-label="Add task"
              className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-black/[0.03] border border-black/[0.06] text-text-3 hover:text-text-1 hover:bg-black/[0.06] disabled:opacity-30 transition-all cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
              </svg>
            </button>
          </div>
        </form>

        {/* Filters */}
        <div role="radiogroup" aria-label="Filter tasks by source" className="relative flex gap-1 mb-5 text-[10px] flex-nowrap overflow-x-auto scrollbar-hide after:pointer-events-none after:absolute after:right-0 after:top-0 after:bottom-0 after:w-6 after:bg-gradient-to-l after:from-surface-0 after:to-transparent"
          onKeyDown={(e) => {
            const keys = SOURCE_FILTERS.map(f => f.key)
            const idx = keys.indexOf(sourceFilter)
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onSetSourceFilter(keys[(idx + 1) % keys.length]) }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onSetSourceFilter(keys[(idx - 1 + keys.length) % keys.length]) }
          }}
        >
          {SOURCE_FILTERS.map(({ key, label, activeClass }) => (
            <button
              key={label}
              role="radio"
              tabIndex={sourceFilter === key ? 0 : -1}
              onClick={() => onSetSourceFilter(key)}
              aria-checked={sourceFilter === key}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                sourceFilter === key ? activeClass : 'text-text-3 hover:text-text-2 hover:bg-black/[0.03]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Task lists + folders + results */}
        <TaskList
          openTasks={objectives}
          completedTasks={results}
          folders={folders}
          selectedTaskId={selectedTaskId}
          week={week}
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
          folderColors={folderColors}
          ptyStatuses={ptyStatuses}
        />

        {/* Blockers */}
        <section className="mt-2">
          <label htmlFor="challenges-input" className="text-[9px] font-semibold text-text-3 uppercase tracking-[0.1em] mb-3 px-1 block">Challenges</label>
          <textarea
            ref={challengesRef}
            id="challenges-input"
            rows={3}
            value={challengesText}
            onChange={e => { setChallengesText(e.target.value); handleChallengesChange(e.target.value) }}
            placeholder="What's blocking progress?"
            className="w-full px-4 py-3 text-[12px] bg-black/[0.03] border border-black/[0.06] rounded-xl focus:outline-none text-text-1 placeholder-text-3/40 resize-none overflow-x-hidden overflow-y-auto max-h-[120px] transition-all hover:border-black/[0.08]"
          />
        </section>
      </div>
    </div>
  )
}
