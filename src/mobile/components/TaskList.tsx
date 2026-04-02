import React from 'react'

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
  onSelectTask: (task: Task) => void
  onRefresh: () => void
}

// ── Source badges ──
const SOURCE_LABELS: Record<string, string> = {
  clarify: 'CRM',
  recurring: 'Rec',
  granola: 'Gran',
  google_tasks: 'GTK',
  krisp: 'Krsp',
  transcript: 'Xscr',
  organized: 'Org',
}

const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  clarify: { bg: 'rgba(0, 122, 255, 0.1)', text: '#007AFF' },
  recurring: { bg: 'rgba(255, 149, 0, 0.1)', text: '#FF9500' },
  granola: { bg: 'rgba(175, 82, 222, 0.1)', text: '#AF52DE' },
  google_tasks: { bg: 'rgba(0, 0, 0, 0.04)', text: '#8E8E93' },
  krisp: { bg: 'rgba(52, 199, 89, 0.1)', text: '#34C759' },
  transcript: { bg: 'rgba(90, 200, 250, 0.1)', text: '#5AC8FA' },
  organized: { bg: 'rgba(175, 82, 222, 0.1)', text: '#AF52DE' },
}

// ── Status badges ──
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
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0"
      style={{ background: bg, color: text }}
    >
      {label}
    </span>
  )
}

function TaskRow({ task, ptyStatus, onSelect }: {
  task: Task
  ptyStatus: string | null
  onSelect: () => void
}) {
  const needsTriage = !task.triaged_at && ['clarify', 'google_tasks', 'krisp', 'transcript', 'granola'].includes(task.source)
  const statusBadge = needsTriage ? null : STATUS_BADGES[task.status]
  const sourceLabel = SOURCE_LABELS[task.source]
  const sourceColor = SOURCE_COLORS[task.source]
  const ptyBadge = ptyStatus ? PTY_BADGES[ptyStatus] : null

  return (
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
          <Badge bg="rgba(255, 59, 48, 0.08)" text="#FF3B30" label="↑" />
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
  )
}

export default function TaskList({ folders, unfolderedTasks, ptyStatuses, onSelectTask, onRefresh }: Props) {
  const openCount = unfolderedTasks.length

  return (
    <div className="py-4">
      {/* Pull to refresh */}
      <button
        onClick={onRefresh}
        className="w-full py-2 text-[12px] text-center font-medium active:opacity-50"
        style={{ color: 'var(--accent)' }}
      >
        Tap to refresh
      </button>

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
            {unfolderedTasks.map((task, i) => (
              <TaskRow
                key={task.id}
                task={task}
                ptyStatus={ptyStatuses[`task-${task.id}`] || null}
                onSelect={() => onSelectTask(task)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Folders */}
      {folders.map(folder => {
        const tasks = folder.tasks || []
        return (
          <div key={folder.id} className="mb-4 mx-4">
            <div className="flex items-center gap-2 px-1 mb-2">
              <span
                className="w-3 h-3 rounded"
                style={{ backgroundColor: folder.color }}
              />
              <span className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                {folder.name}
              </span>
              <span className="text-[12px] font-mono" style={{ color: 'var(--text-quaternary)' }}>{tasks.length}</span>
            </div>
            {tasks.length > 0 ? (
              <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
                {tasks.map((task, i) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    ptyStatus={ptyStatuses[`task-${task.id}`] || null}
                    onSelect={() => onSelectTask(task)}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl py-6 text-center" style={{ background: 'var(--bg-card)', boxShadow: '0 0.5px 1px rgba(0,0,0,0.03)' }}>
                <span className="text-[13px]" style={{ color: 'var(--text-quaternary)' }}>No tasks</span>
              </div>
            )}
          </div>
        )
      })}

      {folders.length === 0 && unfolderedTasks.length === 0 && (
        <div className="text-center mt-20">
          <div className="text-[40px] mb-3">✓</div>
          <div className="text-[15px] font-medium" style={{ color: 'var(--text-secondary)' }}>All clear</div>
          <div className="text-[13px] mt-1" style={{ color: 'var(--text-tertiary)' }}>No active tasks this week</div>
        </div>
      )}
    </div>
  )
}
