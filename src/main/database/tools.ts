import type { Tool } from '../../shared/types'
import { getDb } from './connection'

// ═══════════════════════════════════════════
//  TOOLS / INTEGRATIONS
// ═══════════════════════════════════════════

export function getTools(): Tool[] {
  const db = getDb()
  return db.prepare('SELECT * FROM tools ORDER BY is_builtin DESC, name ASC').all() as Tool[]
}

export function getToolById(toolId: number): Tool | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId) as Tool | undefined
}

export function createTool(tool: {
  name: string
  description?: string
  category?: string
  connection_type?: string
  status?: string
  config?: string
  icon?: string
  capabilities?: string
  account?: string
  details?: string
  is_builtin?: number
}): Tool {
  const db = getDb()
  const now = new Date().toISOString()
  const result = db.prepare(
    `INSERT INTO tools (name, description, category, connection_type, status, config, icon, capabilities, account, details, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tool.name,
    tool.description || '',
    tool.category || 'Custom',
    tool.connection_type || 'MCP',
    tool.status || 'disconnected',
    tool.config || null,
    tool.icon || null,
    tool.capabilities || null,
    tool.account || null,
    tool.details || null,
    tool.is_builtin || 0,
    now,
    now,
  )
  return getToolById(result.lastInsertRowid as number)!
}

export function updateTool(toolId: number, fields: Record<string, unknown>): void {
  const db = getDb()
  const allowed = new Set(['name', 'description', 'category', 'connection_type', 'status', 'config', 'icon', 'capabilities', 'account', 'details'])
  const updates: [string, unknown][] = []
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.has(k) && v !== undefined) {
      updates.push([k, v])
    }
  }
  if (updates.length === 0) return
  updates.push(['updated_at', new Date().toISOString()])

  const setClause = updates.map(([k]) => `${k} = ?`).join(', ')
  const values = updates.map(([, v]) => v)
  db.prepare(`UPDATE tools SET ${setClause} WHERE id = ?`).run(...values, toolId)
}

export function deleteTool(toolId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM tools WHERE id = ? AND is_builtin = 0').run(toolId)
}
