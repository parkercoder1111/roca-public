import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Task } from '@shared/types'
import { STATUS_LABELS, PRIORITY_CYCLE } from '@shared/constants'
import { renderMarkdownStyled } from '../lib/renderMarkdown'
import { uploadFiles } from '../uploadFiles'
import { SOURCE_COLORS, SOURCE_LABELS_FULL as SOURCE_LABELS } from '../lib/sourceMeta'

const PILL = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium'
const BTN = 'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-medium transition-all cursor-pointer'

interface Props {
  task: Task
  onNotesChange: () => void
  onToggleRecurring: (taskId: number, isRecurring: boolean) => void
  onComplete: (taskId: number) => void | Promise<void>
  onStatusChange: (taskId: number, status: string) => void
  onPriorityChange: (taskId: number, priority: string) => void
  onTitleChange: (taskId: number, title: string) => void
  onOpenTerminal?: () => void
  onUploadsChanged?: () => void
}

export default function TaskDetail({
  task, onNotesChange, onToggleRecurring, onComplete,
  onStatusChange, onPriorityChange, onTitleChange, onOpenTerminal, onUploadsChanged,
}: Props) {
  const [notes, setNotes] = useState(task.notes || '')
  const [editingTitle, setEditingTitle] = useState(task.title)
  const [notesSaved, setNotesSaved] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const [showLinkPopover, setShowLinkPopover] = useState(false)
  const [linkText, setLinkText] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [showSchedulePopover, setShowSchedulePopover] = useState(false)
  const [scheduleInput, setScheduleInput] = useState(task.scheduled_at?.slice(0, 16) || '')
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const notesTimer = useRef<NodeJS.Timeout>()
  const notesSavedTimer = useRef<NodeJS.Timeout>()
  const pendingNotesRef = useRef('')
  const completeTimerRef = useRef<NodeJS.Timeout>()
  const linkSelectionRef = useRef<{ start: number; end: number } | null>(null)
  const dragCounter = useRef(0)
  const uploadStatusTimer = useRef<ReturnType<typeof setTimeout>>()
  const notesDropZoneRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const schedulePopoverRef = useRef<HTMLDivElement>(null)
  const scheduleInputRef = useRef<HTMLInputElement>(null)
  const linkPopoverRef = useRef<HTMLDivElement>(null)

  // Clear notes timer on unmount to prevent stale writes
  useEffect(() => () => { if (notesTimer.current) clearTimeout(notesTimer.current) }, [])
  // Clear notesSaved timer on unmount to prevent setState on unmounted component
  useEffect(() => () => { if (notesSavedTimer.current) clearTimeout(notesSavedTimer.current) }, [])
  // Clear upload status timer on unmount to prevent setState on unmounted component
  useEffect(() => () => { if (uploadStatusTimer.current) clearTimeout(uploadStatusTimer.current) }, [])

  // Clear complete timer on task switch and unmount to prevent stale callback firing
  useEffect(() => () => { if (completeTimerRef.current) clearTimeout(completeTimerRef.current) }, [task.id])

  // Flush pending notes before task switches — prevents silent data loss on fast navigation
  useEffect(() => () => {
    if (notesTimer.current && pendingNotesRef.current) {
      clearTimeout(notesTimer.current)
      notesTimer.current = undefined
      window.electronAPI.updateNotes(task.id, pendingNotesRef.current).catch(() => {})
      pendingNotesRef.current = ''
    }
  }, [task.id])

  // Reset preview mode only on task switch, not on background syncs
  useEffect(() => { setPreviewMode(false) }, [task.id])

  // Sync editingTitle when the task title is updated externally (e.g. background sync)
  // Guard: don't clobber an in-progress edit (user has the input focused)
  useEffect(() => {
    if (titleRef.current !== document.activeElement) {
      setEditingTitle(task.title)
    }
  }, [task.id, task.title])

  // Focus schedule input when popover opens
  useEffect(() => { if (showSchedulePopover) scheduleInputRef.current?.focus() }, [showSchedulePopover])

  // Click-outside + Escape to close schedule popover
  useEffect(() => {
    if (!showSchedulePopover) return
    function handleMouseDown(e: MouseEvent) {
      if (schedulePopoverRef.current && !schedulePopoverRef.current.contains(e.target as Node)) {
        setShowSchedulePopover(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowSchedulePopover(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showSchedulePopover])

  // Click-outside + Escape + resize to close link popover
  useEffect(() => {
    if (!showLinkPopover) return
    function handleMouseDown(e: MouseEvent) {
      if (linkPopoverRef.current && !linkPopoverRef.current.contains(e.target as Node)) {
        setShowLinkPopover(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setShowLinkPopover(false); linkSelectionRef.current = null }
    }
    function handleResize() { setShowLinkPopover(false) }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [showLinkPopover])

  // Reset scroll + close popovers only when the task itself changes (not on background sync)
  useEffect(() => {
    setShowSchedulePopover(false)
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
  }, [task.id])

  // Sync fields when task changes or background sync updates them — never resets scroll
  // Guard in-flight edits: don't reset notes if user is mid-type (pendingNotesRef set),
  // and don't reset title if the title input is focused.
  useEffect(() => {
    if (!pendingNotesRef.current) setNotes(task.notes || '')
    if (document.activeElement !== titleRef.current) setEditingTitle(task.title)
    if (!showSchedulePopover) setScheduleInput(task.scheduled_at?.slice(0, 16) || '')
  }, [task.id, task.notes, task.title, task.scheduled_at, showSchedulePopover])

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = ta.scrollHeight + 'px'
    }
  }, [notes, previewMode])

  const saveNotes = useCallback((text: string) => {
    pendingNotesRef.current = text
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(async () => {
      await window.electronAPI.updateNotes(task.id, text)
      pendingNotesRef.current = ''
      setNotesSaved(true)
      onNotesChange()
      notesSavedTimer.current = setTimeout(() => setNotesSaved(false), 1500)
    }, 1000)
  }, [task.id, onNotesChange])

  function handleNotesChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setNotes(v)
    saveNotes(v)
    // Auto-grow
    e.target.style.height = 'auto'
    e.target.style.height = e.target.scrollHeight + 'px'
  }

  function notesFmt(type: 'bold' | 'italic' | 'list') {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = ta.value.substring(start, end)
    let replacement: string
    if (type === 'bold') replacement = selected ? `**${selected}**` : '**bold text**'
    else if (type === 'italic') replacement = selected ? `*${selected}*` : '*italic text*'
    else replacement = (selected ? selected.split('\n') : ['']).map(l => `- ${l}`).join('\n')

    const newVal = ta.value.substring(0, start) + replacement + ta.value.substring(end)
    setNotes(newVal)
    saveNotes(newVal)
    // Set cursor position after React re-renders
    requestAnimationFrame(() => {
      if (!textareaRef.current) return
      const cursorPos = type === 'bold' ? start + replacement.length - 2
        : type === 'italic' ? start + replacement.length - 1
        : start + replacement.length
      const pos = selected ? start + replacement.length : cursorPos
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = pos
    })
  }

  function openLinkPopover() {
    if (!toolbarRef.current) { setShowLinkPopover(false); return }
    const ta = textareaRef.current
    if (!ta) return
    setShowSchedulePopover(false)
    linkSelectionRef.current = { start: ta.selectionStart, end: ta.selectionEnd }
    const selected = ta.value.substring(ta.selectionStart, ta.selectionEnd)
    setLinkText(selected || '')
    setLinkUrl('')
    setShowLinkPopover(true)
  }

  function insertLink() {
    const text = linkText.trim() || 'link'
    const url = linkUrl.trim()
    if (!url) return
    const md = `[${text}](${url})`
    const ta = textareaRef.current
    const { start, end } = linkSelectionRef.current || {
      start: ta?.selectionStart || 0,
      end: ta?.selectionEnd || 0,
    }
    const newVal = (notes.substring(0, start) + md + notes.substring(end))
    setNotes(newVal)
    saveNotes(newVal)
    setShowLinkPopover(false)
    linkSelectionRef.current = null
    ta?.focus()
  }

  function notesKeyHandler(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.metaKey && e.key === 'b') { e.preventDefault(); notesFmt('bold') }
    if (e.metaKey && e.key === 'i') { e.preventDefault(); notesFmt('italic') }
    if (e.metaKey && e.key === 'k') { e.preventDefault(); openLinkPopover() }
  }

  // ── Schedule task ──
  async function saveSchedule() {
    const val = scheduleInput.trim() || null
    await window.electronAPI.scheduleTask(task.id, val)
    setShowSchedulePopover(false)
    onNotesChange() // trigger data refresh
  }

  async function clearSchedule() {
    await window.electronAPI.scheduleTask(task.id, null)
    setScheduleInput('')
    setShowSchedulePopover(false)
    onNotesChange()
  }

  // ── File attachment helpers ──
  function insertFileRef(filename: string, storedName: string, isImage: boolean) {
    const ta = textareaRef.current
    if (!ta) return
    const pos = ta.selectionStart || notes.length
    const before = notes.substring(0, pos)
    const after = notes.substring(pos)
    const prefix = before && !before.endsWith('\n') ? '\n' : ''
    const ref = isImage
      ? `${prefix}![${filename}](/uploads/${storedName})\n`
      : `${prefix}[${filename}](/uploads/${storedName})\n`
    const newVal = before + ref + after
    setNotes(newVal)
    saveNotes(newVal)
  }

  // Clipboard paste handler for images in notes
  function handleNotesPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        handlePasteImage()
        return
      }
    }
  }

  async function handlePasteImage() {
    if (!window.electronAPI.pasteImage) return
    setUploadStatus('Pasting image...')
    try {
      const result = await window.electronAPI.pasteImage()
      if (result.ok && result.path) {
        const filename = `screenshot-${Date.now()}.png`
        insertFileRef(filename, result.path, true)
        setUploadStatus(`Attached ${filename}`)
        if (uploadStatusTimer.current) clearTimeout(uploadStatusTimer.current)
        uploadStatusTimer.current = setTimeout(() => setUploadStatus(null), 2000)
      } else {
        setUploadStatus('No image in clipboard')
        if (uploadStatusTimer.current) clearTimeout(uploadStatusTimer.current)
        uploadStatusTimer.current = setTimeout(() => setUploadStatus(null), 2000)
      }
    } catch {
      setUploadStatus('Paste failed')
      if (uploadStatusTimer.current) clearTimeout(uploadStatusTimer.current)
      uploadStatusTimer.current = setTimeout(() => setUploadStatus(null), 3000)
    }
  }

  // ── Drag-and-drop handlers ──
  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current++
    setIsDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setIsDragOver(false)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    setUploadStatus(`Uploading ${files.length} file(s)...`)
    const results = await uploadFiles(task.id, files)
    // Accumulate all refs into one string. Use functional setNotes to read the latest
    // notes state — avoids stale closure data loss when user types during an upload.
    const allRefs = results.map(r =>
      r.is_image
        ? `![${r.filename}](/uploads/${r.stored_name})\n`
        : `[${r.filename}](/uploads/${r.stored_name})\n`
    ).join('')
    setNotes(prev => {
      const prefix = prev && !prev.endsWith('\n') ? '\n' : ''
      const newVal = prev + prefix + allRefs
      saveNotes(newVal)
      return newVal
    })
    setUploadStatus(`${results.length} file(s) uploaded`)
    onUploadsChanged?.()
    if (uploadStatusTimer.current) clearTimeout(uploadStatusTimer.current)
    uploadStatusTimer.current = setTimeout(() => setUploadStatus(null), 2000)
  }

  function handleTitleBlur() {
    const trimmed = editingTitle.trim()
    if (trimmed && trimmed !== task.title) {
      onTitleChange(task.id, trimmed)
    } else {
      setEditingTitle(task.title)
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); titleRef.current?.blur() }
    if (e.key === 'Escape') { setEditingTitle(task.title); titleRef.current?.blur() }
  }

  function cyclePriority() {
    const next = PRIORITY_CYCLE[task.priority] || 'medium'
    onPriorityChange(task.id, next)
  }

  const isUntriaged = !task.triaged_at && ['clarify', 'google_tasks', 'krisp', 'transcript', 'granola'].includes(task.source)
  const uploadIsError = !!uploadStatus && (uploadStatus.startsWith('Paste failed') || uploadStatus.startsWith('No image') || uploadStatus.startsWith('Upload failed'))
  const uploadIsSuccess = !!uploadStatus && (uploadStatus.startsWith('Attached') || uploadStatus.includes('uploaded'))

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="z-10 bg-surface-0 border-b border-black/[0.06] px-8 py-5 shrink-0">
        {/* Editable title */}
        <input
          ref={titleRef}
          type="text"
          value={editingTitle}
          onChange={e => setEditingTitle(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
          aria-label="Task title"
          className="w-full bg-transparent text-[13px] font-semibold text-text-1 tracking-[-0.01em] leading-snug
                     border-none outline-none focus:outline-none px-1 py-0.5 -mx-1
                     cursor-text hover:bg-black/[0.03] focus:bg-black/[0.04] rounded-md transition-colors
                     placeholder-text-3/40 mb-1"
          placeholder="Task title..."
        />

        {/* Company / deal subtitle */}
        {(task.company_name || task.deal_name) && (
          <div className="text-[11px] text-text-2 mb-2">
            {task.company_name}
            {task.company_name && task.deal_name && <span className="text-text-3"> / </span>}
            {task.deal_name}
          </div>
        )}

        {/* Pills */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {isUntriaged && (
            <>
              <span className={`${PILL} bg-amber-400/[0.12] text-amber-400`}>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                Fresh Inbox Item
              </span>
              <button
                onClick={() => window.electronAPI.triageTask(task.id).then(onNotesChange).catch(err => console.error('[Triage] failed:', err))}
                className={`${BTN} bg-amber-400/10 text-amber-400 hover:bg-amber-400/15`}
                title="Triage this task"
              >
                Triage
              </button>
            </>
          )}

          <button
            onClick={cyclePriority}
            title="Click to change priority"
            className={`${PILL} cursor-pointer hover:ring-1 hover:ring-black/[0.08] ${
              task.priority === 'urgent' ? 'bg-red-2 text-red-1' :
              task.priority === 'high' ? 'bg-red-1/10 text-red-1' :
              task.priority === 'low' ? 'bg-black/[0.04] text-text-3' :
              'bg-black/[0.04] text-text-2'
            }`}
          >
            {task.priority === 'urgent' && <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />}
            {task.priority === 'high' && <span className="w-1.5 h-1.5 rounded-full bg-red-1" />}
            {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
          </button>

          <span className={`${PILL} ${SOURCE_COLORS[task.source] || 'bg-black/[0.04] text-text-2'}`}>
            {SOURCE_LABELS[task.source] || task.source.charAt(0).toUpperCase() + task.source.slice(1)}
          </span>

          {task.due_date && (
            <span className={`${PILL} bg-black/[0.04] text-text-2`}>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              {new Date(task.due_date.includes('T') ? task.due_date : task.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}

          <label className={`${PILL} bg-black/[0.04] text-text-2 pr-1 cursor-pointer`}>
            <select
              value={task.status}
              onChange={e => onStatusChange(task.id, e.target.value)}
              aria-label="Task status"
              className="bg-transparent text-text-1 outline-none cursor-pointer text-[10px] appearance-none"
              style={{ WebkitAppearance: 'none' }}
            >
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value} className="bg-surface-1">{label}</option>
              ))}
            </select>
            <svg className="w-2.5 h-2.5 text-text-3/50 shrink-0 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </label>

          {task.is_recurring && (
            <span className={`${PILL} bg-amber-400/10 text-amber-400`}>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              Recurring
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {task.source === 'clarify' && task.source_id && window.__CLARIFY_BASE_URL && (
            <a
              href={`${window.__CLARIFY_BASE_URL}/objects/task/records/${task.source_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`${BTN} bg-black/[0.04] text-text-2 hover:bg-black/[0.08]`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              CRM
            </a>
          )}

          {/* Session button */}
          {onOpenTerminal && (
            <button
              onClick={onOpenTerminal}
              className={`${BTN} ${
                task.status === 'in_progress'
                  ? 'bg-blue-1/10 text-blue-1'
                  : 'bg-black/[0.04] text-text-2 hover:bg-black/[0.08]'
              }`}
              title={task.status === 'in_progress'
                ? 'Session already running — click to view'
                : 'Open full Claude Code terminal session with task context'}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              {task.status === 'in_progress' ? 'View Session' : 'Session'}
            </button>
          )}

          {/* Schedule button */}
          <button
            onClick={() => { setShowLinkPopover(false); linkSelectionRef.current = null; setShowSchedulePopover(prev => !prev) }}
            className={`${BTN} ${
              task.scheduled_at
                ? 'bg-blue-1/10 text-blue-1'
                : 'bg-black/[0.04] text-text-2 hover:bg-black/[0.08]'
            }`}
            title="Schedule this task for a future push-to-session"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {task.scheduled_at ? 'Scheduled' : 'Schedule'}
          </button>

        </div>

        {/* Schedule popover */}
        {showSchedulePopover && (
          <div ref={schedulePopoverRef} role="dialog" aria-modal="true" aria-label="Schedule task" className="mt-2 p-3 bg-surface-1 border border-black/[0.08] rounded-xl shadow-lg modal-enter">
            <label className="text-[10px] font-semibold text-text-3 uppercase tracking-[0.06em] block mb-2">
              Schedule Push-to-Session
            </label>
            <input
              ref={scheduleInputRef}
              type="datetime-local"
              value={scheduleInput}
              onChange={e => setScheduleInput(e.target.value)}
              className="w-full bg-surface-0 border border-black/[0.08] rounded-lg px-3 py-2 text-[12px] text-text-1
                         focus:outline-none focus:border-blue-1/40 transition-colors"
            />
            <p className="text-[9px] text-text-3 mt-1.5 mb-3">
              Task will auto-execute at this time. Results sent to #agent-management.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={saveSchedule}
                className="px-3 py-1.5 rounded-lg bg-blue-1/20 text-blue-1 text-[10px] font-medium hover:bg-blue-1/30 transition-all cursor-pointer"
              >
                {task.scheduled_at ? 'Update' : 'Schedule'}
              </button>
              {task.scheduled_at && (
                <button
                  onClick={clearSchedule}
                  className="px-3 py-1.5 rounded-lg text-[10px] text-text-3 hover:text-red-1 hover:bg-red-2 transition-all cursor-pointer"
                >
                  Cancel Schedule
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Notes editor */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-6 min-h-[120px]">
        <div
          ref={notesDropZoneRef}
          className="relative"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
        {/* Drop overlay for notes */}
        {isDragOver && (
          <div className="absolute inset-0 rounded-2xl border-2 border-dashed border-purple-1/50 bg-purple-1/5 flex items-center justify-center z-20 pointer-events-none">
            <div className="flex flex-col items-center gap-2">
              <svg className="w-6 h-6 text-purple-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              <span className="text-[11px] text-purple-1 font-medium">Drop files to attach</span>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-[10px] font-semibold text-text-3 uppercase tracking-[0.08em]">Notes</h2>
            {!previewMode && (
              <div ref={toolbarRef} className="flex items-center gap-0.5">
                <button type="button" onClick={() => notesFmt('bold')} title="Bold (Cmd+B)" aria-label="Bold (Cmd+B)"
                  className="w-6 h-6 rounded-md flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-black/[0.06] transition-all cursor-pointer">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z" /><path d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z" /></svg>
                </button>
                <button type="button" onClick={() => notesFmt('italic')} title="Italic (Cmd+I)" aria-label="Italic (Cmd+I)"
                  className="w-6 h-6 rounded-md flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-black/[0.06] transition-all cursor-pointer">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1={19} y1={4} x2={10} y2={4} /><line x1={14} y1={20} x2={5} y2={20} /><line x1={15} y1={4} x2={9} y2={20} /></svg>
                </button>
                <div className="w-px h-3.5 bg-black/[0.06] mx-1" />
                <button type="button" onClick={openLinkPopover} title="Insert Link (Cmd+K)" aria-label="Insert Link (Cmd+K)"
                  className="w-6 h-6 rounded-md flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-black/[0.06] transition-all cursor-pointer">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                </button>
                <button type="button" onClick={() => notesFmt('list')} title="Bullet List" aria-label="Bullet List"
                  className="w-6 h-6 rounded-md flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-black/[0.06] transition-all cursor-pointer">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><line x1={8} y1={6} x2={21} y2={6} /><line x1={8} y1={12} x2={21} y2={12} /><line x1={8} y1={18} x2={21} y2={18} /><circle cx={4} cy={6} r={1} fill="currentColor" /><circle cx={4} cy={12} r={1} fill="currentColor" /><circle cx={4} cy={18} r={1} fill="currentColor" /></svg>
                </button>
                <div className="w-px h-3.5 bg-black/[0.06] mx-1" />
                {/* Attach file / paste image button */}
                <button type="button" onClick={handlePasteImage} title="Attach (paste image from clipboard)" aria-label="Paste image from clipboard"
                  className="w-6 h-6 rounded-md flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-black/[0.06] transition-all cursor-pointer">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewMode(!previewMode)}
              className="flex items-center gap-1 text-[10px] text-text-3 hover:text-text-2 transition-all cursor-pointer px-1.5 py-0.5 rounded-md hover:bg-black/[0.04]"
            >
              {previewMode ? (
                <>
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                  </svg>
                  Edit
                </>
              ) : (
                <>
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                  </svg>
                  Preview
                </>
              )}
            </button>
            {notesSaved && <span className="text-[10px] text-green-1">Saved</span>}
          </div>
        </div>

        {previewMode ? (
          <div
            className="workbook-content min-h-[200px]"
            dangerouslySetInnerHTML={{ __html: renderMarkdownStyled(notes) || '<em class="text-text-3">No notes yet</em>' }}
          />
        ) : (
          <textarea
            ref={textareaRef}
            aria-label="Task notes"
            value={notes}
            onChange={handleNotesChange}
            onKeyDown={notesKeyHandler}
            onPaste={handleNotesPaste}
            className="w-full bg-transparent border-none px-0 py-0 text-[13px] text-text-1 placeholder-text-3/40
                       focus:outline-none resize-none leading-relaxed tracking-[-0.005em]"
            placeholder='Write notes, drag files here, use **bold** or [link text](url)...'
            style={{ minHeight: 200 }}
          />
        )}

        {/* Upload progress indicator */}
        {uploadStatus && (
          <div className="flex items-center gap-2 mt-2 px-1">
            {uploadIsError ? (
              <svg className="w-3 h-3 shrink-0 text-red-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            ) : uploadIsSuccess ? (
              <svg className="w-3 h-3 shrink-0 text-green-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
            ) : (
              <svg className="w-3 h-3 shrink-0 animate-spin-smooth text-purple-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            )}
            <span className={`text-[10px] ${uploadIsError ? 'text-red-1' : uploadIsSuccess ? 'text-green-1' : 'text-text-3'}`}>{uploadStatus}</span>
          </div>
        )}

        {/* Link insertion popover */}
        {showLinkPopover && (
          <div ref={linkPopoverRef} role="dialog" aria-modal="true" aria-label="Insert link" className="fixed z-50 bg-surface-1 border border-black/10 rounded-xl shadow-2xl shadow-black/10 p-4 w-80 modal-enter"
            style={{
              top: toolbarRef.current ? Math.max(8, Math.min(toolbarRef.current.getBoundingClientRect().bottom + 8, window.innerHeight - 240)) : 200,
              left: toolbarRef.current ? (() => { const r = toolbarRef.current.getBoundingClientRect(); return Math.max(8, Math.min(window.innerWidth - 328, r.left + r.width / 2 - 160)) })() : 200,
            }}>
            <div className="text-[10px] font-semibold text-text-3 uppercase tracking-[0.06em] mb-3">Insert Link</div>
            <input
              type="text"
              value={linkText}
              onChange={e => setLinkText(e.target.value)}
              placeholder="Link text"
              className="w-full bg-black/[0.04] border border-black/[0.08] rounded-lg px-3 py-2 text-[12px] text-text-1 placeholder-text-3/40 focus:outline-none focus:border-purple-1/40 mb-2"
              autoFocus={!linkText}
            />
            <input
              type="url"
              value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              placeholder="https://..."
              className="w-full bg-black/[0.04] border border-black/[0.08] rounded-lg px-3 py-2 text-[12px] text-text-1 placeholder-text-3/40 focus:outline-none focus:border-purple-1/40 mb-3"
              autoFocus={!!linkText}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); insertLink() } }}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { setShowLinkPopover(false); linkSelectionRef.current = null; textareaRef.current?.focus() }}
                className="px-3 py-1.5 rounded-lg text-[10px] text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer"
              >Cancel</button>
              <button
                type="button"
                onClick={insertLink}
                className="px-3 py-1.5 rounded-lg bg-purple-1/20 text-purple-1 text-[10px] font-medium hover:bg-purple-1/30 transition-all cursor-pointer"
              >Insert</button>
            </div>
          </div>
        )}
        </div>{/* /notes-drop-zone */}
      </div>

      {/* Footer */}
      <div className="bg-surface-0/90 backdrop-blur-xl border-t border-black/[0.06] shadow-[0_-4px_12px_rgba(0,0,0,0.04)] px-8 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (completing) return
                setCompleting(true)
                completeTimerRef.current = setTimeout(async () => {
                  try { await Promise.resolve(onComplete(task.id)) } catch { setCompleting(false) }
                }, 900)
              }}
              aria-busy={completing}
              aria-label={completing ? 'Completing task…' : 'Mark task complete'}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer overflow-hidden ${
                completing
                  ? 'bg-green-1 text-white scale-105 complete-btn-done'
                  : 'bg-green-1/10 text-green-1 hover:bg-green-1/20'
              }`}
            >
              <svg className={`w-3 h-3 ${completing ? 'complete-check-draw' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
              {completing ? 'Done!' : 'Complete'}
              {completing && <span className="complete-ring" />}
            </button>
            <button
              onClick={() => onToggleRecurring(task.id, !!task.is_recurring)}
              aria-label={task.is_recurring ? 'Remove recurring schedule' : 'Make task recurring'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                task.is_recurring ? 'bg-amber-400/10 text-amber-400' : 'bg-black/[0.04] text-text-3 hover:bg-black/[0.08]'
              }`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              {task.is_recurring ? 'Recurring' : 'Make Recurring'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
