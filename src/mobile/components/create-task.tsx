import React, { useState } from 'react'
import { api } from '../api'

interface Folder {
  id: number
  name: string
  color: string
}

interface Props {
  week: string
  folders: Folder[]
  onBack: () => void
  onCreated: () => void
}

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#8E8E93' },
  { value: 'medium', label: 'Medium', color: '#007AFF' },
  { value: 'high', label: 'High', color: '#FF9500' },
  { value: 'urgent', label: 'Urgent', color: '#FF3B30' },
]

export function CreateTask({ week, folders, onBack, onCreated }: Props) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [priority, setPriority] = useState('medium')
  const [folderId, setFolderId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    if (!title.trim()) return
    setCreating(true)
    try {
      await api.createTask({
        title: title.trim(),
        notes: notes.trim() || null,
        priority,
        folder_id: folderId,
        week,
        source: 'manual',
      })
      onCreated()
    } catch (e) {
      console.error('Failed to create task:', e)
    } finally {
      setCreating(false)
    }
  }

  const currentFolder = folders.find(f => f.id === folderId)

  return (
    <div className="mv">
      {/* Header */}
      <div className="mv-header">
        <button onClick={onBack} className="mv-back">Cancel</button>
        <div className="mv-title-area">
          <div className="mv-title">New Task</div>
        </div>
        <div className="mv-header-actions">
          <button
            onClick={handleCreate}
            disabled={!title.trim() || creating}
            style={{ fontSize: 17, fontWeight: 600, color: title.trim() ? 'var(--accent)' : 'var(--text-quaternary)', background: 'none', border: 'none', padding: 0 }}
          >
            {creating ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="mv-content" style={{ padding: 0 }}>
        {/* Title */}
        <div style={{ background: 'var(--bg-card)', margin: '12px 16px', borderRadius: 12, overflow: 'hidden', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
            style={{
              width: '100%', padding: '14px 16px', fontSize: 17, fontWeight: 600,
              color: 'var(--text-primary)', background: 'transparent', border: 'none', outline: 'none',
              fontFamily: 'inherit', letterSpacing: '-0.02em',
              borderBottom: '0.33px solid var(--separator)',
            }}
          />
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            rows={4}
            style={{
              width: '100%', padding: '12px 16px', fontSize: 15, lineHeight: '1.5',
              color: 'var(--text-primary)', background: 'transparent', border: 'none', outline: 'none',
              resize: 'none', fontFamily: 'inherit', minHeight: 100,
            }}
          />
        </div>

        {/* Priority */}
        <div style={{ margin: '0 16px 12px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 4px 8px' }}>Priority</div>
          <div style={{ display: 'flex', gap: 6, background: 'var(--bg-card)', borderRadius: 12, padding: 4, boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
            {PRIORITY_OPTIONS.map(p => (
              <button key={p.value} onClick={() => setPriority(p.value)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 14, fontWeight: 600, border: 'none',
                  background: priority === p.value ? p.color : 'transparent',
                  color: priority === p.value ? 'white' : p.color,
                }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Folder */}
        <div style={{ margin: '0 16px 12px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 4px 8px' }}>Folder</div>
          <div style={{ background: 'var(--bg-card)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
            <button onClick={() => setFolderId(null)}
              style={{ width: '100%', padding: '12px 16px', fontSize: 15, border: 'none', textAlign: 'left',
                background: folderId === null ? 'var(--accent-bg)' : 'transparent',
                color: folderId === null ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: folderId === null ? 600 : 400,
                borderBottom: '0.33px solid var(--separator)' }}>
              No folder
            </button>
            {folders.map(f => (
              <button key={f.id} onClick={() => setFolderId(f.id)}
                style={{ width: '100%', padding: '12px 16px', fontSize: 15, border: 'none', textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: folderId === f.id ? 'var(--accent-bg)' : 'transparent',
                  color: folderId === f.id ? 'var(--accent)' : 'var(--text-secondary)',
                  fontWeight: folderId === f.id ? 600 : 400,
                  borderBottom: '0.33px solid var(--separator)' }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: f.color, flexShrink: 0 }} />
                {f.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
