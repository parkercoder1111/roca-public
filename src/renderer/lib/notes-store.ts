// Single source of truth for the notes feature, shared by every surface that
// shows notes — the top-level Notes tab and the assistant's right-panel overlay.
// Both read/write through this one store, so edits in one surface appear live in
// the other, and the store owns the debounced disk save (a surface can unmount
// mid-edit without losing the pending write). Bodies are plain markdown on disk.

export type NoteScope = 'pinned' | 'weekly' | 'quarterly'
export interface NoteMeta {
  id: string
  title: string
  scope: NoteScope
  period: string | null
  updatedAt: string
  preview: string
  readOnly?: boolean
}

// Virtual, read-only note that streams ~/.claude/CLAUDE.md. Always shown first
// in the pinned scope; replaced the old North Stars doc.
export const CLAUDE_MD_ID = 'claude-md'
const CLAUDE_MD_NOTE: NoteMeta = {
  id: CLAUDE_MD_ID, title: 'CLAUDE.md', scope: 'pinned', period: null,
  updatedAt: '', preview: 'Your ROCA context & mission (read-only)', readOnly: true,
}

const SAVE_DEBOUNCE_MS = 500
type Listener = () => void

class NotesStore {
  private notes: NoteMeta[] = []
  private loaded = false
  private bodyCache = new Map<string, string>()
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private noteListeners = new Set<Listener>()
  private bodyListeners = new Map<string, Set<Listener>>()

  // ── Note list ──
  // All notes, newest-updated first within a scope; CLAUDE.md pinned to the top.
  getNotes(): NoteMeta[] {
    return [CLAUDE_MD_NOTE, ...this.notes]
  }

  notesFor(scope: NoteScope, period: string | null): NoteMeta[] {
    return this.getNotes()
      .filter(n => n.scope === scope && n.period === period)
      .sort((a, b) => {
        if (a.readOnly) return -1
        if (b.readOnly) return 1
        return (b.updatedAt || '').localeCompare(a.updatedAt || '')
      })
  }

  async refreshNotes(): Promise<void> {
    try {
      const { notes } = await window.electronAPI.listNotes()
      this.notes = notes ?? []
      this.loaded = true
      this.emitNotes()
    } catch { /* keep whatever we have */ }
  }

  async ensureNotes(): Promise<void> {
    if (!this.loaded) await this.refreshNotes()
  }

  async createNote(scope: NoteScope, period: string | null, title: string): Promise<NoteMeta | null> {
    const res = await window.electronAPI.createNote(scope, period, title)
    if (!res?.ok || !res.note) return null
    await this.refreshNotes()
    return res.note
  }

  async renameNote(id: string, title: string): Promise<void> {
    await window.electronAPI.renameNote(id, title)
    await this.refreshNotes()
  }

  async deleteNote(id: string): Promise<void> {
    this.bodyCache.delete(id)
    this.clearTimer(id)
    await window.electronAPI.deleteNote(id)
    await this.refreshNotes()
  }

  // ── Body ──
  async loadBody(id: string): Promise<string> {
    if (this.bodyCache.has(id)) return this.bodyCache.get(id)!
    let content = ''
    try { content = await window.electronAPI.getNoteBody(id) } catch { /* empty */ }
    if (!this.bodyCache.has(id)) this.bodyCache.set(id, content)
    return this.bodyCache.get(id)!
  }

  getCachedBody(id: string): string | undefined {
    return this.bodyCache.get(id)
  }

  setBody(id: string, content: string): void {
    if (id === CLAUDE_MD_ID) return // read-only
    if (this.bodyCache.get(id) === content) return
    this.bodyCache.set(id, content)
    this.emitBody(id)
    this.clearTimer(id)
    this.saveTimers.set(id, setTimeout(() => {
      this.saveTimers.delete(id)
      window.electronAPI.saveNoteBody(id, content)
        .then(() => this.refreshNotes()) // pick up new preview/updatedAt for the list
        .catch(() => {})
    }, SAVE_DEBOUNCE_MS))
  }

  flush(): void {
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer)
      window.electronAPI.saveNoteBody(id, this.bodyCache.get(id) ?? '').catch(() => {})
    }
    this.saveTimers.clear()
  }

  // ── Subscriptions ──
  subscribeNotes(fn: Listener): () => void {
    this.noteListeners.add(fn)
    return () => this.noteListeners.delete(fn)
  }
  subscribeBody(id: string, fn: Listener): () => void {
    let set = this.bodyListeners.get(id)
    if (!set) { set = new Set(); this.bodyListeners.set(id, set) }
    set.add(fn)
    return () => set!.delete(fn)
  }

  private emitNotes(): void { this.noteListeners.forEach(fn => fn()) }
  private emitBody(id: string): void { this.bodyListeners.get(id)?.forEach(fn => fn()) }
  private clearTimer(id: string): void {
    const t = this.saveTimers.get(id)
    if (t) { clearTimeout(t); this.saveTimers.delete(id) }
  }
}

export const notesStore = new NotesStore()
