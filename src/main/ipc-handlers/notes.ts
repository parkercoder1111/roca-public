import { ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Notes are stored as plain markdown on disk under ~/Movies/ClaudeCode/roca, so
// agents can still read them. Each note is a file `notebooks/<id>.md`; an index
// (notes-index.json) holds the metadata the sidebar needs — title, scope,
// period, preview, updatedAt. Scopes:
//   • pinned    — always-there notes (period = null)
//   • weekly     — one-or-many notes per ISO week   (period = YYYY-Www)
//   • quarterly  — one-or-many notes per quarter     (period = YYYY-Qn)
// A virtual, read-only "CLAUDE.md" note is surfaced in the pinned scope and
// streams ~/.claude/CLAUDE.md live (it replaced the old North Stars doc).

type NoteScope = 'pinned' | 'weekly' | 'quarterly'
interface NoteMeta { id: string; title: string; scope: NoteScope; period: string | null; updatedAt: string; preview: string }

const WEEK_RE = /^\d{4}-W\d{2}$/
const QUARTER_RE = /^\d{4}-Q[1-4]$/
const ID_RE = /^[a-z0-9_]+$/
export const CLAUDE_MD_ID = 'claude-md'

function scopeOk(scope: NoteScope, period: string | null): boolean {
  if (scope === 'pinned') return period == null
  if (scope === 'weekly') return !!period && WEEK_RE.test(period)
  if (scope === 'quarterly') return !!period && QUARTER_RE.test(period)
  return false
}

// A one-line plain-text snippet for the sidebar (markdown syntax stripped).
function makePreview(content: string): string {
  const text = content
    .split('\n')
    .map(l => l.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+\[[ xX]\]\s*/, '').replace(/^[-*+]\s+/, '').replace(/[*_`>#]/g, '').trim())
    .filter(Boolean)
    .join(' ')
  return text.slice(0, 120)
}

function deriveTitle(content: string, fallback: string): string {
  const first = content.split('\n').map(l => l.replace(/^#{1,6}\s*/, '').replace(/[*_`>#]/g, '').trim()).find(Boolean)
  return (first && first.slice(0, 60)) || fallback
}

export function registerNotesHandlers(): void {
  const rocaDir = path.join(os.homedir(), 'Movies/ClaudeCode/roca')
  const notebooksDir = path.join(rocaDir, 'notebooks')
  const manifestPath = path.join(rocaDir, 'notes-index.json')
  const claudeMdPath = path.join(os.homedir(), '.claude/CLAUDE.md')
  // Legacy locations migrated on first run.
  const alignmentPath = path.join(rocaDir, 'alignment.md')
  const notesDir = path.join(rocaDir, 'notes')
  const goalsDir = path.join(rocaDir, 'goals')

  const nowIso = () => new Date().toISOString()
  const newId = () => `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const bodyPath = (id: string) => (ID_RE.test(id) ? path.join(notebooksDir, `${id}.md`) : null)

  const readManifest = (): NoteMeta[] => {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      return Array.isArray(raw?.notes) ? raw.notes.filter((n: NoteMeta) => n && ID_RE.test(n.id)) : []
    } catch { return [] }
  }
  const writeManifest = (notes: NoteMeta[]): void => {
    fs.mkdirSync(rocaDir, { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify({ notes }, null, 2))
  }
  const readBody = (id: string): string => {
    const file = bodyPath(id)
    if (!file) return ''
    try { if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8') } catch { /* ignore */ }
    return ''
  }

  // One-time import of the pre-Apple-Notes files so nothing already written is
  // lost. Runs only when no index exists yet.
  const migrateIfNeeded = (): void => {
    if (fs.existsSync(manifestPath)) return
    const notes: NoteMeta[] = []
    const add = (content: string, title: string, scope: NoteScope, period: string | null) => {
      const id = newId()
      fs.mkdirSync(notebooksDir, { recursive: true })
      fs.writeFileSync(path.join(notebooksDir, `${id}.md`), content)
      notes.push({ id, title, scope, period, updatedAt: nowIso(), preview: makePreview(content) })
    }
    try { const c = fs.readFileSync(alignmentPath, 'utf-8'); if (c.trim()) add(c, 'North Stars', 'pinned', null) } catch { /* none */ }
    try {
      for (const f of fs.readdirSync(notesDir)) {
        const m = f.match(/^(\d{4}-W\d{2})\.md$/)
        if (!m) continue
        const c = fs.readFileSync(path.join(notesDir, f), 'utf-8')
        if (c.trim()) add(c, deriveTitle(c, 'Week notes'), 'weekly', m[1])
      }
    } catch { /* none */ }
    try {
      for (const f of fs.readdirSync(goalsDir)) {
        const m = f.match(/^(\d{4}-Q[1-4])\.md$/)
        if (!m) continue
        const c = fs.readFileSync(path.join(goalsDir, f), 'utf-8')
        if (c.trim()) add(c, deriveTitle(c, 'Quarterly goals'), 'quarterly', m[1])
      }
    } catch { /* none */ }
    writeManifest(notes)
  }

  // ═══ List ═══
  ipcMain.handle('notes:list', () => {
    migrateIfNeeded()
    return { notes: readManifest() }
  })

  // ═══ Create ═══
  ipcMain.handle('notes:create', (_, { scope, period, title }: { scope: NoteScope; period: string | null; title?: string }) => {
    if (!scopeOk(scope, period ?? null)) return { ok: false }
    const id = newId()
    const file = bodyPath(id)!
    fs.mkdirSync(notebooksDir, { recursive: true })
    fs.writeFileSync(file, '')
    const meta: NoteMeta = { id, title: (title || '').trim() || 'New note', scope, period: period ?? null, updatedAt: nowIso(), preview: '' }
    writeManifest([...readManifest(), meta])
    return { ok: true, note: meta }
  })

  // ═══ Rename ═══
  ipcMain.handle('notes:rename', (_, { id, title }: { id: string; title: string }) => {
    if (id === CLAUDE_MD_ID) return { ok: false }
    const name = (title || '').trim()
    if (!name) return { ok: false }
    const notes = readManifest()
    const idx = notes.findIndex(n => n.id === id)
    if (idx < 0) return { ok: false }
    notes[idx] = { ...notes[idx], title: name, updatedAt: nowIso() }
    writeManifest(notes)
    return { ok: true }
  })

  // ═══ Delete ═══
  ipcMain.handle('notes:delete', (_, { id }: { id: string }) => {
    if (id === CLAUDE_MD_ID) return { ok: false }
    const file = bodyPath(id)
    if (file) { try { fs.rmSync(file, { force: true }) } catch { /* ignore */ } }
    writeManifest(readManifest().filter(n => n.id !== id))
    return { ok: true }
  })

  // ═══ Body get/save ═══
  ipcMain.handle('notes:getBody', (_, { id }: { id: string }) => {
    if (id === CLAUDE_MD_ID) {
      try { return fs.readFileSync(claudeMdPath, 'utf-8') } catch { return '# CLAUDE.md\n\n_Not found on this machine._' }
    }
    return readBody(id)
  })

  ipcMain.handle('notes:saveBody', (_, { id, content }: { id: string; content: string }) => {
    if (id === CLAUDE_MD_ID) return { ok: false } // read-only
    const file = bodyPath(id)
    if (!file) return { ok: false }
    fs.mkdirSync(notebooksDir, { recursive: true })
    fs.writeFileSync(file, content)
    const notes = readManifest()
    const idx = notes.findIndex(n => n.id === id)
    if (idx >= 0) {
      notes[idx] = { ...notes[idx], updatedAt: nowIso(), preview: makePreview(content) }
      writeManifest(notes)
    }
    return { ok: true }
  })
}
