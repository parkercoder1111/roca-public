import React, { useState, useEffect, useRef } from 'react'
import { api } from '../api'

interface Task {
  id: number
  title: string
  status: string
  priority: string
  source: string
  company_name: string | null
  deal_name: string | null
  due_date: string | null
  notes: string | null
  week: string
  folder_id: number | null
  scheduled_at?: string | null
  triaged_at?: string | null
}

interface Folder {
  id: number
  name: string
  color: string
}

interface Props {
  task: Task
  folders: Folder[]
  onBack: () => void
  onOpenTerminal: () => void
  onTaskUpdated: () => void
}

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open', color: '#8E8E93' },
  { value: 'in_progress', label: 'In Progress', color: '#007AFF' },
  { value: 'needs_input', label: 'Needs Input', color: '#FF9500' },
  { value: 'draft_ready', label: 'Draft Ready', color: '#34C759' },
  { value: 'waiting', label: 'Waiting', color: '#5AC8FA' },
  { value: 'blocked', label: 'Blocked', color: '#FF3B30' },
  { value: 'done', label: 'Done', color: '#34C759' },
]

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#8E8E93' },
  { value: 'medium', label: 'Medium', color: '#007AFF' },
  { value: 'high', label: 'High', color: '#FF9500' },
  { value: 'urgent', label: 'Urgent', color: '#FF3B30' },
]

export function TaskDetail({ task, folders, onBack, onOpenTerminal, onTaskUpdated }: Props) {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes || '')
  const [status, setStatus] = useState(task.status)
  const [priority, setPriority] = useState(task.priority)
  const [folderId, setFolderId] = useState(task.folder_id)
  const [showStatusPicker, setShowStatusPicker] = useState(false)
  const [showPriorityPicker, setShowPriorityPicker] = useState(false)
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isDone, setIsDone] = useState(task.status === 'done')
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const titleDirty = useRef(false)
  const notesDirty = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestNotesRef = useRef(notes)
  latestNotesRef.current = notes
  const latestTitleRef = useRef(title)
  latestTitleRef.current = title

  // Auto-save title on blur
  const saveTitle = async () => {
    if (!titleDirty.current || title === task.title) return
    titleDirty.current = false
    await api.updateFields(task.id, { title })
    onTaskUpdated()
  }

  // Debounced auto-save notes (800ms after typing stops)
  const saveNotes = async () => {
    if (!notesDirty.current || notes === (task.notes || '')) return
    notesDirty.current = false
    await api.updateFields(task.id, { notes })
    onTaskUpdated()
  }

  const debouncedSaveNotes = (value: string) => {
    setNotes(value)
    notesDirty.current = true
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => saveNotes().catch(err => console.error('[TaskDetail/mobile] saveNotes failed:', err)), 800)
  }

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      // Save any pending changes on unmount using refs to avoid stale closure values
      if (notesDirty.current) api.updateFields(task.id, { notes: latestNotesRef.current }).catch(() => {})
      if (titleDirty.current) api.updateFields(task.id, { title: latestTitleRef.current }).catch(() => {})
    }
  }, [])

  const updateStatus = async (newStatus: string) => {
    setStatus(newStatus)
    setShowStatusPicker(false)
    setIsDone(newStatus === 'done')
    await api.updateStatus(task.id, newStatus)
    onTaskUpdated()
  }

  const updatePriority = async (newPriority: string) => {
    setPriority(newPriority)
    setShowPriorityPicker(false)
    await api.updateFields(task.id, { priority: newPriority })
    onTaskUpdated()
  }

  const updateFolder = async (newFolderId: number | null) => {
    setFolderId(newFolderId)
    setShowFolderPicker(false)
    await api.updateFields(task.id, { folder_id: newFolderId })
    onTaskUpdated()
  }

  const toggleDone = async () => {
    const newDone = !isDone
    setIsDone(newDone)
    if (newDone) {
      setStatus('done')
      await api.toggleTask(task.id)
    } else {
      setStatus('open')
      await api.toggleTask(task.id)
    }
    onTaskUpdated()
  }

  const triageTask = async () => {
    await api.updateFields(task.id, { triaged_at: new Date().toISOString() })
    onTaskUpdated()
  }

  const needsTriage = !task.triaged_at && ['crm', 'google_tasks', 'voice_notes', 'transcript', 'meeting_notes'].includes(task.source)
  const currentStatus = STATUS_OPTIONS.find(s => s.value === status)
  const currentPriority = PRIORITY_OPTIONS.find(p => p.value === priority)
  const currentFolder = folders.find(f => f.id === folderId)

  return (
    <div className="mv">
      {/* Header */}
      <div className="mv-header">
        <button onClick={() => { saveTitle(); saveNotes(); onBack() }} className="mv-back">
          <svg width="10" height="16" fill="none" viewBox="0 0 10 16">
            <path d="M9 1L2 8l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Tasks
        </button>
        <div className="mv-title-area">
          <div className="mv-title">Details</div>
        </div>
        <div className="mv-header-actions">
          <button onClick={onOpenTerminal} className="mv-icon-btn" title="Terminal" aria-label="Open terminal">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="mv-content" style={{ padding: '0' }}>
        {/* Triage banner */}
        {needsTriage && (
          <div style={{ padding: '12px 16px', background: 'rgba(255, 149, 0, 0.06)', borderBottom: '0.33px solid var(--separator)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--orange)' }}>Needs triage</span>
            <button onClick={triageTask} style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', padding: '6px 12px' }}>
              Mark Triaged
            </button>
          </div>
        )}

        {/* Title + checkbox */}
        <div style={{ padding: '16px', display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--bg-card)', borderBottom: '0.33px solid var(--separator)' }}>
          <button onClick={toggleDone} aria-label={isDone ? 'Mark as not done' : 'Mark as done'} style={{ marginTop: 2, flexShrink: 0, width: 24, height: 24, borderRadius: 12, border: `2px solid ${isDone ? 'var(--green)' : priority === 'urgent' ? 'var(--red)' : 'var(--text-quaternary)'}`, background: isDone ? 'var(--green)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
            {isDone && (
              <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="white" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          <textarea
            value={title}
            onChange={e => { setTitle(e.target.value); titleDirty.current = true }}
            onBlur={saveTitle}
            rows={1}
            style={{
              flex: 1, fontSize: 17, fontWeight: 600, color: isDone ? 'var(--text-tertiary)' : 'var(--text-primary)',
              textDecoration: isDone ? 'line-through' : 'none',
              background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              fontFamily: 'inherit', letterSpacing: '-0.02em', padding: 0,
              minHeight: 24, lineHeight: '1.35',
            }}
          />
        </div>

        {/* Fields */}
        <div style={{ background: 'var(--bg-card)', margin: '12px 16px', borderRadius: 12, overflow: 'hidden', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
          {/* Status */}
          <button onClick={() => setShowStatusPicker(!showStatusPicker)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', background: 'none', border: 'none', borderBottom: '0.33px solid var(--separator)', textAlign: 'left' }}>
            <span style={{ fontSize: 15, color: 'var(--text-primary)' }}>Status</span>
            <span style={{ fontSize: 15, color: currentStatus?.color, fontWeight: 500 }}>{currentStatus?.label || status}</span>
          </button>
          {showStatusPicker && (
            <div style={{ padding: '4px 8px 8px', borderBottom: '0.33px solid var(--separator)', background: 'rgba(0,0,0,0.02)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {STATUS_OPTIONS.map(s => (
                  <button key={s.value} onClick={() => updateStatus(s.value)}
                    style={{ padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none',
                      background: status === s.value ? s.color : 'rgba(0,0,0,0.04)',
                      color: status === s.value ? 'white' : s.color }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Priority */}
          <button onClick={() => setShowPriorityPicker(!showPriorityPicker)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', background: 'none', border: 'none', borderBottom: '0.33px solid var(--separator)', textAlign: 'left' }}>
            <span style={{ fontSize: 15, color: 'var(--text-primary)' }}>Priority</span>
            <span style={{ fontSize: 15, color: currentPriority?.color, fontWeight: 500 }}>{currentPriority?.label || priority}</span>
          </button>
          {showPriorityPicker && (
            <div style={{ padding: '4px 8px 8px', borderBottom: '0.33px solid var(--separator)', background: 'rgba(0,0,0,0.02)' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {PRIORITY_OPTIONS.map(p => (
                  <button key={p.value} onClick={() => updatePriority(p.value)}
                    style={{ flex: 1, padding: '6px 0', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none',
                      background: priority === p.value ? p.color : 'rgba(0,0,0,0.04)',
                      color: priority === p.value ? 'white' : p.color }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Folder */}
          <button onClick={() => setShowFolderPicker(!showFolderPicker)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', background: 'none', border: 'none', borderBottom: '0.33px solid var(--separator)', textAlign: 'left' }}>
            <span style={{ fontSize: 15, color: 'var(--text-primary)' }}>Folder</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {currentFolder && <span style={{ width: 10, height: 10, borderRadius: 3, background: currentFolder.color, display: 'inline-block' }} />}
              <span style={{ fontSize: 15, color: 'var(--text-tertiary)' }}>{currentFolder?.name || 'None'}</span>
            </div>
          </button>
          {showFolderPicker && (
            <div style={{ padding: '4px 8px 8px', borderBottom: '0.33px solid var(--separator)', background: 'rgba(0,0,0,0.02)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <button onClick={() => updateFolder(null)}
                  style={{ padding: '8px 12px', borderRadius: 8, fontSize: 14, border: 'none', textAlign: 'left',
                    background: folderId === null ? 'var(--accent-bg)' : 'transparent',
                    color: folderId === null ? 'var(--accent)' : 'var(--text-secondary)', fontWeight: folderId === null ? 600 : 400 }}>
                  None
                </button>
                {folders.map(f => (
                  <button key={f.id} onClick={() => updateFolder(f.id)}
                    style={{ padding: '8px 12px', borderRadius: 8, fontSize: 14, border: 'none', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: folderId === f.id ? 'var(--accent-bg)' : 'transparent',
                      color: folderId === f.id ? 'var(--accent)' : 'var(--text-secondary)', fontWeight: folderId === f.id ? 600 : 400 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: f.color, flexShrink: 0 }} />
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Source */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '0.33px solid var(--separator)' }}>
            <span style={{ fontSize: 15, color: 'var(--text-primary)' }}>Source</span>
            <span style={{ fontSize: 15, color: 'var(--text-tertiary)' }}>{task.source}</span>
          </div>

          {/* Company / Deal */}
          {(task.company_name || task.deal_name) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px' }}>
              <span style={{ fontSize: 15, color: 'var(--text-primary)' }}>Company</span>
              <span style={{ fontSize: 15, color: 'var(--text-tertiary)', maxWidth: '60%', textAlign: 'right' }}>
                {task.company_name}{task.deal_name ? ` / ${task.deal_name}` : ''}
              </span>
            </div>
          )}
        </div>

        {/* Notes */}
        <div style={{ margin: '0 16px 12px', background: 'var(--bg-card)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
          <div style={{ padding: '10px 16px 4px', fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notes</div>
          <textarea
            ref={notesRef}
            value={notes}
            onChange={e => debouncedSaveNotes(e.target.value)}
            onBlur={saveNotes}
            placeholder="Add notes..."
            style={{
              width: '100%', minHeight: 120, padding: '8px 16px 16px', fontSize: 15, lineHeight: '1.5',
              color: 'var(--text-primary)', background: 'transparent', border: 'none', outline: 'none',
              resize: 'none', fontFamily: 'inherit',
              WebkitUserSelect: 'text', userSelect: 'text',
            }}
          />
        </div>

        {/* Action buttons */}
        <div style={{ margin: '0 16px 12px', display: 'flex', gap: 10 }}>
          <button onClick={toggleDone} style={{
            flex: 1, padding: '14px', borderRadius: 14, border: 'none',
            fontSize: 16, fontWeight: 600, letterSpacing: '-0.02em',
            background: isDone ? 'rgba(52, 199, 89, 0.12)' : 'var(--green)',
            color: isDone ? 'var(--green)' : 'white',
            transition: 'all 0.2s',
          }}>
            {isDone ? 'Reopen' : 'Complete'}
          </button>
          <button onClick={onOpenTerminal} style={{
            flex: 1, padding: '14px', borderRadius: 14, border: 'none',
            fontSize: 16, fontWeight: 600, letterSpacing: '-0.02em',
            background: 'var(--accent)', color: 'white',
          }}>
            Terminal
          </button>
        </div>

        {/* Spacer for safe area */}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}
