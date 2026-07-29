import type { DelegateCache, DelegateExecution, DelegateMessage } from '../../shared/types'
import { getDb } from './connection'

// ═══════════════════════════════════════════
//  DELEGATE CACHE
// ═══════════════════════════════════════════

export function getCachedDelegate(taskId: number): DelegateCache | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM delegate_cache WHERE task_id = ?').get(taskId) as DelegateCache | undefined
}

export function saveDelegateCache(
  taskId: number, plan: string, context: string,
  cost: number, turns: number, error: string | null,
  sessionId?: string | null
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO delegate_cache (task_id, plan, context, cost, turns, error, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       plan=excluded.plan, context=excluded.context, cost=excluded.cost,
       turns=excluded.turns, error=excluded.error,
       session_id=COALESCE(excluded.session_id, delegate_cache.session_id),
       created_at=excluded.created_at`
  ).run(taskId, plan, context, cost, turns, error, sessionId ?? null, new Date().toISOString())
}

export function clearDelegateCache(taskId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM delegate_cache WHERE task_id = ?').run(taskId)
}

// ═══════════════════════════════════════════
//  DELEGATE EXECUTIONS
// ═══════════════════════════════════════════

export function createExecution(taskId: number): number {
  const db = getDb()
  const result = db.prepare(
    "INSERT INTO delegate_executions (task_id, status, started_at) VALUES (?, 'running', ?)"
  ).run(taskId, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function updateExecution(execId: number, status: string, output?: string | null, cost = 0): void {
  const db = getDb()
  db.prepare(
    'UPDATE delegate_executions SET status = ?, output = ?, cost = ?, completed_at = ? WHERE id = ?'
  ).run(status, output ?? null, cost, new Date().toISOString(), execId)
}

export function getExecution(execId: number): DelegateExecution | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM delegate_executions WHERE id = ?').get(execId) as DelegateExecution | undefined
}

export function getLatestExecution(taskId: number): DelegateExecution | undefined {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM delegate_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(taskId) as DelegateExecution | undefined
}

// ═══════════════════════════════════════════
//  DELEGATE MESSAGES
// ═══════════════════════════════════════════

export function addDelegateMessage(
  taskId: number, role: string, content: string, cost = 0, turns = 0
): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO delegate_messages (task_id, role, content, cost, turns, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(taskId, role, content, cost, turns, new Date().toISOString())
}

export function getDelegateMessages(taskId: number): DelegateMessage[] {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM delegate_messages WHERE task_id = ? ORDER BY created_at'
  ).all(taskId) as DelegateMessage[]
}

export function clearDelegateMessages(taskId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM delegate_messages WHERE task_id = ?').run(taskId)
}

export function getDelegateMessageCount(taskId: number, role = 'user'): number {
  const db = getDb()
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM delegate_messages WHERE task_id = ? AND role = ?'
  ).get(taskId, role) as { cnt: number } | undefined
  return row?.cnt ?? 0
}
