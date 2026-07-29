import React, { useCallback, useEffect, useRef, useState } from 'react'
import { notesStore, type NoteMeta, type NoteScope } from '../../lib/notes-store'
import { currentQuarter, periodLabel, shiftPeriod } from '../../lib/notes-period'
import { currentIsoWeek } from '../../lib/format-date'
import { NotesList } from './notes-list'
import { RichTextEditor } from './rich-text-editor'

// The full notes surface: an Apple-Notes-style list sidebar + the rich-text
// editor. Rendered in two places — the top-level Notes tab (variant="full") and
// the assistant right-panel overlay (variant="compact") — both backed by the
// shared notesStore, so edits in one appear live in the other.
interface Props {
  variant?: 'full' | 'compact'
  onClose?: () => void
}

const SCOPE_KEY = 'roca:notes:scope'
const SELECTED_KEY = 'roca:notes:selectedId'

export function NotesPanel({ variant = 'full', onClose }: Props) {
  const compact = variant === 'compact'
  const [notes, setNotes] = useState<NoteMeta[]>(() => notesStore.getNotes())
  const [scope, setScopeState] = useState<NoteScope>(() => (localStorage.getItem(SCOPE_KEY) as NoteScope) || 'weekly')
  const [weekKey, setWeekKey] = useState<string>(() => currentIsoWeek())
  const [quarterKey, setQuarterKey] = useState<string>(() => currentQuarter())
  const [selectedId, setSelectedIdState] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY))
  const [loaded, setLoaded] = useState<{ id: string; md: string }>({ id: '', md: '' })
  const [titleDraft, setTitleDraft] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)
  const focusTitleNext = useRef(false)

  const setScope = useCallback((s: NoteScope) => { setScopeState(s); localStorage.setItem(SCOPE_KEY, s) }, [])
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id)
    if (id) localStorage.setItem(SELECTED_KEY, id); else localStorage.removeItem(SELECTED_KEY)
  }, [])

  // Load the note list and keep it synced with the store.
  useEffect(() => {
    notesStore.ensureNotes()
    return notesStore.subscribeNotes(() => setNotes(notesStore.getNotes()))
  }, [])

  // Flush pending saves if this surface unmounts mid-edit.
  useEffect(() => () => notesStore.flush(), [])

  const period = scope === 'pinned' ? null : scope === 'weekly' ? weekKey : quarterKey
  const visible = notesStore.notesFor(scope, period)
  // Recompute against the live `notes` snapshot so the memoless call re-runs on change.
  void notes

  // Keep a valid selection: if the current pick isn't in view, take the first.
  useEffect(() => {
    if (!visible.find(n => n.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null)
    }
  }, [scope, period, notes]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = visible.find(n => n.id === selectedId) ?? null
  const readOnly = !!selected?.readOnly

  // Sync the editable title field to the selected note.
  useEffect(() => { setTitleDraft(selected?.title ?? '') }, [selected?.id, selected?.title])

  // Load the selected note's body + subscribe for the other surface's live edits.
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    notesStore.loadBody(selected.id).then(md => { if (!cancelled) setLoaded({ id: selected.id, md }) })
    const unsub = notesStore.subscribeBody(selected.id, () => {
      const cur = notesStore.getCachedBody(selected.id)
      if (cur !== undefined) setLoaded({ id: selected.id, md: cur })
    })
    return () => { cancelled = true; unsub() }
  }, [selected?.id])

  // Focus the title of a freshly created note.
  useEffect(() => {
    if (focusTitleNext.current && selected && !selected.readOnly) {
      focusTitleNext.current = false
      requestAnimationFrame(() => { titleRef.current?.focus(); titleRef.current?.select() })
    }
  }, [selected?.id])

  const value = loaded.id === (selected?.id ?? '') ? loaded.md : (notesStore.getCachedBody(selected?.id ?? '') ?? '')

  const handleChange = useCallback((md: string) => {
    if (!selected || selected.readOnly) return
    setLoaded({ id: selected.id, md })
    notesStore.setBody(selected.id, md)
  }, [selected?.id, selected?.readOnly])

  const commitTitle = useCallback(() => {
    if (!selected || selected.readOnly) return
    const name = titleDraft.trim()
    if (name && name !== selected.title) notesStore.renameNote(selected.id, name)
    else setTitleDraft(selected.title)
  }, [selected?.id, selected?.readOnly, selected?.title, titleDraft])

  const navPeriod = (dir: -1 | 1) => {
    if (scope === 'weekly') setWeekKey(k => shiftPeriod('weekly', k, dir))
    else if (scope === 'quarterly') setQuarterKey(k => shiftPeriod('quarterly', k, dir))
  }
  const jumpNow = () => {
    if (scope === 'weekly') setWeekKey(currentIsoWeek())
    else if (scope === 'quarterly') setQuarterKey(currentQuarter())
  }

  const handleCreate = useCallback(async () => {
    const note = await notesStore.createNote(scope, period, 'New note')
    if (note) { focusTitleNext.current = true; setSelectedId(note.id) }
  }, [scope, period, setSelectedId])

  const handleDelete = useCallback((id: string) => {
    notesStore.deleteNote(id).then(() => { if (selectedId === id) setSelectedId(null) })
  }, [selectedId, setSelectedId])

  const navLabel = scope === 'pinned' ? '' : periodLabel(scope, period!)

  return (
    <div className="flex flex-1 min-h-0 bg-surface-0">
      <NotesList
        scope={scope}
        onScope={setScope}
        periodLabel={navLabel}
        onNavPeriod={navPeriod}
        onJumpNow={jumpNow}
        notes={visible}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onCreate={handleCreate}
        onDelete={handleDelete}
        compact={compact}
      />

      {/* Editor pane */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Header: title + close */}
        <div className={`flex items-center gap-2 border-b border-black/[0.06] ${compact ? 'px-3 py-2' : 'px-6 py-3'}`}>
          {selected ? (
            <input
              ref={titleRef}
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
              readOnly={readOnly}
              placeholder="Untitled"
              className={`flex-1 min-w-0 bg-transparent focus:outline-none font-semibold text-text-1 placeholder-text-3/40 ${compact ? 'text-[13px]' : 'text-[16px]'} ${readOnly ? 'cursor-default' : ''}`}
            />
          ) : <div className="flex-1" />}
          {readOnly && <span className="text-[9px] font-medium text-text-3 px-1.5 py-0.5 rounded bg-black/[0.05] shrink-0">Read-only</span>}
          {onClose && (
            <button
              onClick={() => { notesStore.flush(); onClose() }}
              aria-label="Close notes" title="Close"
              className="shrink-0 text-text-3 hover:text-text-1 transition-colors cursor-pointer p-1 rounded-lg hover:bg-black/[0.04]"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {selected ? (
          <RichTextEditor
            key={selected.id}
            value={value}
            onChange={handleChange}
            compact={compact}
            editable={!readOnly}
            placeholder={scope === 'quarterly' ? 'Set this quarter’s goals…' : scope === 'weekly' ? 'Jot this week’s notes…' : 'Start writing…'}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-3/60 text-[11px]">Select or create a note.</p>
          </div>
        )}
      </div>
    </div>
  )
}
