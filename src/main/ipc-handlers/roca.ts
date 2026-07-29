import { ipcMain } from 'electron'
import { runReflection } from '../helpers/run-reflection'
import { runProactive } from '../helpers/run-proactive'
import { writeActiveContext, clearActiveContext, type ActiveContext } from '../active-context'

export function registerRocaHandlers(): void {
  // ═══ Reflection & Proactive ═══
  ipcMain.handle('roca:reflect', async () => {
    try {
      await runReflection()
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('roca:proactive', async (_, mode?: string) => {
    try {
      await runProactive((mode as 'morning' | 'afternoon') || (new Date().getHours() < 12 ? 'morning' : 'afternoon'))
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Persist a snapshot of what the user is currently viewing so the ROCA
  // Assistant can read it from disk when they ask "draft a reply to this".
  ipcMain.handle('roca:write-active-context', (_, ctx: Partial<ActiveContext>) => {
    writeActiveContext(ctx)
  })

  // Safe reload uses this to clear persisted active-context so a bad entry
  // can't lock the app into a crash loop on startup.
  ipcMain.handle('roca:clear-active-context', () => {
    clearActiveContext()
  })
}
