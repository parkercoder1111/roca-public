import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Task } from '@shared/types'
import { SOURCE_COLORS, SOURCE_LABELS, SOURCE_LABELS_FULL } from '../lib/sourceMeta'

interface Props {
  task: Task
  isSelected: boolean
  onSelect: (id: number) => void
  onToggle: (id: number) => void
  onToggleUrgent?: (id: number) => void
  showDragHandle?: boolean
  compact?: boolean
  ptyStatus?: string // 'running' | 'needs_input' | undefined
  isNew?: boolean
}

// Status badge colors: intentionally raw Tailwind — these map to fixed semantic meanings (amber=warning, sky=waiting, emerald=ready)
const STATUS_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  in_progress: { bg: 'bg-blue-1/[0.15]', text: 'text-blue-1', label: 'In Progress' },
  needs_input: { bg: 'bg-amber-400/[0.12]', text: 'text-amber-400', label: 'Needs Input' },
  draft_ready: { bg: 'bg-emerald-400/[0.12]', text: 'text-emerald-400', label: 'Draft Ready' },
  waiting: { bg: 'bg-sky-400/[0.12]', text: 'text-sky-400', label: 'Waiting' },
  blocked: { bg: 'bg-red-1/[0.12]', text: 'text-red-1', label: 'Blocked' },
}

const PTY_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  // 'running' uses green to distinguish it visually from the blue in_progress status badge
  running: { bg: 'bg-green-1/[0.12]', text: 'text-green-1', label: 'Running' },
  needs_input: { bg: 'bg-amber-400/[0.12]', text: 'text-amber-400', label: 'Needs Input' },
}

// Celebratory colors intentionally brighter than UI palette (iOS system green/purple/cyan/yellow)
const PARTICLE_COLORS = ['#30D158', '#BF5AF2', '#64D2FF', '#FFD60A']

export default React.memo(function TaskRow({
  task, isSelected, onSelect, onToggle, onToggleUrgent,
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
    document.querySelectorAll('.sortable-chosen, .sortable-ghost, .drop-before, .drop-after').forEach(
      el => el.classList.remove('sortable-chosen', 'sortable-ghost', 'drop-before', 'drop-after')
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
        'task-row flex items-center gap-3 py-2.5 px-3 rounded-xl group cursor-pointer',
        isSelected ? 'active-task' : '',
        showNewAnim ? 'task-row-new' : '',
        task.priority === 'urgent' ? 'urgent-task bg-red-2 border border-red-1/20' : '',
        needsTriage ? 'ring-1 ring-amber-400/20 bg-amber-400/[0.03]' : '',
        completing && !isDone ? 'task-completing' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(task.id) }
        else if (e.key === 'c') { e.preventDefault(); handleToggle(e) }
      }}
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

      {/* Checkbox + particles */}
      <div className="relative flex-shrink-0">
        <button
          tabIndex={-1}
          onClick={handleToggle}
          aria-label={isDone ? 'Mark incomplete' : 'Mark complete'}
          className={[
            'w-[18px] h-[18px] rounded-full border-[1.5px] flex-shrink-0 flex items-center justify-center cursor-pointer transition-all',
            isDone ? 'border-green-1 bg-green-1 checkbox-done' : 'border-black/20 hover:border-black/40',
            completing && !isDone ? 'checkbox-completing' : '',
          ].join(' ')}
        >
          {(isDone || completing) && (
            <span className={completing && !isDone ? 'checkmark-draw' : ''}>
              <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

      {/* Title + company */}
      <div className="flex-1 min-w-0">
        <span
          title={task.title}
          className={[
            'text-[12px] tracking-[-0.005em] block truncate',
            isDone ? 'text-text-3 line-through decoration-text-3/30' : 'text-text-1',
          ].join(' ')}
        >
          {task.title}
        </span>
        {task.company_name && (
          <span className="text-[10px] text-text-3/60 block truncate mt-0.5">
            {task.company_name}
            {task.deal_name && ` / ${task.deal_name}`}
          </span>
        )}
      </div>

      {/* Right side: badges + actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Priority */}
        {task.priority === 'high' && (
          <span aria-label="High priority" className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-red-2 text-red-1 uppercase tracking-wider">↑</span>
        )}

        {/* Status badge */}
        {statusBadge && (
          <span aria-label={`Status: ${statusBadge.label}`} className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md ${statusBadge.bg} ${statusBadge.text} uppercase tracking-wider`}>
            {statusBadge.label}
          </span>
        )}

        {/* Terminal status badge */}
        {ptyStatus && PTY_BADGES[ptyStatus] && (
          <span aria-label={`Terminal status: ${PTY_BADGES[ptyStatus].label}`} className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md ${PTY_BADGES[ptyStatus].bg} ${PTY_BADGES[ptyStatus].text} uppercase tracking-wider`}>
            {PTY_BADGES[ptyStatus].label}
          </span>
        )}

        {/* Scheduled */}
        {task.scheduled_at && (
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md bg-amber-400/10 text-amber-400 uppercase tracking-wider" aria-label={`Scheduled: ${task.scheduled_at}`}>
            &#9201;
          </span>
        )}

        {/* Source badge */}
        {SOURCE_LABELS[task.source] && (
          <span aria-label={`Source: ${SOURCE_LABELS_FULL[task.source] || task.source}`} title={SOURCE_LABELS_FULL[task.source] || task.source} className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md ${SOURCE_COLORS[task.source] || ''} uppercase tracking-wider`}>
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
                className="text-[9px] font-semibold px-2 py-1 rounded-md bg-amber-400/10 text-amber-400 hover:bg-amber-400/15 transition-all cursor-pointer"
              >
                Review
              </button>
            )}

            {/* Urgent toggle (visible on hover) */}
            {onToggleUrgent && (
              <button
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); onToggleUrgent(task.id) }}
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-red-1 cursor-pointer transition-all p-1 rounded-md hover:bg-red-2"
                aria-label={task.priority === 'urgent' ? 'Remove urgent priority' : 'Mark as urgent'}
                title={task.priority === 'urgent' ? 'Remove urgent' : 'Mark urgent'}
              >
                <svg className="w-3 h-3" fill={task.priority === 'urgent' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
                </svg>
              </button>
            )}

          </>
        )}
      </div>
    </div>
  )
})
