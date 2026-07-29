import type { Task, Folder } from '../../shared/types'
import { ACTIVE_STATUSES, FOLDER_COLORS } from '../../shared/constants'
import { getDb } from './connection'
import { currentIsoWeek } from './weeks'
import { getTasks } from './tasks'
import { activeStatusClause } from './utils'

// ═══════════════════════════════════════════
//  FOLDERS
// ═══════════════════════════════════════════

export function getFolders(week?: string, source?: string, priority?: string): Folder[] {
  const db = getDb()
  week = week || currentIsoWeek()
  const foldersRows = db.prepare('SELECT * FROM folders ORDER BY sort_order, created_at').all() as Folder[]

  let query = `SELECT * FROM tasks WHERE week = ? AND folder_id IS NOT NULL AND ${activeStatusClause()}`
  const params: (string | number)[] = [week]

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
  query += ' ORDER BY sort_order, created_at'

  const tasksRows = db.prepare(query).all(...params) as Task[]

  // Group tasks by folder_id
  const tasksByFolder = new Map<number, Task[]>()
  for (const t of tasksRows) {
    if (t.folder_id == null) continue
    if (!tasksByFolder.has(t.folder_id)) tasksByFolder.set(t.folder_id, [])
    tasksByFolder.get(t.folder_id)!.push(t)
  }

  let folders = foldersRows.map(f => ({
    ...f,
    tasks: tasksByFolder.get(f.id) || [],
  }))

  if (source || priority) {
    folders = folders.filter(f => f.tasks!.length > 0)
  }

  return folders
}

export function getOpenUnfoldered(week?: string, source?: string, priority?: string): Task[] {
  const tasks = getTasks(week, undefined, source, priority)
  return tasks.filter(t => ACTIVE_STATUSES.includes(t.status) && !t.folder_id)
}

export function createFolder(name: string, color?: string): number {
  const db = getDb()
  if (!color) {
    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM folders').get() as { cnt: number }
    color = FOLDER_COLORS[countRow.cnt % FOLDER_COLORS.length]
  }
  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM folders').get() as { max_order: number }
  const result = db.prepare(
    'INSERT INTO folders (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)'
  ).run(name, color, maxRow.max_order + 1, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function renameFolder(folderId: number, name: string): void {
  const db = getDb()
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, folderId)
}

export function toggleFolderCollapse(folderId: number): void {
  const db = getDb()
  db.prepare('UPDATE folders SET collapsed = NOT collapsed WHERE id = ?').run(folderId)
}

export function deleteFolder(folderId: number): void {
  const db = getDb()
  db.prepare('UPDATE tasks SET folder_id = NULL WHERE folder_id = ?').run(folderId)
  db.prepare('DELETE FROM folders WHERE id = ?').run(folderId)
}

export function setTaskFolder(taskId: number, folderId?: number | null): void {
  const db = getDb()
  db.prepare('UPDATE tasks SET folder_id = ? WHERE id = ?').run(folderId ?? null, taskId)
}

export function updateFolderColor(folderId: number, color: string): void {
  const db = getDb()
  db.prepare('UPDATE folders SET color = ? WHERE id = ?').run(color, folderId)
}

export function reorderFolders(folderIds: number[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?')
  const transaction = db.transaction(() => {
    for (let idx = 0; idx < folderIds.length; idx++) {
      stmt.run(idx, folderIds[idx])
    }
  })
  transaction()
}
