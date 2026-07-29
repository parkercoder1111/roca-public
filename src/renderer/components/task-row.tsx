import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Task } from '@shared/types'
import { SOURCE_COLORS, SOURCE_LABELS, SOURCE_LABELS_FULL } from '../lib/source-meta'

interface Props {
  task: Task
  isSelected: boolean
  onSelect: (id: number) => void
  onToggle: (id: number) => void
  onToggleUrgent?: (id: number) => void
  // Drag-and-drop merge: drop another task onto the middle of this row to
  // combine them. When not provided, the row is reorder-only (legacy behavior).
  onMerge?: (sourceId: number, destId: number) => void
  showDragHandle?: boolean
  compact?: boolean
  ptyStatus?: string // 'running' | 'needs_input' | undefined
  isNew?: boolean
}

// Status badge colors: intentionally raw Tailwind — these map to fixed semantic
// meanings (amber=warning, sky=waiting, emerald=ready). Short 3–4 char mono
// labels read like stock tickers at a glance.
const STATUS_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  in_progress: { bg: 'bg-blue-1/[0.12]', text: 'text-blue-1', label: 'WIP' },
  needs_input: { bg: 'bg-amber-400/[0.12]', text: 'text-amber-500', label: 'INPUT' },
  draft_ready: { bg: 'bg-emerald-400/[0.12]', text: 'text-emerald-600', label: 'DRAFT' },
  waiting: { bg: 'bg-sky-400/[0.12]', text: 'text-sky-600', label: 'WAIT' },
  blocked: { bg: 'bg-red-1/[0.12]', text: 'text-red-1', label: 'BLOCK' },
}

const PTY_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  // 'running' uses green to distinguish it visually from the blue in_progress status badge
  running: { bg: 'bg-green-1/[0.12]', text: 'text-green-1', label: '● RUN' },
  needs_input: { bg: 'bg-amber-400/[0.12]', text: 'text-amber-500', label: '? INPUT' },
}

// Celebratory colors intentionally brighter than UI palette (iOS system green/purple/cyan/yellow)
const PARTICLE_COLORS = ['#30D158', '#BF5AF2', '#64D2FF', '#FFD60A']

// Fraction of a row's height counted as the "merge zone" (centered).
// Edges remain reorder zones — those are handled by the parent status group.
const MERGE_ZONE_FRACTION = 0.5

export const TaskRow = React.memo(function TaskRow({
  task, isSelected, onSelect, onToggle, onToggleUrgent, onMerge,
  showDragHandle = true, compact = false, ptyStatus,
  isNew = false,
}: Props) {
  const [completing, setCompleting] = useState(false)
  const [showNewAnim, setShowNewAnim] = useState(isNew)
  const [particles, setParticles] = useState<{ id: number; angle: number; color: string; distance: number }[]>([])
  const particleIdRef = useRef(0)
  const particleTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const toggleTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // Trigger animation when parent signals a new task (handles post-mount isNew changes)
  useEffect(() => { if (isNew) setShowNewAnim(true) }, [isNew])

  // Clear the new-task animation class after it plays
  useEffect(() => {
    if (showNewAnim) {
      const timer = setTimeout(() => setShowNewAnim(false), 500)
      return () => clearTimeout(timer)
    }
  }, [showNewAnim])

  // Reset completing state when task status changes (e.g., after toggle completes)
  useEffect(() => { setCompleting(false) }, [task.status])

  // Clear particle + toggle timers on unmount to prevent setState on unmounted component
  useEffect(() => () => {
    if (particleTimerRef.current) clearTimeout(particleTimerRef.current)
    if (toggleTimerRef.current) clearTimeout(toggleTimerRef.current)
  }, [])

  const handleDragEnd = useCallback(() => {
    document.querySelectorAll('.sortable-chosen, .sortable-ghost, .drop-before, .drop-after, .drop-merge').forEach(
      el => el.classList.remove('sortable-chosen', 'sortable-ghost', 'drop-before', 'drop-after', 'drop-merge')
    )
    document.querySelectorAll('.folder-drop-zone.drag-over').forEach(
      el => el.classList.remove('drag-over')
    )
  }, [])

  // Spawn completion particles
  const spawnParticles = useCallback(() => {
    const newParticles = Array.from({ length: 8 }, (_, i) => ({
      id: particleIdRef.current++,
      angle: (i / 8) * 360,
      color: PARTICLE_COLORS[i % 4],
      distance: 20 + Math.random() * 15,
    }))
    setParticles(newParticles)
    if (particleTimerRef.current) clearTimeout(particleTimerRef.current)
    particleTimerRef.current = setTimeout(() => setParticles([]), 700)
  }, [])

  const needsTriage = !task.triaged_at && ['crm', 'google_tasks', 'voice_notes', 'transcript', 'meeting_notes'].includes(task.source)
  const statusBadge = needsTriage
    ? null  // Review button already signals triage; badge is redundant
    : STATUS_BADGES[task.status]
  const isDone = task.status === 'done'

  // Merge drop targeting — only active when a task drag is in flight AND the
  // pointer is within the row's central band. Otherwise we let the parent
  // status group own the event so reorder-before/after still works.
  const inMergeZone = useCallback((e: React.DragEvent) => {
    if (!onMerge) return false
    if (!e.dataTransfer.types.includes('application/roca-task')) return false
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const localY = e.clientY - rect.top
    const band = rect.height * MERGE_ZONE_FRACTION
    const start = (rect.height - band) / 2
    return localY >= start && localY <= start + band
  }, [onMerge])

  const handleRowDragOver = useCallback((e: React.DragEvent) => {
    if (!inMergeZone(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const row = e.currentTarget as HTMLElement
    row.classList.add('drop-merge')
    row.classList.remove('drop-before', 'drop-after')
  }, [inMergeZone])

  const handleRowDragLeave = useCallback((e: React.DragEvent) => {
    const row = e.currentTarget as HTMLElement
    if (!row.contains(e.relatedTarget as Node)) {
      row.classList.remove('drop-merge')
    }
  }, [])

  const handleRowDrop = useCallback((e: React.DragEvent) => {
    const row = e.currentTarget as HTMLElement
    if (!row.classList.contains('drop-merge')) return
    e.preventDefault()
    e.stopPropagation()
    row.classList.remove('drop-merge')
    const sourceId = Number(e.dataTransfer.getData('application/roca-task'))
    if (!sourceId || sourceId === task.id) return
    onMerge?.(sourceId, task.id)
  }, [onMerge, task.id])

  const handleToggle = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    if (completing) return
    setCompleting(true)
    // Spawn particles on completion (not un-completion)
    if (!isDone) {
      spawnParticles()
    }
    // Let animations play fully before toggling
    // checkbox fill: 400ms, checkmark draw: 150ms delay + 350ms, slideout: 450ms delay + 500ms
    toggleTimerRef.current = setTimeout(() => {
      onToggle(task.id)
    }, isDone ? 100 : 950)
  }, [completing, isDone, spawnParticles, onToggle, task.id])

  return (
    <div
      data-task-id={task.id}
      tabIndex={0}
      className={[
        'task-row flex items-center gap-2.5 py-2 pl-3 pr-2 rounded-md group cursor-pointer',
        isSelected ? 'active-task' : '',
        showNewAnim ? 'task-row-new' : '',
        task.priority === 'urgent' ? 'urgent-task' : '',
        needsTriage ? 'bg-amber-400/[0.04]' : '',
        completing && !isDone ? 'task-completing' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(task.id) }
      }}
      onDragOver={onMerge ? handleRowDragOver : undefined}
      onDragLeave={onMerge ? handleRowDragLeave : undefined}
      onDrop={onMerge ? handleRowDrop : undefined}
    >
      {/* Drag handle */}
      {showDragHandle && (
        <div
          aria-hidden="true"
          tabIndex={-1}
          className="drag-handle w-3 shrink-0 cursor-grab opacity-0 group-hover:opacity-40 hover:!opacity-80 transition-opacity text-text-3"
          draggable
          onDragStart={(e) => {
            e.stopPropagation()
            const row = e.currentTarget.closest('[data-task-id]') as HTMLElement
            if (row) {
              e.dataTransfer.setDragImage(row, 20, 20)
              row.classList.add('sortable-chosen')
            }
            e.dataTransfer.setData('application/roca-task', String(task.id))
            e.dataTransfer.setData('application/roca-task-folder', String(task.folder_id || ''))
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={handleDragEnd}
        >
          <svg className="w-3 h-4" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/>
            <circle cx="3" cy="6" r="1.2"/><circle cx="7" cy="6" r="1.2"/>
            <circle cx="3" cy="10" r="1.2"/><circle cx="7" cy="10" r="1.2"/>
            <circle cx="3" cy="14" r="1.2"/><circle cx="7" cy="14" r="1.2"/>
          </svg>
        </div>
      )}

      {/* Checkbox + particles — crisp 15px rounded-square (Linear-style) with a
          hairline ring that warms to oxblood on hover. */}
      <div className="relative flex-shrink-0">
        <button
          tabIndex={-1}
          onClick={handleToggle}
          aria-label={isDone ? 'Mark incomplete' : 'Mark complete'}
          className={[
            'w-[15px] h-[15px] rounded-[5px] border-[1.5px] flex-shrink-0 flex items-center justify-center cursor-pointer transition-all',
            isDone ? 'border-green-1 bg-green-1 checkbox-done' : 'border-surface-4 hover:border-purple-1',
            completing && !isDone ? 'checkbox-completing' : '',
          ].join(' ')}
        >
          {(isDone || completing) && (
            <span className={completing && !isDone ? 'checkmark-draw' : ''}>
              <svg className="w-2 h-2" style={{ color: 'var(--color-paper-cream)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/>
              </svg>
            </span>
          )}
        </button>
        {/* Completion particles */}
        {particles.map(p => (
          <span
            key={p.id}
            className="completion-particle"
            style={{
              left: '50%',
              top: '50%',
              backgroundColor: p.color,
              transform: `translate(-50%, -50%) translate(${Math.cos(p.angle * Math.PI / 180) * p.distance}px, ${Math.sin(p.angle * Math.PI / 180) * p.distance}px)`,
            }}
          />
        ))}
      </div>

      {/* Title + company — small (12px) tight body for a sleeker, denser row.
          Company/deal line uses mono so it visually separates from the title. */}
      <div className="flex-1 min-w-0">
        <span
          title={task.title}
          className={[
            'text-[12px] leading-[1.35] tracking-[-0.008em] block truncate',
            isDone ? 'text-text-3 line-through decoration-text-3/30' : 'text-text-1',
          ].join(' ')}
        >
          {task.title}
        </span>
        {task.company_name && (
          <span className="mono text-[9.5px] text-text-3/70 block truncate mt-0.5 tabular">
            {task.company_name}
            {task.deal_name && ` · ${task.deal_name}`}
          </span>
        )}
      </div>

      {/* Right side: badges + actions. All badges share a common mono treatment
          so the column reads as a tidy ticker strip. */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Priority — a quiet dot instead of a glyph/badge; urgent is already
            signalled by the left rail. Reads cleaner in the right-side strip. */}
        {task.priority === 'high' && (
          <span aria-label="High priority" title="High priority" className="w-[5px] h-[5px] rounded-full bg-red-1/70 shrink-0 mx-0.5" />
        )}

        {/* Status badge */}
        {statusBadge && (
          <span aria-label={`Status: ${statusBadge.label}`} className={`mono text-[9px] font-medium px-1.5 py-0.5 rounded-[4px] ${statusBadge.bg} ${statusBadge.text} tabular`}>
            {statusBadge.label}
          </span>
        )}

        {/* Terminal status badge */}
        {ptyStatus && PTY_BADGES[ptyStatus] && (
          <span aria-label={`Terminal status: ${PTY_BADGES[ptyStatus].label}`} className={`mono text-[9px] font-medium px-1.5 py-0.5 rounded-[4px] ${PTY_BADGES[ptyStatus].bg} ${PTY_BADGES[ptyStatus].text} tabular`}>
            {PTY_BADGES[ptyStatus].label}
          </span>
        )}

        {/* Scheduled — stopwatch glyph kept for visual density */}
        {task.scheduled_at && (
          <span className="mono text-[9px] px-1 py-0.5 rounded-[4px] bg-amber-400/10 text-amber-500" aria-label={`Scheduled: ${task.scheduled_at}`}>
            &#9201;
          </span>
        )}

        {/* Source badge — only shown when we have a non-empty abbreviation.
            Background utility for each source already matches the new palette
            via tailwind's purple-* etc. aliases pointing at the fresh tokens. */}
        {SOURCE_LABELS[task.source] && (
          <span aria-label={`Source: ${SOURCE_LABELS_FULL[task.source] || task.source}`} title={SOURCE_LABELS_FULL[task.source] || task.source} className={`mono text-[9px] font-medium px-1.5 py-0.5 rounded-[4px] ${SOURCE_COLORS[task.source] || ''} tabular`}>
            {SOURCE_LABELS[task.source]}
          </span>
        )}

        {!isDone && (
          <>
            {/* Triage review button */}
            {needsTriage && (
              <button
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); onSelect(task.id) }}
                className="mono text-[9px] font-medium px-1.5 py-0.5 rounded-[4px] bg-amber-400/10 text-amber-500 hover:bg-amber-400/20 transition-colors cursor-pointer tabular"
              >
                REVIEW
              </button>
            )}

            {/* Urgent toggle — only rendered on hover/focus; fills ink-red once active */}
            {onToggleUrgent && (
              <button
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); onToggleUrgent(task.id) }}
                className={`text-red-1 cursor-pointer transition-all p-1 rounded-md hover:bg-red-2 ${
                  task.priority === 'urgent'
                    ? 'opacity-80 hover:!opacity-100'
                    : 'opacity-0 group-hover:opacity-50 hover:!opacity-100'
                }`}
                aria-label={task.priority === 'urgent' ? 'Remove urgent priority' : 'Mark as urgent'}
                title={task.priority === 'urgent' ? 'Remove urgent' : 'Mark urgent'}
              >
                <svg className="w-3 h-3" fill={task.priority === 'urgent' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
                </svg>
              </button>
            )}

            {/* Keyboard hint — an ⏎ chip appears for the selected row so the user
                knows pressing enter focuses the task detail. Quiet, inline. */}
            {isSelected && (
              <span className="kbd opacity-60 hidden lg:inline-flex" aria-hidden="true">⏎</span>
            )}
          </>
        )}
      </div>
    </div>
  )
})
