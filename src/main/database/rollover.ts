import type { Task } from '../../shared/types'
import { getDb } from './connection'
import { currentIsoWeek, ensureWeek } from './weeks'
import { activeStatusClause } from './utils'

// ═══════════════════════════════════════════
//  ROLLOVER
// ═══════════════════════════════════════════

export interface RolloverResult {
  count: number
  mappings: Array<{ oldId: number; newId: number }>
}

export function rolloverWeek(fromWeek: string, toWeek: string): RolloverResult {
  const db = getDb()
  ensureWeek(toWeek)
  const incomplete = db.prepare(
    `SELECT * FROM tasks WHERE week = ? AND ${activeStatusClause()}`
  ).all(fromWeek) as Task[]
  const mappings: Array<{ oldId: number; newId: number }> = []
  for (const task of incomplete) {
    const existing = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(task.title, toWeek)
    if (existing) continue
    const result = db.prepare(
      `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
         company_name, deal_name, notes, week, created_at, folder_id)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    ).run(task.title, task.source, task.source_id, task.priority,
      task.due_date, task.company_name, task.deal_name, task.notes,
      toWeek, new Date().toISOString(), task.folder_id ?? null)
    db.prepare("UPDATE tasks SET status = 'carried' WHERE id = ?").run(task.id)
    mappings.push({ oldId: task.id, newId: result.lastInsertRowid as number })
  }
  return { count: mappings.length, mappings }
}

/** Roll over incomplete tasks from ALL prior weeks into the current week. */
export function rolloverAllPriorWeeks(): RolloverResult {
  const db = getDb()
  const toWeek = currentIsoWeek()
  ensureWeek(toWeek)
  const incomplete = db.prepare(
    `SELECT * FROM tasks WHERE week < ? AND ${activeStatusClause()} AND status != 'carried'`
  ).all(toWeek) as Task[]
  const mappings: Array<{ oldId: number; newId: number }> = []
  for (const task of incomplete) {
    const existing = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(task.title, toWeek)
    if (existing) continue
    const result = db.prepare(
      `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
         company_name, deal_name, notes, week, created_at, folder_id)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    ).run(task.title, task.source, task.source_id, task.priority,
      task.due_date, task.company_name, task.deal_name, task.notes,
      toWeek, new Date().toISOString(), task.folder_id ?? null)
    db.prepare("UPDATE tasks SET status = 'carried' WHERE id = ?").run(task.id)
    mappings.push({ oldId: task.id, newId: result.lastInsertRowid as number })
  }
  return { count: mappings.length, mappings }
}

/** One-time repair: restore folder_id on rolled-over tasks that lost it. */
export function repairRolloverFolders(): number {
  const db = getDb()
  // Find tasks marked 'carried' that had a folder_id — their rolled-over copies
  // (matched by title) in later weeks are missing folder_id.
  const carried = db.prepare(
    `SELECT title, folder_id, week FROM tasks WHERE status = 'carried' AND folder_id IS NOT NULL`
  ).all() as { title: string; folder_id: number; week: string }[]
  let fixed = 0
  for (const src of carried) {
    const result = db.prepare(
      `UPDATE tasks SET folder_id = ? WHERE title = ? AND week > ? AND folder_id IS NULL AND ${activeStatusClause()}`
    ).run(src.folder_id, src.title, src.week)
    fixed += result.changes
  }
  return fixed
}
