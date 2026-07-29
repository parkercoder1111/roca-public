import { getDb } from './connection'

// ═══════════════════════════════════════════
//  BROWSER TAB PERSISTENCE
// ═══════════════════════════════════════════

export function saveBrowserTabs(taskId: number, tabs: { url: string; title: string }[], activeIndex: number): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO browser_tabs (task_id, tabs_json, active_index, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(task_id) DO UPDATE SET tabs_json = excluded.tabs_json, active_index = excluded.active_index, updated_at = excluded.updated_at`
  ).run(taskId, JSON.stringify(tabs), activeIndex)
}

export function loadBrowserTabs(taskId: number): { tabs: { url: string; title: string }[]; activeIndex: number } | null {
  const db = getDb()
  const row = db.prepare('SELECT tabs_json, active_index FROM browser_tabs WHERE task_id = ?').get(taskId) as { tabs_json: string; active_index: number } | undefined
  if (!row) return null
  try {
    return { tabs: JSON.parse(row.tabs_json), activeIndex: row.active_index }
  } catch {
    return null
  }
}

export function deleteBrowserTabs(taskId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM browser_tabs WHERE task_id = ?').run(taskId)
}
