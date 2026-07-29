import { getDb } from './connection'

// ═══════════════════════════════════════════
//  PTY SCROLLBACK PERSISTENCE
// ═══════════════════════════════════════════

export function savePtyScrollback(ptyId: string, scrollback: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO pty_scrollback (pty_id, scrollback, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(pty_id) DO UPDATE SET scrollback = excluded.scrollback, updated_at = excluded.updated_at`
  ).run(ptyId, scrollback)
}

export function loadPtyScrollback(ptyId: string): string {
  const db = getDb()
  const row = db.prepare('SELECT scrollback FROM pty_scrollback WHERE pty_id = ?').get(ptyId) as { scrollback: string } | undefined
  return row?.scrollback || ''
}

export function deletePtyScrollback(ptyId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM pty_scrollback WHERE pty_id = ?').run(ptyId)
}

export function renamePtyScrollback(oldPtyId: string, newPtyId: string): void {
  const db = getDb()
  db.prepare('UPDATE pty_scrollback SET pty_id = ? WHERE pty_id = ?').run(newPtyId, oldPtyId)
}

export function savePtyScrollbackBatch(entries: Array<{ ptyId: string; scrollback: string }>): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO pty_scrollback (pty_id, scrollback, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(pty_id) DO UPDATE SET scrollback = excluded.scrollback, updated_at = excluded.updated_at`
  )
  const tx = db.transaction(() => {
    for (const { ptyId, scrollback } of entries) {
      stmt.run(ptyId, scrollback)
    }
  })
  tx()
}
