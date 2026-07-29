import React, { useEffect, useState } from 'react'
import type { NoteMeta, NoteScope } from '../../lib/notes-store'
import { formatDate } from '../../lib/format-date'

// The Apple-Notes-style sidebar: a scope switcher (Pinned / Week / Quarter),
// a period navigator for the time-scoped views, a "New note" button, and the
// list of notes in the current scope+period. Selecting a row opens it in the
// editor to the right.
interface Props {
  scope: NoteScope
  onScope: (scope: NoteScope) => void
  periodLabel: string
  onNavPeriod: (dir: -1 | 1) => void
  onJumpNow: () => void
  notes: NoteMeta[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  compact?: boolean
}

const SCOPES: { key: NoteScope; label: string }[] = [
  { key: 'pinned', label: 'Pinned' },
  { key: 'weekly', label: 'Week' },
  { key: 'quarterly', label: 'Quarter' },
]

export function NotesList({
  scope, onScope, periodLabel, onNavPeriod, onJumpNow,
  notes, selectedId, onSelect, onCreate, onDelete, compact,
}: Props) {
  const [armedDelete, setArmedDelete] = useState<string | null>(null)

  // Disarm a pending delete on any click elsewhere. This listens on `click`,
  // not `mousedown`, on purpose: the confirming click on the X calls
  // stopPropagation, so it never reaches this listener. With `mousedown` the
  // button's own press bubbled here and disarmed the delete a beat before the
  // click could fire it — so the second click only ever re-armed, and notes
  // could never actually be deleted.
  useEffect(() => {
    if (!armedDelete) return
    const off = () => setArmedDelete(null)
    document.addEventListener('click', off)
    return () => document.removeEventListener('click', off)
  }, [armedDelete])

  const width = compact ? 'w-[150px]' : 'w-[240px]'

  return (
    <div className={`${width} shrink-0 flex flex-col min-h-0 border-r border-black/[0.06] bg-surface-1/40`}>
      {/* Scope switcher */}
      <div className={`flex items-center gap-0.5 p-0.5 m-2 rounded-lg bg-black/[0.05]`}>
        {SCOPES.map(s => (
          <button
            key={s.key}
            onClick={() => onScope(s.key)}
            className={`flex-1 px-1.5 py-1 rounded-md text-[10px] font-semibold transition-colors cursor-pointer ${
              scope === s.key ? 'bg-surface-0 text-text-1 shadow-sm' : 'text-text-3 hover:text-text-2'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Period navigator — weeks / quarters only */}
      {scope !== 'pinned' && (
        <div className="flex items-center justify-between gap-1 px-2 pb-1 text-text-3">
          <button onClick={() => onNavPeriod(-1)} title="Previous" aria-label="Previous period"
            className="p-1 rounded hover:bg-black/[0.06] hover:text-text-1 transition-colors cursor-pointer">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button onClick={onJumpNow} title="Jump to current"
            className="flex-1 text-[10px] font-semibold text-text-1 text-center cursor-pointer hover:opacity-70 transition-opacity truncate">
            {periodLabel}
          </button>
          <button onClick={() => onNavPeriod(1)} title="Next" aria-label="Next period"
            className="p-1 rounded hover:bg-black/[0.06] hover:text-text-1 transition-colors cursor-pointer">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      )}

      {/* New note */}
      <button
        onClick={onCreate}
        className="mx-2 mb-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[10px] font-semibold text-purple-1 hover:bg-purple-2/60 transition-colors cursor-pointer"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
        New note
      </button>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
        {notes.length === 0 ? (
          <p className="px-2 py-6 text-center text-[10px] text-text-3/60">No notes here yet.</p>
        ) : notes.map(n => {
          const isActive = n.id === selectedId
          return (
            <div
              key={n.id}
              onClick={() => onSelect(n.id)}
              className={`group relative px-2.5 py-2 mb-0.5 rounded-lg cursor-pointer transition-colors ${
                isActive ? 'bg-surface-0 shadow-sm' : 'hover:bg-black/[0.03]'
              }`}
            >
              <div className="flex items-center gap-1">
                {n.readOnly && (
                  <svg className="w-2.5 h-2.5 shrink-0 text-text-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                )}
                <span className="flex-1 truncate text-[11px] font-semibold text-text-1">{n.title || 'Untitled'}</span>
                {!n.readOnly && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      if (armedDelete === n.id) { onDelete(n.id); setArmedDelete(null) }
                      else setArmedDelete(n.id)
                    }}
                    title={armedDelete === n.id ? 'Click again to delete' : 'Delete note'}
                    aria-label="Delete note"
                    className={`w-4 h-4 flex items-center justify-center rounded transition-all ${
                      armedDelete === n.id
                        ? 'bg-red-1/15 text-red-1 opacity-100'
                        : 'text-text-3 opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-black/[0.10]'
                    }`}
                  >
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                {n.updatedAt && <span className="text-[9px] text-text-3 shrink-0">{formatDate(n.updatedAt)}</span>}
                <span className="text-[9px] text-text-3/70 truncate">{n.preview || 'No additional text'}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
