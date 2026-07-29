import { getDb } from './connection'

// ═══════════════════════════════════════════
//  TASK SESSIONS (conversation history)
// ═══════════════════════════════════════════

export interface TaskSession {
  id: number
  task_id: number
  transcript: string
  summary: string | null
  started_at: string
  ended_at: string | null
}

export function createTaskSession(taskId: number): number {
  const db = getDb()
  const result = db.prepare(
    'INSERT INTO task_sessions (task_id, started_at) VALUES (?, ?)'
  ).run(taskId, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function endTaskSession(sessionId: number, transcript: string): void {
  const db = getDb()
  db.prepare(
    'UPDATE task_sessions SET transcript = ?, ended_at = ? WHERE id = ?'
  ).run(transcript, new Date().toISOString(), sessionId)
}

export function saveSessionSummary(sessionId: number, summary: string): void {
  const db = getDb()
  db.prepare(
    'UPDATE task_sessions SET summary = ? WHERE id = ?'
  ).run(summary, sessionId)
}

export function getTaskSessions(taskId: number, limit = 10): TaskSession[] {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(taskId, limit) as TaskSession[]
}

export function getActiveTaskSession(taskId: number): TaskSession | undefined {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM task_sessions WHERE task_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
  ).get(taskId) as TaskSession | undefined
}
