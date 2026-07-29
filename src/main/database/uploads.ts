import type { Upload } from '../../shared/types'
import { getDb } from './connection'

// ═══════════════════════════════════════════
//  UPLOADS
// ═══════════════════════════════════════════

export function saveUpload(
  taskId: number, filename: string, storedName: string,
  mimeType: string, size: number, messageId?: number | null
): number {
  const db = getDb()
  const result = db.prepare(
    `INSERT INTO uploads (task_id, message_id, filename, stored_name, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(taskId, messageId ?? null, filename, storedName, mimeType, size, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function getUploadsForTask(taskId: number): Upload[] {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM uploads WHERE task_id = ? ORDER BY created_at'
  ).all(taskId) as Upload[]
}

export function getUploadsForMessage(messageId: number): Upload[] {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM uploads WHERE message_id = ? ORDER BY created_at'
  ).all(messageId) as Upload[]
}

export function getPendingUploads(taskId: number): Upload[] {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM uploads WHERE task_id = ? AND message_id IS NULL ORDER BY created_at'
  ).all(taskId) as Upload[]
}

export function linkUploadsToMessage(taskId: number, messageId: number): void {
  const db = getDb()
  db.prepare(
    'UPDATE uploads SET message_id = ? WHERE task_id = ? AND message_id IS NULL'
  ).run(messageId, taskId)
}

export function deleteUpload(id: number): { stored_name: string; task_id: number } | null {
  const db = getDb()
  const row = db.prepare('SELECT stored_name, task_id FROM uploads WHERE id = ?').get(id) as { stored_name: string; task_id: number } | undefined
  if (!row) return null
  db.prepare('DELETE FROM uploads WHERE id = ?').run(id)
  return row
}
