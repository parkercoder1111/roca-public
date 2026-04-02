import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { Task, Upload } from '@shared/types'
import TaskDetail from './TaskDetail'
import TaskTerminal from './TaskTerminal'
import TaskBrowser from './TaskBrowser'
import FileSidebar from './FileSidebar'

interface PopoutProps {
  taskId: number
  tab: 'notes' | 'terminal' | 'browser'
}

export default function PopoutPanel({ taskId, tab }: PopoutProps) {
  const [task, setTask] = useState<Task | null>(null)
  const [taskLoaded, setTaskLoaded] = useState(false)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [filesSidebarOpen, setFilesSidebarOpen] = useState(false)

  // Load task from DB
  const loadTask = useCallback(async () => {
    try {
      const t = await window.electronAPI.getTask(taskId)
      setTask(t ? (t as Task) : null)
    } catch {
      setTask(null)
    } finally {
      setTaskLoaded(true)
    }
  }, [taskId])

  useEffect(() => { loadTask() }, [loadTask])

  const refreshUploads = useCallback(async () => {
    try {
      const list = await window.electronAPI.getUploadsForTask(taskId)
      setUploads(list || [])
    } catch { setUploads([]) }
  }, [taskId])

  useEffect(() => { refreshUploads() }, [refreshUploads])

  const handleToggleRecurring = useCallback(async (tid: number, isRecurring: boolean) => {
    if (isRecurring) await window.electronAPI.unmakeRecurring(tid)
    else await window.electronAPI.makeRecurring(tid)
    loadTask()
  }, [loadTask])

  const handleComplete = useCallback(async (tid: number) => {
    await window.electronAPI.toggleTask(tid)
    loadTask()
  }, [loadTask])

  const handleStatusChange = useCallback(async (tid: number, status: string) => {
    await window.electronAPI.updateTaskStatus(tid, status)
    loadTask()
  }, [loadTask])

  const handlePriorityChange = useCallback(async (tid: number, priority: string) => {
    await window.electronAPI.updateTaskFields(tid, { priority })
    loadTask()
  }, [loadTask])

  const handleTitleChange = useCallback(async (tid: number, title: string) => {
    await window.electronAPI.updateTaskFields(tid, { title })
    loadTask()
  }, [loadTask])

  if (!taskLoaded) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-surface-0 gap-3">
        <div className="w-8 h-8 rounded-xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center">
          <svg className="w-4 h-4 text-text-3/40 animate-spin-smooth" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
        <span className="text-[10px] text-text-3/60">Loading task</span>
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-surface-0 gap-3">
        <div className="w-8 h-8 rounded-xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center">
          <svg className="w-3.5 h-3.5 text-text-3/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <span className="text-[11px] font-medium text-text-2">Task not found</span>
        <span className="text-[10px] text-text-3/60">This task may have been deleted</span>
      </div>
    )
  }

  const tabLabel = tab === 'notes' ? 'Notes' : tab === 'terminal' ? 'Terminal' : 'Browser'

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-text-1">
      {/* Titlebar drag region + tab info */}
      <div className="shrink-0 flex items-center gap-2 px-20 py-2 bg-surface-0 border-b border-black/[0.06]"
           style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <span className="text-[10px] font-medium text-text-3 uppercase tracking-wide">{tabLabel}</span>
        <span className="text-[10px] text-text-3">—</span>
        <span className="text-[11px] font-medium text-text-2 truncate">{task.title}</span>
        <div className="flex-1" />
        {tab === 'notes' && (
          <button
            onClick={() => setFilesSidebarOpen(!filesSidebarOpen)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
              filesSidebarOpen ? 'bg-black/[0.08] text-text-1' : 'text-text-3 hover:text-text-2 hover:bg-black/[0.04]'
            }`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            aria-label={filesSidebarOpen ? 'Close files sidebar' : 'Open files sidebar'}
            title="Toggle files sidebar"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            {uploads.length > 0 && (
              <span className="bg-black/[0.1] text-text-2 px-1.5 py-0 rounded-full text-[9px] leading-[16px]">
                {uploads.length}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-hidden">
          {tab === 'notes' && (
            <div className="h-full overflow-y-auto">
              <TaskDetail
                task={task}
                onNotesChange={loadTask}
                onToggleRecurring={handleToggleRecurring}
                onComplete={handleComplete}
                onStatusChange={handleStatusChange}
                onPriorityChange={handlePriorityChange}
                onTitleChange={handleTitleChange}
                onUploadsChanged={refreshUploads}
              />
            </div>
          )}

          {tab === 'terminal' && (
            <div className="h-full flex flex-col">
              <TaskTerminal
                task={task}
                onNotesChange={loadTask}
                isActive={true}
              />
            </div>
          )}

          {tab === 'browser' && (
            <div className="h-full flex flex-col">
              <TaskBrowser
                task={task}
                isActive={true}
              />
            </div>
          )}
        </div>

        {filesSidebarOpen && tab === 'notes' && (
          <FileSidebar
            taskId={task.id}
            uploads={uploads}
            onUploadAdded={refreshUploads}
            onClose={() => setFilesSidebarOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
