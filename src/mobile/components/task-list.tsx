import React, { useRef, useState } from 'react'
import { api } from '../api'
import { Haptics, ImpactStyle } from '@capacitor/haptics'

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
  tasks?: Task[]
}

interface Props {
  folders: Folder[]
  unfolderedTasks: Task[]
  ptyStatuses: Record<string, string>
  inboxCount: number
  onSelectTask: (task: Task) => void
  onRefresh: () => void
}

// ── Source badges ──
const SOURCE_LABELS: Record<string, string> = {
  crm: 'CRM', recurring: 'Rec', meeting_notes: 'Notes', google_tasks: 'GTK',
  voice_notes: 'Voice', transcript: 'Xscr', organized: 'Org',
}

const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  crm: { bg: 'rgba(0, 122, 255, 0.1)', text: '#007AFF' },
  recurring: { bg: 'rgba(255, 149, 0, 0.1)', text: '#FF9500' },
  meeting_notes: { bg: 'rgba(175, 82, 222, 0.1)', text: '#AF52DE' },
  google_tasks: { bg: 'rgba(0, 0, 0, 0.04)', text: '#8E8E93' },
  voice_notes: { bg: 'rgba(52, 199, 89, 0.1)', text: '#34C759' },
  transcript: { bg: 'rgba(90, 200, 250, 0.1)', text: '#5AC8FA' },
  organized: { bg: 'rgba(175, 82, 222, 0.1)', text: '#AF52DE' },
}

const STATUS_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  needs_input: { bg: 'rgba(255, 149, 0, 0.1)', text: '#FF9500', label: 'Needs Input' },
  in_progress: { bg: 'rgba(0, 122, 255, 0.1)', text: '#007AFF', label: 'In Progress' },
  draft_ready: { bg: 'rgba(52, 199, 89, 0.1)', text: '#34C759', label: 'Draft Ready' },
  waiting: { bg: 'rgba(90, 200, 250, 0.1)', text: '#5AC8FA', label: 'Waiting' },
  blocked: { bg: 'rgba(255, 59, 48, 0.1)', text: '#FF3B30', label: 'Blocked' },
}

const PTY_BADGES: Record<string, { bg: string; text: string; label: string }> = {
  running: { bg: 'rgba(52, 199, 89, 0.1)', text: '#34C759', label: 'Running' },
  needs_input: { bg: 'rgba(255, 149, 0, 0.1)', text: '#FF9500', label: 'Input' },
}

function Badge({ bg, text, label }: { bg: string; text: string; label: string }) {
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0"
      style={{ background: bg, color: text }}>
      {label}
    </span>
  )
}

function TaskRow({ task, ptyStatus, onSelect, onToggle }: {
  task: Task
  ptyStatus: string | null
  onSelect: () => void
  onToggle: () => void
}) {
  const needsTriage = !task.triaged_at && ['crm', 'google_tasks', 'voice_notes', 'transcript', 'meeting_notes'].includes(task.source)
  const statusBadge = needsTriage ? null : STATUS_BADGES[task.status]
  const sourceLabel = SOURCE_LABELS[task.source]
  const sourceColor = SOURCE_COLORS[task.source]
  const ptyBadge = ptyStatus ? PTY_BADGES[ptyStatus] : null

  // Swipe state
  const rowRef = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const startY = useRef(0)
  const swiping = useRef(false)
  const scrolling = useRef(false)
  const [offset, setOffset] = useState(0)
  const [completing, setCompleting] = useState(false)

  const handleTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
    swiping.current = true
    scrolling.current = false
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!swiping.current || scrolling.current) return
    const dx = e.touches[0].clientX - startX.current
    const dy = e.touches[0].clientY - startY.current
    // If vertical movement dominates, this is a scroll — don't swipe
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
      scrolling.current = true
      setOffset(0)
      return
    }
    // Only allow left swipe (negative) with resistance
    if (dx < 0) setOffset(Math.max(dx * 0.8, -100))
    else setOffset(0)
  }

  const handleTouchEnd = () => {
    swiping.current = false
    if (offset < -60) {
      setCompleting(true)
      setOffset(-100)
      onToggle()
      setTimeout(() => { setOffset(0); setCompleting(false) }, 300)
    } else {
      setOffset(0)
    }
  }

  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      {/* Swipe background */}
      <div style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width: 100,
        background: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="white" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <div
        ref={rowRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ transform: `translateX(${offset}px)`, transition: swiping.current ? 'none' : 'transform 0.2s', background: 'var(--bg-card)', position: 'relative', zIndex: 1 }}
      >
        <button
          onClick={onSelect}
          className="w-full text-left px-4 py-3 flex items-center gap-3 active:bg-black/[0.03]"
          style={{
            borderBottom: '0.33px solid var(--separator)',
            background: needsTriage ? 'rgba(255, 149, 0, 0.03)' : undefined,
          }}
        >
          {/* Checkbox circle */}
          <span
            onClick={e => { e.stopPropagation(); onToggle() }}
            className="shrink-0 w-[22px] h-[22px] rounded-full border-[1.5px] flex items-center justify-center"
            style={{ borderColor: task.priority === 'urgent' ? '#FF3B30' : 'rgba(60, 60, 67, 0.18)' }}
          />

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-normal truncate" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
              {task.title}
            </div>
            {task.company_name && (
              <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>
                {task.company_name}
                {task.deal_name && ` / ${task.deal_name}`}
              </div>
            )}
          </div>

          {/* Badges */}
          <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end max-w-[45%]">
            {task.priority === 'urgent' && (
              <span className="text-[10px] font-bold px-1 py-0.5 rounded" style={{ color: '#FF3B30' }}>!</span>
            )}
            {task.priority === 'high' && (
              <Badge bg="rgba(255, 59, 48, 0.08)" text="#FF3B30" label="^" />
            )}
            {statusBadge && <Badge {...statusBadge} />}
            {ptyBadge && <Badge {...ptyBadge} />}
            {needsTriage && <Badge bg="rgba(255, 149, 0, 0.1)" text="#FF9500" label="Review" />}
            {sourceLabel && sourceColor && <Badge bg={sourceColor.bg} text={sourceColor.text} label={sourceLabel} />}
          </div>

          {/* Chevron */}
          <svg className="shrink-0 w-4 h-4" style={{ color: 'var(--text-quaternary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export function TaskList({ folders, unfolderedTasks, ptyStatuses, inboxCount, onSelectTask, onRefresh }: Props) {
  const openCount = unfolderedTasks.length
  const [collapsedFolders, setCollapsedFolders] = useState<Set<number>>(new Set())

  const toggleFolder = (id: number) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleToggle = async (taskId: number) => {
    try { await Haptics.impact({ style: ImpactStyle.Light }) } catch {}
    await api.toggleTask(taskId)
    onRefresh()
  }

  return (
    <div className="py-4">
      {/* Pull to refresh — invisible trigger area + last updated */}
      <button
        onClick={onRefresh}
        className="w-full py-1.5 text-[11px] text-center font-medium active:opacity-50"
        style={{ color: 'var(--text-quaternary)' }}
      >
        Pull to refresh
      </button>

      {/* Inbox count */}
      {inboxCount > 0 && (
        <div className="mx-4 mb-3 rounded-xl overflow-hidden" style={{ background: 'rgba(255, 149, 0, 0.06)', border: '0.5px solid rgba(255, 149, 0, 0.15)' }}>
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--orange)' }}>Inbox</span>
              <span style={{ fontSize: 11, fontWeight: 700, background: 'var(--orange)', color: 'white', borderRadius: 8, padding: '1px 6px', minWidth: 18, textAlign: 'center' }}>{inboxCount}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>tasks need triage</span>
          </div>
        </div>
      )}

      {/* Open (unfoldered) tasks */}
      {openCount > 0 && (
        <div className="mb-4 mx-4">
          <div className="flex items-center justify-between px-1 mb-2">
            <span className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
              Open
            </span>
            <span className="text-[12px] font-mono" style={{ color: 'var(--text-quaternary)' }}>{openCount}</span>
          </div>
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
            {unfolderedTasks.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                ptyStatus={ptyStatuses[`task-${task.id}`] || null}
                onSelect={() => onSelectTask(task)}
                onToggle={() => handleToggle(task.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Folders */}
      {folders.map(folder => {
        const tasks = folder.tasks || []
        const isCollapsed = collapsedFolders.has(folder.id)
        return (
          <div key={folder.id} className="mb-4 mx-4">
            <button onClick={() => toggleFolder(folder.id)} className="flex items-center gap-2 px-1 mb-2 w-full text-left" style={{ background: 'none', border: 'none', padding: '0 4px' }}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="var(--text-quaternary)" style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.15s' }}>
                <path d="M1 2l3 3 3-3" stroke="var(--text-quaternary)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              </svg>
              <span className="w-3 h-3 rounded" style={{ backgroundColor: folder.color }} />
              <span className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                {folder.name}
              </span>
              <span className="text-[12px] font-mono" style={{ color: 'var(--text-quaternary)' }}>{tasks.length}</span>
            </button>
            {!isCollapsed && (
              tasks.length > 0 ? (
                <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
                  {tasks.map(task => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      ptyStatus={ptyStatuses[`task-${task.id}`] || null}
                      onSelect={() => onSelectTask(task)}
                      onToggle={() => handleToggle(task.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl py-6 text-center" style={{ background: 'var(--bg-card)', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
                  <span className="text-[13px]" style={{ color: 'var(--text-quaternary)' }}>No tasks</span>
                </div>
              )
            )}
          </div>
        )
      })}

      {folders.length === 0 && unfolderedTasks.length === 0 && (
        <div className="text-center mt-20">
          <div className="text-[40px] mb-3">All clear</div>
          <div className="text-[15px] font-medium" style={{ color: 'var(--text-secondary)' }}>No active tasks</div>
          <div className="text-[13px] mt-1" style={{ color: 'var(--text-tertiary)' }}>Tap + to create one</div>
        </div>
      )}
    </div>
  )
}
