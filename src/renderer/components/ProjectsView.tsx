import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { GitProject, Task } from '@shared/types'
import { ACTIVE_STATUSES } from '@shared/constants'

interface Props {
  selectedTaskId: number | null
  onSelectTask: (task: Task) => void
  onSelectProject: (projectId: string | null) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export default function ProjectsView({ selectedTaskId, onSelectTask, onSelectProject, collapsed, onToggleCollapse }: Props) {
  const [projects, setProjects] = useState<GitProject[]>([])
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newProjectPath, setNewProjectPath] = useState('')
  const [gitStatuses, setGitStatuses] = useState<Map<string, { branch: string; status: string }>>(new Map())
  const [projectTasks, setProjectTasks] = useState<Map<string, Task[]>>(new Map())
  const projectsRef = useRef<GitProject[]>([])
  const expandedProjectsRef = useRef(expandedProjects)
  expandedProjectsRef.current = expandedProjects

  const loadProjects = useCallback(async () => {
    try {
      const list = await window.electronAPI.projectsList()
      projectsRef.current = list
      setProjects(list)
      // Auto-expand all projects, load statuses and tasks in parallel
      setExpandedProjects(new Set(list.map((p: GitProject) => p.id)))
      const results = await Promise.all(list.map(async (p: GitProject) => {
        const [status, tasks] = await Promise.all([
          window.electronAPI.projectsGitStatus(p.id).catch((e: unknown) => {
            console.error(`[Projects] Git status error for ${p.name}:`, e)
            return null
          }),
          window.electronAPI.projectsGetTasks(p.id).catch((e: unknown) => {
            console.error(`[Projects] Tasks error for ${p.name}:`, e)
            return []
          }),
        ])
        return { p, status, tasks }
      }))
      setGitStatuses(prev => {
        const next = new Map(prev)
        for (const { p, status } of results) {
          if (status) next.set(p.id, { branch: status.branch, status: status.status })
        }
        return next
      })
      setProjectTasks(prev => {
        const next = new Map(prev)
        for (const { p, tasks } of results) next.set(p.id, tasks)
        return next
      })
    } catch (err) {
      console.error('[Projects] Load error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])

  // Reload tasks periodically — reads from ref so interval never resets on projects change
  const reloadProjectTasks = useCallback(async () => {
    for (const p of projectsRef.current) {
      try {
        const tasks = await window.electronAPI.projectsGetTasks(p.id)
        setProjectTasks(prev => {
          const existing = prev.get(p.id)
          if (existing?.length === tasks.length && !existing.some((t, i) => t.id !== tasks[i]?.id || t.status !== tasks[i]?.status || t.title !== tasks[i]?.title)) return prev
          const next = new Map(prev)
          next.set(p.id, tasks)
          return next
        })
      } catch { /* ignore */ }
    }
  }, [])

  // Reload tasks every 5 seconds to catch new tasks from FeedbackModal (only when panel is visible)
  useEffect(() => {
    if (projects.length === 0 || collapsed) return
    let mounted = true
    const interval = setInterval(() => { if (mounted) reloadProjectTasks() }, 5000)
    return () => { mounted = false; clearInterval(interval) }
  }, [projects.length, reloadProjectTasks, collapsed])

  const handleAddProject = useCallback(async () => {
    if (!newProjectPath.trim()) return
    try {
      await window.electronAPI.projectsAdd(newProjectPath.trim())
      setNewProjectPath('')
      setShowAddDialog(false)
      await loadProjects()
    } catch (err) {
      console.error('[Projects] Add error:', err)
    }
  }, [newProjectPath, loadProjects])

  const handleRemoveProject = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    try {
      await window.electronAPI.projectsRemove(id)
      setExpandedProjects(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await loadProjects()
    } catch (err) {
      console.error('[Projects] Remove error:', err)
    }
  }, [loadProjects])

  const toggleExpand = useCallback((id: string) => {
    const isCurrentlyExpanded = expandedProjectsRef.current.has(id)
    setExpandedProjects(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (isCurrentlyExpanded) {
      onSelectProject(null)
    } else {
      onSelectProject(id)
    }
  }, [onSelectProject])

  const handleSelectTask = useCallback((task: Task, projectId: string) => {
    onSelectProject(projectId)
    onSelectTask(task)
  }, [onSelectProject, onSelectTask])

  if (loading) {
    return (
      <div className="flex flex-col h-full view-enter">
        <div className="px-4 py-4 border-b border-black/[0.06]">
          <div className="skeleton h-4 w-32 mb-2" />
          <div className="skeleton h-3 w-48" />
        </div>
        <div className="px-4 py-4 space-y-3">
          <div className="skeleton h-8 w-full rounded-md" />
          <div className="skeleton h-8 w-full rounded-md" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full view-enter">
      {/* Header */}
      <div className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-black/[0.03] transition-colors"
           role="button" tabIndex={0}
           onClick={onToggleCollapse}
           onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleCollapse?.() } }}>
        <div className="flex items-center gap-2">
          <svg
            className={`w-3 h-3 text-text-3 shrink-0 transition-transform ${!collapsed ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <svg className="w-3.5 h-3.5 text-purple-1 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="text-[11px] font-medium text-text-2">Projects</span>
          {projects.length > 0 && (
            <span className="text-[9px] text-text-3 bg-black/[0.06] rounded-full px-1.5 py-0.5">
              {projects.length}
            </span>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowAddDialog(true) }}
            className="p-1 rounded-md hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors"
            title="Add project"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        )}
      </div>

      {/* Add dialog */}
      {showAddDialog && (
        <div className="px-4 py-3 border-b border-black/[0.06] bg-surface-1">
          <p className="text-[10px] text-text-2 mb-2">Add Git Project</p>
          <input
            type="text"
            value={newProjectPath}
            onChange={e => setNewProjectPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddProject()}
            placeholder="/path/to/repo"
            className="w-full bg-black/[0.04] border border-black/[0.06] rounded-xl px-2.5 py-1.5 text-[10px] text-text-2 placeholder-text-3 focus:outline-none focus:border-purple-1/30 mb-2"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={handleAddProject}
              disabled={!newProjectPath.trim()}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium bg-purple-2 text-purple-1 hover:bg-purple-1/20 disabled:opacity-30 transition-all cursor-pointer"
            >
              Add
            </button>
            <button
              onClick={() => { setShowAddDialog(false); setNewProjectPath('') }}
              className="px-2 py-1 rounded-md text-[10px] font-medium text-text-3 hover:bg-black/[0.06] transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Project list with nested tasks */}
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="w-12 h-12 rounded-2xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center mx-auto mb-3">
              <svg className="w-4 h-4 text-text-3/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <p className="text-[11px] font-medium text-text-2 mb-0.5">No projects yet</p>
            <p className="text-[10px] text-text-3/50">Click + to add a git repo</p>
          </div>
        ) : (
          <div className="py-1">
            {projects.map(project => {
              const gs = gitStatuses.get(project.id)
              const tasks = projectTasks.get(project.id) || []
              const isExpanded = expandedProjects.has(project.id)
              const openTasks = tasks.filter(t => ACTIVE_STATUSES.includes(t.status))
              const doneTasks = tasks.filter(t => t.status === 'done')

              return (
                <div key={project.id}>
                  {/* Project header */}
                  <button
                    onClick={() => toggleExpand(project.id)}
                    aria-expanded={isExpanded}
                    aria-controls={`project-tasks-${project.id}`}
                    className="w-full text-left px-3 py-2 transition-colors cursor-pointer hover:bg-black/[0.03] group"
                  >
                    <div className="flex items-center gap-2">
                      <svg
                        className={`w-3 h-3 text-text-3 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <svg className="w-3.5 h-3.5 text-purple-1 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      <span className="text-[11px] font-medium text-text-1 truncate flex-1">{project.name}</span>
                      {openTasks.length > 0 && (
                        <span className="text-[9px] text-text-3 bg-black/[0.06] rounded-full px-1.5 py-0.5 shrink-0">
                          {openTasks.length}
                        </span>
                      )}
                      <button
                        onClick={(e) => handleRemoveProject(e, project.id)}
                        className="p-0.5 rounded hover:bg-red-2 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:!text-red-1 transition-all shrink-0"
                        title="Remove project"
                        aria-label={`Remove project: ${project.name}`}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    {gs && (
                      <div className="mt-0.5 ml-[22px] text-[9px] text-text-3 flex items-center gap-1">
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        {gs.branch}
                      </div>
                    )}
                  </button>

                  {/* Expanded: task list */}
                  {isExpanded && (
                    <div id={`project-tasks-${project.id}`} className="ml-[22px] border-l border-black/[0.06]">
                      {openTasks.length === 0 && doneTasks.length === 0 ? (
                        <div className="px-4 py-3 text-[10px] text-text-3/50">
                          No tasks yet. Use Feature/Bug buttons to add tasks.
                        </div>
                      ) : (
                        <>
                          {/* Open tasks */}
                          {openTasks.map(task => (
                            <TaskRow
                              key={task.id}
                              task={task}
                              isSelected={selectedTaskId === task.id}
                              onClick={() => handleSelectTask(task, project.id)}
                            />
                          ))}
                          {/* Completed tasks */}
                          {doneTasks.length > 0 && (
                            <div className="px-4 py-1.5">
                              <span className="text-[9px] text-text-3/50 uppercase tracking-wider">
                                Done ({doneTasks.length})
                              </span>
                            </div>
                          )}
                          {doneTasks.map(task => (
                            <TaskRow
                              key={task.id}
                              task={task}
                              isSelected={selectedTaskId === task.id}
                              onClick={() => handleSelectTask(task, project.id)}
                              done
                            />
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function TaskRow({ task, isSelected, onClick, done }: {
  task: Task
  isSelected: boolean
  onClick: () => void
  done?: boolean
}) {
  const isBug = task.title.startsWith('[Bug]')
  const isFeature = task.title.startsWith('[Feature]')
  // Strip prefix for display
  const displayTitle = task.title.replace(/^\[(Bug|Feature)\]\s*/, '')

  const priorityDot: Record<string, string> = {
    urgent: 'bg-red-1',
    high: 'bg-red-1/60',
    medium: 'bg-surface-4',
    low: 'bg-surface-4',
  }

  return (
    <button
      onClick={onClick}
      aria-label={`${done ? 'Completed: ' : ''}${task.title}`}
      className={`w-full text-left px-4 py-1.5 transition-colors cursor-pointer flex items-center gap-2 ${
        isSelected
          ? 'bg-purple-2 text-text-1'
          : 'text-text-2 hover:bg-black/[0.03]'
      } ${done ? 'opacity-50' : ''}`}
    >
      {/* Type indicator */}
      {isBug ? (
        <span className="text-[8px] font-bold text-red-1 bg-red-2 rounded px-1 py-0.5 shrink-0">BUG</span>
      ) : isFeature ? (
        <span className="text-[8px] font-bold text-blue-1 bg-blue-2 rounded px-1 py-0.5 shrink-0">FEAT</span>
      ) : (
        <span className="text-[8px] font-bold text-text-3 bg-black/[0.04] rounded px-1 py-0.5 shrink-0">TASK</span>
      )}
      <span className={`text-[10px] truncate flex-1 ${done ? 'line-through' : ''}`}>
        {displayTitle}
      </span>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${priorityDot[task.priority] || 'bg-surface-4'}`} />
    </button>
  )
}
