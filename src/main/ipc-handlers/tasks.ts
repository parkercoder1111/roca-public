import { ipcMain } from 'electron'
import {
  getTasks,
  getCompletedInWeek,
  createTask,
  toggleTask,
  getTaskById,
  getTasksByIds,
  updateTaskNotes,
  updateTaskFields,
  updateTaskStatus,
  reorderTasks,
  setTaskInProgress,
  getInboxTasks,
  getInboxCount,
  markTaskTriaged,
  populateTaskFlags,
  getDb,
  currentIsoWeek,
  getScheduledDueTasks,
  clearScheduledAt,
  getOpenUnfoldered,
  setTaskFolder,
  setTaskForkedSessionId,
  setTaskForkedSourceCwd,
  getDelegateMessages,
  addDelegateMessage,
  createTaskSession,
  endTaskSession,
  saveSessionSummary,
  getTaskSessions,
  mergeTasks,
} from '../database'
import { pushTaskToCrm, pushTaskToGoogleTasks } from '../sync'
import { learnFromFeedback } from '../delegate'
import { generateSessionSummary } from '../helpers/generate-session-summary'
import { forkClaudeSession } from '../helpers/fork-claude-session'
import type { IpcDeps } from './types'

export function registerTasksHandlers(deps: IpcDeps): void {
  const { ptyManager } = deps

  // ── Tasks ──
  ipcMain.handle('db:tasks:list', (_, opts?: {
    week?: string; status?: string; source?: string; priority?: string
  }) => {
    return getTasks(opts?.week, opts?.status, opts?.source, opts?.priority)
  })

  ipcMain.handle('db:tasks:get', (_, taskId: number) => getTaskById(taskId))

  // Used by the WeeklyView "Flow State" filter to surface tasks with live PTYs
  // regardless of which week they were created in. Renderer derives the id set
  // from ptyStatuses and asks for the rows in one round-trip.
  ipcMain.handle('db:tasks:by-ids', (_, ids: number[]) => {
    const tasks = getTasksByIds(ids)
    return populateTaskFlags(tasks)
  })

  ipcMain.handle('db:tasks:create', (_, task: {
    title: string; source?: string; source_id?: string;
    priority?: string; due_date?: string;
    company_name?: string; deal_name?: string;
    notes?: string; week?: string; project_id?: string | null;
  }) => {
    const id = createTask(task)
    return { id }
  })

  // Fork: clone the source's live Claude conversation as a new session JSONL,
  // so the forked task can resume from the same context but diverge independently.
  // The new task auto-launches `claude --resume <new-uuid>` on first terminal open.
  ipcMain.handle('db:tasks:fork', (_, sourceTaskId: number) => {
    const source = getTaskById(sourceTaskId)
    if (!source) return { id: null }

    const newId = createTask({
      title: source.title,
      source: 'manual',
      source_id: null,
      notes: source.notes,
      priority: source.priority,
      company_name: source.company_name,
      deal_name: source.deal_name,
      due_date: source.due_date,
      week: currentIsoWeek(),
      project_id: source.project_id,
    })

    if (source.folder_id) setTaskFolder(newId, source.folder_id)

    // Resolve the source pane's Claude session. Deducing from the pane's live Claude
    // process (PID → start time → matching JSONL birthtime) is reliable even when many
    // Claude sessions share the same cwd. Fall back to "most recently modified JSONL"
    // only if deduction failed (e.g. Claude exited or no tmux).
    const sourcePtyId = `task-${sourceTaskId}`
    const sourceCwd = ptyManager.getClaudeCwd(sourcePtyId) || ptyManager.getPaneCwd(sourcePtyId)
    if (sourceCwd) {
      let sourceSessionId: string | null = ptyManager.getClaudeSessionId(sourcePtyId)
      if (sourceSessionId) {
        console.log(`[fork] Live-probed Claude session for task ${sourceTaskId}: ${sourceSessionId}`)
      } else if ((sourceSessionId = ptyManager.getTrackedClaudeSessionId(sourcePtyId))) {
        console.log(`[fork] Using cached (revive-tracked) session for task ${sourceTaskId}: ${sourceSessionId}`)
      } else if ((sourceSessionId = forkClaudeSession(sourceCwd))) {
        console.log(`[fork] Fallback (lone JSONL in cwd) for task ${sourceTaskId}: ${sourceSessionId}`)
      }
      if (sourceSessionId) {
        setTaskForkedSessionId(newId, sourceSessionId)
        // Persist cwd so the new task's PTY opens here — `claude --resume` only
        // searches the current cwd's project dir for the JSONL.
        setTaskForkedSourceCwd(newId, sourceCwd)
      } else {
        console.warn(`[fork] Could not find source session JSONL in ${sourceCwd} — new task will start fresh`)
      }
    } else {
      console.warn(`[fork] Source task ${sourceTaskId} has no live tmux pane — cannot locate its session JSONL; new task will start fresh`)
    }

    // Copy conversation context so the forked task's notes/history match the source.
    for (const s of getTaskSessions(sourceTaskId, 10)) {
      if (s.summary) {
        const sid = createTaskSession(newId)
        endTaskSession(sid, s.transcript)
        saveSessionSummary(sid, s.summary)
      }
    }
    for (const m of getDelegateMessages(sourceTaskId)) {
      addDelegateMessage(newId, m.role, m.content, m.cost || 0, m.turns || 0)
    }

    return { id: newId }
  })

  // Mirror candidates: every live ROCA tmux session — main task tabs,
  // sub-tabs, and assistant tabs alike. Sourced straight from `tmux ls`,
  // so it survives ROCA restarts as long as the source's tmux is up. The
  // renderer pairs these with tab labels from its own localStorage to
  // render the picker.
  ipcMain.handle('db:tasks:list-mirror-candidates', () => {
    const livePtyIds = ptyManager.getLivePtyIds()
    if (livePtyIds.length === 0) return []
    const candidates: Array<{
      ptyId: string
      taskId: number | null
      isAssistant: boolean
      tabSuffix: string | null
      task?: ReturnType<typeof getTaskById>
    }> = []
    for (const ptyId of livePtyIds) {
      const asst = ptyId.match(/^task-assistant(?:-(.+))?$/)
      if (asst) {
        candidates.push({ ptyId, taskId: null, isAssistant: true, tabSuffix: asst[1] ?? null })
        continue
      }
      const task = ptyId.match(/^task-(\d+)(?:-(.+))?$/)
      if (task) {
        const tid = Number(task[1])
        const record = getTaskById(tid)
        if (record) {
          candidates.push({
            ptyId,
            taskId: tid,
            isAssistant: false,
            tabSuffix: task[2] ?? null,
            task: record,
          })
        }
      }
    }
    return candidates
  })

  // Fork-into-tab: locate any live Claude session by its PTY id and return
  // the metadata a new sibling tab needs to `claude --resume <id>
  // --fork-session` from it. Works for tasks and the assistant alike.
  ipcMain.handle('db:sessions:fork-by-pty', (_, sourcePtyId: string) => {
    // A VM-routed pane runs Claude on the server (the foreground process is a
    // mosh/ssh client), so there's no local session to clone. Forking its local
    // cwd would spin up a *different* conversation — the same "optical shows
    // different text" trap the mirror path guards against. Refuse cleanly and
    // point at Mirror, which does work for remote panes (two views, one tmux).
    if (ptyManager.isPaneRemote(sourcePtyId)) {
      return { ok: false, error: 'This session runs on the server — fork isn\'t available for remote panes. Use Mirror for a second live view.' }
    }

    const cwd = ptyManager.getClaudeCwd(sourcePtyId) || ptyManager.getPaneCwd(sourcePtyId)
    if (!cwd) return { ok: false, error: 'No live session for that pane.' }

    const sessionId =
      ptyManager.getClaudeSessionId(sourcePtyId) ||
      ptyManager.getTrackedClaudeSessionId(sourcePtyId) ||
      forkClaudeSession(cwd)
    if (!sessionId) {
      return { ok: false, error: 'No Claude session JSONL found in the source\'s cwd.' }
    }

    return { ok: true, sessionId, cwd }
  })

  // Legacy task-id-keyed fork — kept so the picker (which yields task ids)
  // doesn't have to round-trip through pty ids. Internally delegates.
  ipcMain.handle('db:tasks:fork-session', (_, sourceTaskId: number) => {
    const source = getTaskById(sourceTaskId)
    if (!source) return { ok: false, error: 'Task not found' }

    const sourcePtyId = `task-${sourceTaskId}`
    const sourceCwd =
      ptyManager.getClaudeCwd(sourcePtyId) ||
      ptyManager.getPaneCwd(sourcePtyId) ||
      source.forked_source_cwd
    if (!sourceCwd) {
      return { ok: false, error: 'Open the task once before forking — no recorded cwd.' }
    }

    let sourceSessionId: string | null =
      ptyManager.getClaudeSessionId(sourcePtyId) ||
      ptyManager.getTrackedClaudeSessionId(sourcePtyId)
    if (!sourceSessionId) sourceSessionId = forkClaudeSession(sourceCwd)
    if (!sourceSessionId) {
      return { ok: false, error: 'No Claude session found for this task yet.' }
    }

    return {
      ok: true,
      sessionId: sourceSessionId,
      cwd: sourceCwd,
      sourceTitle: source.title,
      sourceTaskId,
    }
  })

  // Mirror by pty id: confirms the tmux session for `ptyId` is alive so a
  // new tab can attach to it — same Claude process, two xterm views. Works
  // for any pty (main task tab, sub-tab, or assistant tab); the renderer
  // owns the human label, so we only echo the validated ptyId back.
  ipcMain.handle('db:tasks:mirror-by-pty', (_, ptyId: string) => {
    const live = new Set(ptyManager.getLivePtyIds())
    if (!live.has(ptyId)) {
      return { ok: false, error: 'Tab has no live session — open it in a terminal first.' }
    }
    return { ok: true, ptyId }
  })

  // Merge: drag one task onto another to combine them. Combines notes, moves
  // sessions/uploads/scrollback, and — if the source had a live tmux session —
  // renames it so the dest picks it up as a new terminal tab.
  ipcMain.handle('db:tasks:merge', (_, sourceTaskId: number, destTaskId: number) => {
    const result = mergeTasks(sourceTaskId, destTaskId)
    if (!result.ok || !result.mergedTabPtyId) return result

    // Kill the source's in-process PTY proc (its tmux session, if any, will be
    // renamed below so the dest's new tab can attach to it).
    const sourcePtyId = `task-${sourceTaskId}`
    ptyManager.kill(sourcePtyId)

    // Try to rename the live tmux session so the new tab on `destTaskId` can
    // reattach to it. If the source had no live tmux, the new tab will just
    // start fresh — still useful, since the renderer pre-adds the tab.
    const renamed = ptyManager.renameTmuxSession(sourcePtyId, result.mergedTabPtyId)
    return { ...result, tmuxRenamed: renamed }
  })

  ipcMain.handle('db:tasks:toggle', async (_, taskId: number) => {
    const task = toggleTask(taskId)
    if (task) {
      if (task.source === 'crm' && task.source_id) {
        pushTaskToCrm(task.source_id, task.status).catch(console.error)
      } else if (task.source === 'google_tasks' && task.source_id) {
        pushTaskToGoogleTasks(task.source_id, task.status).catch(console.error)
      }
      // Learn from completed tasks (background — don't block toggle)
      if (task.status === 'done') {
        const ptyId = `task-${taskId}`

        const msgs = getDelegateMessages(taskId)

        // Capture rendered terminal text (via tmux capture-pane) before killing
        let terminalText = ''
        if (ptyManager.has(ptyId)) {
          terminalText = ptyManager.captureRenderedText(ptyId)
        }

        // Generate a clean AI summary in the background (replaces raw scrollback)
        if (terminalText.length > 100) {
          const capturedTaskId = taskId
          generateSessionSummary(terminalText, task.title).then(summary => {
            if (summary) {
              const timestamp = new Date().toLocaleString()
              const summaryNote = `\n\n---\n**Completed ${timestamp}**\n${summary}`
              const freshTask = getTaskById(capturedTaskId)
              updateTaskNotes(capturedTaskId, (freshTask?.notes || '') + summaryNote)
            }
          }).catch(e => {
            console.error('[task-complete] Summary generation failed:', e)
          })
        }

        // Don't kill tmux immediately — keep for 1 day so the user can revisit.
        // Periodic sweep (cleanupStaleTmuxSessions) handles cleanup.

        if (msgs && msgs.length > 0) {
          learnFromFeedback('Task completed', task.title, msgs).catch(e =>
            console.error('[learn] Background learning failed:', e)
          )
        }
      }
    }
    return task
  })

  ipcMain.handle('db:tasks:update-notes', (_, taskId: number, notes: string) => {
    updateTaskNotes(taskId, notes)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:update-fields', (_, taskId: number, fields: Record<string, unknown>) => {
    updateTaskFields(taskId, fields)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:update-status', (_, taskId: number, status: string) => {
    const ok = updateTaskStatus(taskId, status)
    if (ok) {
      markTaskTriaged(taskId)
      // Notify on notable status transitions (no-op currently)
      // Learn from completed tasks + capture completion notes
      if (status === 'done') {
        const ptyId = `task-${taskId}`

        const msgs = getDelegateMessages(taskId)

        // Capture rendered terminal text (via tmux capture-pane) before killing
        let terminalText = ''
        if (ptyManager.has(ptyId)) {
          terminalText = ptyManager.captureRenderedText(ptyId)
        }

        // Generate a clean AI summary in the background (replaces raw scrollback)
        if (terminalText.length > 100) {
          const doneTask = getTaskById(taskId)
          if (doneTask) {
            const capturedTaskId = taskId
            generateSessionSummary(terminalText, doneTask.title).then(summary => {
              if (summary) {
                const timestamp = new Date().toLocaleString()
                const summaryNote = `\n\n---\n**Completed ${timestamp}**\n${summary}`
                const freshTask = getTaskById(capturedTaskId)
                updateTaskNotes(capturedTaskId, (freshTask?.notes || '') + summaryNote)
              }
            }).catch(e => {
              console.error('[task-complete] Summary generation failed:', e)
            })
          }
        }

        // Don't kill tmux immediately — keep for 1 day so the user can revisit.
        // Periodic sweep (cleanupStaleTmuxSessions) handles cleanup.

        if (msgs && msgs.length > 0) {
          const doneTask = getTaskById(taskId)
          if (doneTask) {
            learnFromFeedback('Task completed', doneTask.title, msgs).catch(e =>
              console.error('[learn] Background learning failed:', e)
            )
          }
        }
      }
    }
    return { ok }
  })

  ipcMain.handle('db:tasks:reorder', (_, taskIds: number[]) => {
    reorderTasks(taskIds)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:toggle-urgent', (_, taskId: number) => {
    const task = getTaskById(taskId)
    if (!task) return { ok: false }
    const newPriority = task.priority === 'urgent' ? 'medium' : 'urgent'
    updateTaskFields(taskId, { priority: newPriority })
    return { ok: true, priority: newPriority }
  })

  ipcMain.handle('db:tasks:set-in-progress', (_, taskId: number) => {
    setTaskInProgress(taskId)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:schedule', (_, taskId: number, scheduledAt: string | null) => {
    if (scheduledAt) {
      updateTaskFields(taskId, { scheduled_at: scheduledAt })
    } else {
      const db = getDb()
      db.prepare('UPDATE tasks SET scheduled_at = NULL WHERE id = ?').run(taskId)
    }
    return getTaskById(taskId)
  })

  // ── Completed in week ──
  ipcMain.handle('db:completed-in-week', (_, week?: string) => getCompletedInWeek(week))

  // ── Task flags ──
  ipcMain.handle('db:tasks:populate-flags', (_, tasks: any[]) => populateTaskFlags(tasks))
  ipcMain.handle('db:tasks:open-unfoldered', (_, opts?: { week?: string; source?: string; priority?: string }) => {
    const tasks = getOpenUnfoldered(opts?.week, opts?.source, opts?.priority)
    return populateTaskFlags(tasks)
  })

  // ── Inbox ──
  ipcMain.handle('db:inbox:list', (_, week?: string) => getInboxTasks(week))
  ipcMain.handle('db:inbox:count', (_, week?: string) => getInboxCount(week))
  ipcMain.handle('db:inbox:triage', (_, taskId: number) => {
    markTaskTriaged(taskId)
    return { ok: true }
  })

  // ── Scheduled tasks ──
  ipcMain.handle('db:scheduled:due', () => getScheduledDueTasks())
  ipcMain.handle('db:scheduled:clear', (_, taskId: number) => {
    clearScheduledAt(taskId)
    return { ok: true }
  })
}

