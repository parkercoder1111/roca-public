import type { Task, RecurringTask } from '../../shared/types'
import { getDb } from './connection'
import { currentIsoWeek, ensureWeek } from './weeks'

// ═══════════════════════════════════════════
//  RECURRING TASKS
// ═══════════════════════════════════════════

export function getRecurringTasks(): RecurringTask[] {
  const db = getDb()
  return db.prepare('SELECT * FROM recurring_tasks ORDER BY created_at').all() as RecurringTask[]
}

export function addRecurringTask(
  title: string, priority = 'medium',
  company_name?: string | null, deal_name?: string | null, notes?: string | null
): number {
  const db = getDb()
  const result = db.prepare(
    'INSERT INTO recurring_tasks (title, priority, company_name, deal_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, priority, company_name ?? null, deal_name ?? null, notes ?? null, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function removeRecurringTask(recurringId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM recurring_tasks WHERE id = ?').run(recurringId)
}

export function makeTaskRecurring(taskId: number): number | null {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  if (!task) return null
  const existing = db.prepare('SELECT id FROM recurring_tasks WHERE title = ?').get(task.title) as { id: number } | undefined
  if (existing) return existing.id
  const result = db.prepare(
    'INSERT INTO recurring_tasks (title, priority, company_name, deal_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(task.title, task.priority, task.company_name, task.deal_name, task.notes, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function unmakeTaskRecurring(taskId: number): void {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  if (task) {
    db.prepare('DELETE FROM recurring_tasks WHERE title = ?').run(task.title)
  }
}

export function isTaskRecurring(title: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT id FROM recurring_tasks WHERE title = ?').get(title)
  return !!row
}

export function spawnRecurringForWeek(week?: string): number {
  const db = getDb()
  week = ensureWeek(week || currentIsoWeek())
  const templates = db.prepare('SELECT * FROM recurring_tasks').all() as RecurringTask[]
  let count = 0
  for (const t of templates) {
    const existing = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(t.title, week)
    if (!existing) {
      db.prepare(
        `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
           company_name, deal_name, notes, week, created_at)
           VALUES (?, 'recurring', ?, ?, 'open', NULL, ?, ?, ?, ?, ?)`
      ).run(t.title, String(t.id), t.priority, t.company_name, t.deal_name, t.notes, week, new Date().toISOString())
      count++
    }
  }
  return count
}
