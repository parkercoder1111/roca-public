import type { Task } from '../../shared/types'
import { ACTIVE_STATUSES, STATUS_LABELS, INBOX_SOURCES } from '../../shared/constants'
import { getDb } from './connection'
import { currentIsoWeek, ensureWeek } from './weeks'
import { activeStatusClause } from './utils'

function weekDateRange(weekStr: string): [string, string] {
  const [yearStr, wkStr] = weekStr.split('-W')
  const year = parseInt(yearStr)
  const wk = parseInt(wkStr)
  const jan4 = new Date(year, 0, 4)
  const startOfW1 = new Date(jan4)
  startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7)) // Monday of ISO W1
  const monday = new Date(startOfW1)
  monday.setDate(startOfW1.getDate() + (wk - 1) * 7)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() - 1) // Sunday before Monday = week start
  const nextSunday = new Date(sunday)
  nextSunday.setDate(sunday.getDate() + 7) // Following Sunday
  return [sunday.toISOString().split('T')[0], nextSunday.toISOString().split('T')[0]]
}

// ═══════════════════════════════════════════
//  TASKS
// ═══════════════════════════════════════════

export function getTasks(
  week?: string, status?: string, source?: string, priority?: string
): Task[] {
  const db = getDb()
  week = week || currentIsoWeek()
  let query = 'SELECT * FROM tasks WHERE week = ? AND merged_into_task_id IS NULL'
  const params: (string | number)[] = [week]

  if (status) {
    query += ' AND status = ?'
    params.push(status)
  }
  if (source) {
    if (source === 'voice_notes') {
      query += " AND source IN ('voice_notes', 'transcript')"
    } else {
      query += ' AND source = ?'
      params.push(source)
    }
  }
  if (priority) {
    query += ' AND priority = ?'
    params.push(priority)
  }
  query += ` ORDER BY CASE status
    WHEN 'needs_input' THEN 0
    WHEN 'draft_ready' THEN 1
    WHEN 'in_progress' THEN 2
    WHEN 'open' THEN 3
    WHEN 'waiting' THEN 4
    WHEN 'blocked' THEN 5
    ELSE 6 END,
    sort_order ASC,
    CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
    due_date`

  return db.prepare(query).all(...params) as Task[]
}

/**
 * Get tasks completed more than `days` days ago (for tmux session cleanup).
 */
export function getCompletedTasksOlderThan(days: number): Task[] {
  const db = getDb()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at < ? AND merged_into_task_id IS NULL"
  ).all(cutoff) as Task[]
}

export function getCompletedInWeek(week?: string): Task[] {
  const db = getDb()
  week = week || currentIsoWeek()
  const [sun, nextSun] = weekDateRange(week)
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'done' AND completed_at >= ? AND completed_at < ? AND merged_into_task_id IS NULL ORDER BY completed_at DESC"
  ).all(sun, nextSun) as Task[]
}

export function createTask(opts: {
  title: string; source?: string; source_id?: string | null; priority?: string;
  due_date?: string | null; company_name?: string | null; deal_name?: string | null;
  notes?: string | null; week?: string; project_id?: string | null;
}): number {
  const db = getDb()
  const week = ensureWeek(opts.week)
  const createdAt = new Date().toISOString()
  const source = opts.source || 'manual'
  const triagedAt = INBOX_SOURCES.has(source) ? null : createdAt

  const maxOrderRow = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM tasks WHERE week = ?'
  ).get(week) as { max_order: number }
  const sortOrder = maxOrderRow.max_order + 1

  const result = db.prepare(
    `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
       company_name, deal_name, notes, week, sort_order, created_at, triaged_at, project_id)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.title, source, opts.source_id ?? null,
    opts.priority || 'medium', opts.due_date ?? null,
    opts.company_name ?? null, opts.deal_name ?? null,
    opts.notes ?? null, week, sortOrder, createdAt, triagedAt,
    opts.project_id ?? null
  )
  return result.lastInsertRowid as number
}

export function toggleTask(taskId: number): Task | null {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  if (!task) return null

  if (ACTIVE_STATUSES.includes(task.status)) {
    db.prepare(
      "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), taskId)
  } else {
    db.prepare(
      "UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?"
    ).run(taskId)
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task
}

export function setTaskInProgress(taskId: number): void {
  const db = getDb()
  db.prepare(
    `UPDATE tasks SET status = 'in_progress', triaged_at = COALESCE(triaged_at, ?)
     WHERE id = ? AND ${activeStatusClause()} AND status != 'in_progress'`
  ).run(new Date().toISOString(), taskId)
}

export function getTaskById(taskId: number): Task | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
}

// Fetch an arbitrary set of tasks by id (cross-week). Drives the "Flow State"
// filter, which surfaces tasks with a live PTY regardless of which week they
// belong to. Tombstoned (merged) rows are dropped; ordering follows the same
// status precedence as getTasks() so the result reads consistently.
export function getTasksByIds(ids: number[]): Task[] {
  if (ids.length === 0) return []
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM tasks WHERE id IN (${placeholders}) AND merged_into_task_id IS NULL
     ORDER BY CASE status
       WHEN 'needs_input' THEN 0 WHEN 'draft_ready' THEN 1 WHEN 'in_progress' THEN 2
       WHEN 'open' THEN 3 WHEN 'waiting' THEN 4 WHEN 'blocked' THEN 5
       WHEN 'done' THEN 6 ELSE 7 END,
     sort_order ASC,
     CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END`
  ).all(...ids) as Task[]
}


export function getTasksByProject(projectId: string): Task[] {
  const db = getDb()
  return db.prepare(
    `SELECT * FROM tasks WHERE project_id = ? AND merged_into_task_id IS NULL
     ORDER BY CASE status
       WHEN 'needs_input' THEN 0 WHEN 'draft_ready' THEN 1 WHEN 'in_progress' THEN 2
       WHEN 'open' THEN 3 WHEN 'waiting' THEN 4 WHEN 'blocked' THEN 5
       WHEN 'done' THEN 6 ELSE 7 END,
     sort_order ASC,
     CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END`
  ).all(projectId) as Task[]
}

export function setTaskProject(taskId: number, projectId: string | null): void {
  const db = getDb()
  db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(projectId, taskId)
}

export function setTaskForkedSessionId(taskId: number, sessionId: string | null): void {
  const db = getDb()
  db.prepare('UPDATE tasks SET forked_session_id = ? WHERE id = ?').run(sessionId, taskId)
}

export function setTaskForkedSourceCwd(taskId: number, cwd: string | null): void {
  const db = getDb()
  db.prepare('UPDATE tasks SET forked_source_cwd = ? WHERE id = ?').run(cwd, taskId)
}

export function reorderTasks(taskIds: number[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?')
  const transaction = db.transaction(() => {
    for (let idx = 0; idx < taskIds.length; idx++) {
      stmt.run(idx, taskIds[idx])
    }
  })
  transaction()
}

export function updateTaskFields(taskId: number, fields: Record<string, unknown>): void {
  // Allowed writable fields for generic mobile/API callers.
  //
  // Equivalence notes vs dedicated helpers:
  //   setTaskFolder()  → UPDATE tasks SET folder_id = ? WHERE id = ?
  //                      Plain UPDATE; no side effects. Equivalent to passing folder_id here.
  //   markTaskTriaged() → UPDATE tasks SET triaged_at = COALESCE(triaged_at, ?) WHERE id = ?
  //                      First-write-wins semantics (COALESCE). This generic path does NOT
  //                      replicate COALESCE — it would overwrite an existing triaged_at if
  //                      called again. Safe in practice: the 'Needs triage' button is gated
  //                      on !task.triaged_at, so callers never pass triaged_at twice.
  //   setTaskProject()  → UPDATE tasks SET project_id = ? WHERE id = ?
  //                      Plain UPDATE; no side effects. Equivalent to passing project_id here.
  //
  // Excluded (system-managed, must not be overwritten via this path):
  //   id, source, source_id, status, week, created_at, completed_at, sort_order
  const db = getDb()
  const allowed = new Set(['title', 'priority', 'company_name', 'deal_name', 'due_date', 'notes', 'scheduled_at', 'folder_id', 'triaged_at', 'project_id'])
  const updates: [string, unknown][] = []
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.has(k) && v !== undefined) {
      updates.push([k, v])
    }
  }
  if (updates.length === 0) return

  const setClause = updates.map(([k]) => `${k} = ?`).join(', ')
  const values = updates.map(([, v]) => v)
  db.prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...values, taskId)
}

export function updateTaskStatus(taskId: number, status: string): boolean {
  const db = getDb()
  if (!(status in STATUS_LABELS)) return false
  if (status === 'done') {
    db.prepare(
      'UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?'
    ).run(status, new Date().toISOString(), taskId)
  } else {
    db.prepare(
      'UPDATE tasks SET status = ?, completed_at = NULL WHERE id = ?'
    ).run(status, taskId)
  }
  return true
}

export function updateTaskNotes(taskId: number, notes: string): void {
  const db = getDb()
  db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(notes, taskId)
}

// ═══════════════════════════════════════════
//  MERGE TASKS
// ═══════════════════════════════════════════

export interface MergeTasksResult {
  ok: boolean
  error?: string
  // When the source had a live tmux session, the caller should rename it to
  // this pty id and the renderer should pre-add a tab on the dest pointing here.
  mergedTabPtyId?: string
  mergedTabTabSuffix?: string
  mergedTabLabel?: string
}

/**
 * Merge `sourceId` into `destId`: combine notes (keeping a "Merged from"
 * separator), move sessions/messages/uploads/scrollback/browser-tabs from
 * source → dest, and delete the source row. Runs in a single transaction.
 *
 * The caller is responsible for renaming the live tmux session (if any) so
 * the dest can pick up the merged Claude conversation as a new tab.
 */
export function mergeTasks(sourceId: number, destId: number): MergeTasksResult {
  if (sourceId === destId) return { ok: false, error: 'Cannot merge a task into itself' }
  const db = getDb()
  const source = getTaskById(sourceId)
  const dest = getTaskById(destId)
  if (!source) return { ok: false, error: 'Source task not found' }
  if (!dest) return { ok: false, error: 'Destination task not found' }

  // tab suffix used both for the new pty id and the dest's new tab id
  const tabSuffix = `merge-${Date.now().toString(36)}`
  const newPtyId = `task-${destId}-${tabSuffix}`
  const oldPtyId = `task-${sourceId}`

  const transaction = db.transaction(() => {
    // 1. Combine notes. Keep dest content first, append source under a header
    //    so each original block stays distinguishable.
    const srcNotes = (source.notes || '').trim()
    if (srcNotes) {
      const destNotes = (dest.notes || '').trim()
      const merged = destNotes
        ? `${destNotes}\n\n---\n## Merged from: ${source.title}\n\n${srcNotes}`
        : `## ${source.title}\n\n${srcNotes}`
      db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(merged, destId)
    }

    // 2. Move task_sessions; prefix summaries so the origin remains visible.
    const sessions = db.prepare(
      'SELECT id, summary FROM task_sessions WHERE task_id = ?'
    ).all(sourceId) as { id: number; summary: string | null }[]
    for (const s of sessions) {
      const prefix = `[from "${source.title}"] `
      const newSummary = s.summary ? prefix + s.summary : prefix.trim()
      db.prepare('UPDATE task_sessions SET task_id = ?, summary = ? WHERE id = ?')
        .run(destId, newSummary, s.id)
    }

    // 3. Move conversational state (no UNIQUE constraints on task_id here)
    db.prepare('UPDATE delegate_messages SET task_id = ? WHERE task_id = ?').run(destId, sourceId)
    db.prepare('UPDATE delegate_executions SET task_id = ? WHERE task_id = ?').run(destId, sourceId)

    // 4. delegate_cache.task_id is UNIQUE — collapse if dest already has one.
    const destCache = db.prepare('SELECT 1 FROM delegate_cache WHERE task_id = ?').get(destId)
    if (destCache) {
      db.prepare('DELETE FROM delegate_cache WHERE task_id = ?').run(sourceId)
    } else {
      db.prepare('UPDATE delegate_cache SET task_id = ? WHERE task_id = ?').run(destId, sourceId)
    }

    // 5. Move uploads (attachments follow their task)
    db.prepare('UPDATE uploads SET task_id = ? WHERE task_id = ?').run(destId, sourceId)

    // 6. Rename pty_scrollback row so the new tab can replay saved output
    //    after an app restart. pty_id is the table's PK, so collisions can't
    //    occur (the new pty id is per-merge unique).
    db.prepare('UPDATE pty_scrollback SET pty_id = ? WHERE pty_id = ?').run(newPtyId, oldPtyId)

    // 7. browser_tabs.task_id is PK. Combine arrays if both sides have tabs;
    //    otherwise migrate the source row to the dest's task_id.
    const sourceBrowser = db.prepare('SELECT tabs_json FROM browser_tabs WHERE task_id = ?')
      .get(sourceId) as { tabs_json: string } | undefined
    const destBrowser = db.prepare('SELECT tabs_json FROM browser_tabs WHERE task_id = ?')
      .get(destId) as { tabs_json: string } | undefined
    if (sourceBrowser && destBrowser) {
      let combined: unknown[] = []
      try {
        const a = JSON.parse(destBrowser.tabs_json || '[]')
        const b = JSON.parse(sourceBrowser.tabs_json || '[]')
        if (Array.isArray(a)) combined = combined.concat(a)
        if (Array.isArray(b)) combined = combined.concat(b)
      } catch { /* malformed json — keep dest's */ }
      if (combined.length > 0) {
        db.prepare('UPDATE browser_tabs SET tabs_json = ? WHERE task_id = ?')
          .run(JSON.stringify(combined), destId)
      }
      db.prepare('DELETE FROM browser_tabs WHERE task_id = ?').run(sourceId)
    } else if (sourceBrowser) {
      db.prepare('UPDATE browser_tabs SET task_id = ? WHERE task_id = ?').run(destId, sourceId)
    }

    // 8. Tombstone the source task: status='done' + merged_into_task_id so
    // it disappears from UI queries (which filter on merged_into_task_id IS
    // NULL) but is still findable by re-sync dedup checks (taskExistsBySource
    // and the per-source doc-dedup helpers) which query by (source, source_id)
    // regardless of status. Hard-deleting here used to leak: meeting/voice-note
    // re-runs found no row for the merged doc and recreated every task that had
    // been pulled into the destination.
    const completedAt = new Date().toISOString()
    const tombstoneNote = `[Merged into #${destId}]\n${(source.notes || '').trim()}`
    db.prepare(
      `UPDATE tasks
         SET status = 'done',
             completed_at = ?,
             merged_into_task_id = ?,
             notes = ?,
             folder_id = NULL,
             scheduled_at = NULL
       WHERE id = ?`
    ).run(completedAt, destId, tombstoneNote, sourceId)
  })

  transaction()

  // Tab label: source title, truncated so it fits the tab strip.
  const rawLabel = source.title || `Task ${sourceId}`
  const tabLabel = rawLabel.length > 18 ? rawLabel.slice(0, 17) + '…' : rawLabel

  return {
    ok: true,
    mergedTabPtyId: newPtyId,
    mergedTabTabSuffix: tabSuffix,
    mergedTabLabel: tabLabel,
  }
}

export function taskExistsBySource(source: string, sourceId: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT id FROM tasks WHERE source = ? AND source_id = ?').get(source, sourceId)
  return !!row
}

export function taskExistsByTitle(title: string, week: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(title, week)
  return !!row
}

// ═══════════════════════════════════════════
//  INBOX
// ═══════════════════════════════════════════

export function markTaskTriaged(taskId: number): void {
  const db = getDb()
  db.prepare(
    'UPDATE tasks SET triaged_at = COALESCE(triaged_at, ?) WHERE id = ?'
  ).run(new Date().toISOString(), taskId)
}

export function getInboxTasks(week?: string): Task[] {
  const db = getDb()
  week = week || currentIsoWeek()
  const sources = [...INBOX_SOURCES].sort()
  const placeholders = sources.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM tasks WHERE week = ? AND source IN (${placeholders})
     AND triaged_at IS NULL AND ${activeStatusClause()}
     ORDER BY created_at DESC, sort_order ASC`
  ).all(week, ...sources) as Task[]
}

export function getInboxCount(week?: string): number {
  const db = getDb()
  week = week || currentIsoWeek()
  const sources = [...INBOX_SOURCES].sort()
  const placeholders = sources.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM tasks WHERE week = ?
     AND source IN (${placeholders})
     AND triaged_at IS NULL AND ${activeStatusClause()}`
  ).get(week, ...sources) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

// ═══════════════════════════════════════════
//  POPULATE TASK FLAGS (bulk queries)
// ═══════════════════════════════════════════

export function populateTaskFlags(tasks: Task[]): Task[] {
  const db = getDb()
  if (tasks.length === 0) return tasks

  const taskIds = tasks.filter(t => t.id != null).map(t => t.id)
  const titles = [...new Set(tasks.filter(t => t.title).map(t => t.title))]

  let cachedIds = new Set<number>()
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT task_id FROM delegate_cache WHERE task_id IN (${placeholders})`
    ).all(...taskIds) as { task_id: number }[]
    cachedIds = new Set(rows.map(r => r.task_id))
  }

  let recurringTitles = new Set<string>()
  if (titles.length > 0) {
    const placeholders = titles.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT title FROM recurring_tasks WHERE title IN (${placeholders})`
    ).all(...titles) as { title: string }[]
    recurringTitles = new Set(rows.map(r => r.title))
  }

  // last_activity_at: MAX over all timestamps the task touches. Seeds the
  // Active/Stale/Old filter. Uses '' as the floor inside MAX() so NULL columns
  // can't poison the result (empty string sorts below any ISO timestamp).
  const activityById = new Map<number, string>()
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT
         t.id,
         MAX(
           t.created_at,
           COALESCE(t.triaged_at, ''),
           COALESCE(t.completed_at, ''),
           COALESCE((SELECT MAX(created_at) FROM delegate_messages WHERE task_id = t.id), ''),
           COALESCE((SELECT MAX(started_at) FROM delegate_executions WHERE task_id = t.id), ''),
           COALESCE((SELECT MAX(COALESCE(ended_at, started_at)) FROM task_sessions WHERE task_id = t.id), ''),
           COALESCE((SELECT updated_at FROM pty_scrollback WHERE pty_id = 'task-' || t.id), '')
         ) AS last_activity_at
       FROM tasks t
       WHERE t.id IN (${placeholders})`
    ).all(...taskIds) as { id: number; last_activity_at: string }[]
    for (const r of rows) activityById.set(r.id, r.last_activity_at)
  }

  for (const task of tasks) {
    task.has_cache = cachedIds.has(task.id)
    task.is_recurring = recurringTitles.has(task.title)
    task.last_activity_at = activityById.get(task.id) || task.created_at
  }

  return tasks
}

// ═══════════════════════════════════════════
//  SCHEDULED TASKS
// ═══════════════════════════════════════════

export function getScheduledDueTasks(): Task[] {
  const db = getDb()
  const now = new Date().toISOString()
  return db.prepare(
    `SELECT * FROM tasks WHERE ${activeStatusClause()} AND scheduled_at IS NOT NULL AND scheduled_at <= ?`
  ).all(now) as Task[]
}

export function clearScheduledAt(taskId: number): void {
  const db = getDb()
  db.prepare('UPDATE tasks SET scheduled_at = NULL WHERE id = ?').run(taskId)
}

// ═══════════════════════════════════════════
//  SOURCE-LEVEL STATUS UPDATE (for sync)
// ═══════════════════════════════════════════

export function updateTaskStatusBySource(source: string, sourceId: string, newStatus: string): void {
  const db = getDb()
  const task = db.prepare(
    'SELECT id, status FROM tasks WHERE source = ? AND source_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(source, sourceId) as { id: number; status: string } | undefined
  if (task && task.status !== newStatus && task.status !== 'carried') {
    if (newStatus === 'done') {
      db.prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?").run(task.id)
    } else {
      db.prepare("UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?").run(task.id)
    }
  }
}
