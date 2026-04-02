import React, { useCallback, memo, useMemo } from 'react'
import TaskRow from './TaskRow'
import FoldersPanel from './FoldersPanel'
import type { Task, Folder } from '@shared/types'
import { currentIsoWeek } from '../lib/formatDate'

interface Props {
  openTasks: Task[]
  completedTasks: Task[]
  folders: Folder[]
  selectedTaskId: number | null
  week: string
  onSelectTask: (id: number) => void
  onToggleTask: (id: number) => void
  onToggleUrgent: (id: number) => void
  onCreateFolder: () => void
  onRenameFolder: (folderId: number, name: string) => void
  onToggleFolderCollapse: (folderId: number) => void
  onDeleteFolder: (folderId: number) => void
  onSetTaskFolder: (taskId: number, folderId: number | null) => void
  onUpdateFolderColor: (folderId: number, color: string) => void
  onReorderFolders: (folderIds: number[]) => void
  onReorderTasks: (taskIds: number[]) => void
  folderColors: string[]
  ptyStatuses?: Record<string, string>
}

// Module-level constant — avoids re-allocating the same string on every render pass
const COMPLETED_ROW_CLASS = 'flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-black/[0.03] transition-colors w-full text-left'

// Status group definitions in display order
const STATUS_GROUPS: { key: string; label: string; dotColor: string; textColor: string; pulse?: boolean }[] = [
  { key: 'needs_input', label: 'Needs Input', dotColor: 'bg-amber-400', textColor: 'text-amber-400' },
  { key: 'draft_ready', label: 'Draft Ready', dotColor: 'bg-emerald-400', textColor: 'text-emerald-400' },
  { key: 'in_progress', label: 'In Progress', dotColor: 'bg-blue-1', textColor: 'text-blue-1', pulse: true },
  { key: 'open', label: 'Open', dotColor: '', textColor: 'text-text-3' },
  { key: 'waiting', label: 'Waiting', dotColor: 'bg-sky-400', textColor: 'text-sky-400' },
  { key: 'blocked', label: 'Blocked', dotColor: 'bg-red-1', textColor: 'text-red-1' },
  { key: 'carried', label: 'Carried', dotColor: 'bg-surface-4', textColor: 'text-text-3' },
]

// Memoized status group — isolates the inline onDrop closure to prevent
// all groups from re-rendering on every PTY status poll (every 2 seconds)
interface StatusGroupProps {
  group: typeof STATUS_GROUPS[number]
  tasks: Task[]
  selectedTaskId: number | null
  onSelectTask: (id: number) => void
  onToggleTask: (id: number) => void
  onToggleUrgent: (id: number) => void
  handleGroupDrop: (e: React.DragEvent, tasks: Task[]) => void
  handleGroupDragOver: (e: React.DragEvent) => void
  handleGroupDragLeave: (e: React.DragEvent) => void
  ptyStatuses: Record<string, string>
}

const StatusGroup = memo(function StatusGroup({
  group, tasks, selectedTaskId, onSelectTask, onToggleTask, onToggleUrgent,
  handleGroupDrop, handleGroupDragOver, handleGroupDragLeave, ptyStatuses,
}: StatusGroupProps) {
  const onDrop = useCallback(
    (e: React.DragEvent) => handleGroupDrop(e, tasks),
    [handleGroupDrop, tasks]
  )
  return (
    <div className="mb-5">
      <h2 className="text-[9px] font-semibold uppercase tracking-[0.1em] mb-2 px-1 flex items-center gap-2">
        {group.dotColor && (
          <span className={`w-1.5 h-1.5 rounded-full ${group.dotColor} ${group.pulse ? 'animate-pulse' : ''}`} />
        )}
        <span className={group.textColor}>{group.label}</span>
        <span className="text-text-3/50 font-mono font-normal">{tasks.length}</span>
      </h2>
      <div
        className="space-y-0.5"
        onDragOver={handleGroupDragOver}
        onDrop={onDrop}
        onDragLeave={handleGroupDragLeave}
      >
        {tasks.map(task => (
          <TaskRow
            key={task.id}
            task={task}
            isSelected={task.id === selectedTaskId}
            onSelect={onSelectTask}
            onToggle={onToggleTask}
            onToggleUrgent={onToggleUrgent}
            ptyStatus={ptyStatuses[`task-${task.id}`]}
          />
        ))}
      </div>
    </div>
  )
})

function clearDropIndicators(container: HTMLElement) {
  container.querySelectorAll('.drop-before, .drop-after').forEach(
    el => el.classList.remove('drop-before', 'drop-after')
  )
}

export default function TaskList({
  openTasks, completedTasks, folders, selectedTaskId, week,
  onSelectTask, onToggleTask, onToggleUrgent,
  onCreateFolder, onRenameFolder, onToggleFolderCollapse,
  onDeleteFolder, onSetTaskFolder, onUpdateFolderColor,
  onReorderFolders, onReorderTasks, folderColors, ptyStatuses = {}
}: Props) {
  // Filter open tasks to only unfoldered ones — memoized so StatusGroup.memo is effective
  const unfolderedTasks = useMemo(() => openTasks.filter(t => !t.folder_id), [openTasks])

  // Group unfoldered tasks by status — memoized to prevent new array refs on every PTY poll
  const groupedTasks = useMemo(() => {
    const result: Record<string, Task[]> = {}
    for (const group of STATUS_GROUPS) {
      const tasks = unfolderedTasks.filter(t => t.status === group.key)
      if (tasks.length > 0) result[group.key] = tasks
    }
    return result
  }, [unfolderedTasks])

  const handleGroupDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/roca-task')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const container = e.currentTarget as HTMLElement
    clearDropIndicators(container)

    const target = (e.target as HTMLElement).closest('[data-task-id]') as HTMLElement
    if (!target || !container.contains(target)) return

    const rect = target.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    target.classList.add(position === 'before' ? 'drop-before' : 'drop-after')
  }, [])

  const handleGroupDrop = useCallback((e: React.DragEvent, tasks: Task[]) => {
    e.preventDefault()
    clearDropIndicators(e.currentTarget as HTMLElement)

    const draggedId = Number(e.dataTransfer.getData('application/roca-task'))
    if (!draggedId) return

    const fromFolder = e.dataTransfer.getData('application/roca-task-folder')

    // Reorder within this group
    const target = (e.target as HTMLElement).closest('[data-task-id]') as HTMLElement
    if (!target) return

    const targetId = Number(target.getAttribute('data-task-id'))
    if (draggedId === targetId) return

    const currentIds = tasks.map(t => t.id)
    if (!currentIds.includes(draggedId)) {
      // Task is from a different status group — remove from folder if applicable, then bail
      if (fromFolder) onSetTaskFolder(draggedId, null)
      return
    }

    // Only remove from folder once we know the reorder will proceed
    if (fromFolder) {
      onSetTaskFolder(draggedId, null)
    }

    const newIds = currentIds.filter(id => id !== draggedId)
    const insertIdx = newIds.indexOf(targetId)
    if (insertIdx === -1) return
    const rect = target.getBoundingClientRect()
    const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    newIds.splice(position === 'before' ? insertIdx : insertIdx + 1, 0, draggedId)

    onReorderTasks(newIds)
  }, [onReorderTasks, onSetTaskFolder])

  const handleGroupDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      clearDropIndicators(e.currentTarget as HTMLElement)
    }
  }, [])

  // Empty-zone drop handlers (shown when unfolderedTasks.length === 0)
  const handleEmptyZoneDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/roca-task')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    ;(e.currentTarget as HTMLElement).classList.add('drag-over')
  }, [])
  const handleEmptyZoneDragLeave = useCallback((e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).classList.remove('drag-over')
  }, [])
  const handleEmptyZoneDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).classList.remove('drag-over')
    const draggedId = Number(e.dataTransfer.getData('application/roca-task'))
    const fromFolder = e.dataTransfer.getData('application/roca-task-folder')
    if (draggedId && fromFolder) {
      onSetTaskFolder(draggedId, null)
    }
  }, [onSetTaskFolder])

  // Allow dropping tasks from folders onto the main section
  const handleSectionDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/roca-task')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleSectionDrop = useCallback((e: React.DragEvent) => {
    // Only handle if not already handled by a group container
    if (e.defaultPrevented) return
    e.preventDefault()

    const draggedId = Number(e.dataTransfer.getData('application/roca-task'))
    if (!draggedId) return

    const fromFolder = e.dataTransfer.getData('application/roca-task-folder')
    if (fromFolder) {
      onSetTaskFolder(draggedId, null)
    }
  }, [onSetTaskFolder])

  return (
    <div>
      {/* Unfoldered tasks section */}
      <section
        className="mb-6"
        id="task-lists"
        onDragOver={handleSectionDragOver}
        onDrop={handleSectionDrop}
      >
        {unfolderedTasks.length > 0 ? (
          STATUS_GROUPS.map(group => {
            const tasks = groupedTasks[group.key]
            if (!tasks) return null
            return (
              <StatusGroup
                key={group.key}
                group={group}
                tasks={tasks}
                selectedTaskId={selectedTaskId}
                onSelectTask={onSelectTask}
                onToggleTask={onToggleTask}
                onToggleUrgent={onToggleUrgent}
                handleGroupDrop={handleGroupDrop}
                handleGroupDragOver={handleGroupDragOver}
                handleGroupDragLeave={handleGroupDragLeave}
                ptyStatuses={ptyStatuses}
              />
            )
          })
        ) : (
          <div
            className="task-drop-zone py-8 px-4 rounded-2xl border border-black/[0.06] bg-black/[0.02] text-center"
            onDragOver={handleEmptyZoneDragOver}
            onDragLeave={handleEmptyZoneDragLeave}
            onDrop={handleEmptyZoneDrop}
          >
            <div className="empty-state-icon">
              <svg className="w-6 h-6 text-text-3/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <div className="text-[11px] font-medium text-text-2 mb-0.5">All clear</div>
            <div className="text-[10px] text-text-3/60 leading-relaxed break-words">{week === currentIsoWeek() ? 'New tasks, sync results, and inbox triage will appear here' : 'No open tasks this week'}</div>
          </div>
        )}
      </section>

      {/* Folders */}
      <FoldersPanel
        folders={folders}
        selectedTaskId={selectedTaskId}
        week={week}
        onSelectTask={onSelectTask}
        onToggleTask={onToggleTask}
        onToggleUrgent={onToggleUrgent}
        onCreateFolder={onCreateFolder}
        onRenameFolder={onRenameFolder}
        onToggleFolderCollapse={onToggleFolderCollapse}
        onDeleteFolder={onDeleteFolder}
        onSetTaskFolder={onSetTaskFolder}
        onUpdateFolderColor={onUpdateFolderColor}
        onReorderFolders={onReorderFolders}
        onReorderTasks={onReorderTasks}
        folderColors={folderColors}
        ptyStatuses={ptyStatuses}
      />

      {/* Results (completed this week) */}
      <section className="mb-8 mt-8">
        <h2 className="text-[9px] font-semibold text-text-3 uppercase tracking-[0.1em] mb-3 px-1">
          Results <span className="text-text-3/60 font-mono font-normal normal-case">{completedTasks.length}</span>
        </h2>
        {completedTasks.length > 0 ? (
          <div className="space-y-0.5">
            {completedTasks.map(task => (
              <div
                key={task.id}
                className={COMPLETED_ROW_CLASS}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleTask(task.id) }}
                  aria-label="Mark incomplete"
                  className="w-[18px] h-[18px] rounded-full border-[1.5px] flex-shrink-0 flex items-center justify-center cursor-pointer transition-all border-green-1 bg-green-1 hover:bg-green-1/70 hover:border-green-1/70"
                >
                  <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/>
                  </svg>
                </button>
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => onSelectTask(task.id)}
                >
                  <span className="text-[12px] text-text-3 line-through decoration-text-3/30 block truncate">
                    {task.title}
                  </span>
                  {task.company_name && (
                    <span className="text-[10px] text-text-3/60 block truncate mt-0.5">{task.company_name}</span>
                  )}
                </div>
                {task.source === 'crm' && task.source_id && window.__CRM_BASE_URL && (
                  <a
                    href={`${window.__CRM_BASE_URL}/objects/task/records/${task.source_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md text-text-3/50 hover:text-text-2 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    CRM ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 px-4 rounded-2xl border border-black/[0.06] bg-black/[0.02] text-center flex flex-col items-center gap-3">
            <div className="empty-state-icon mb-0">
              <svg className="w-6 h-6 text-text-3/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="text-[11px] font-medium text-text-2">{week === currentIsoWeek() ? 'No completions yet' : 'Nothing completed'}</p>
              <p className="text-[10px] text-text-3/60 mt-0.5">{week === currentIsoWeek() ? 'Completed tasks for this week appear here' : 'No tasks were completed this week'}</p>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
