import { ipcMain } from 'electron'
import { syncAll, reconcileAll, processTranscript } from '../sync'
import { currentIsoWeek } from '../database'
import { runOrganize } from '../helpers/run-organize'
import { readRocaFile } from '../utils/read-roca-file'

export function registerSyncHandlers(): void {
  // ── Sync ──
  ipcMain.handle('sync:all', async () => {
    const count = await syncAll()
    return { count }
  })
  ipcMain.handle('sync:reconcile', async () => {
    const count = await reconcileAll()
    return { count }
  })

  // ── Organize (smart task maker) ──
  ipcMain.handle('organize:preview', async (_, week?: string) => {
    return await runOrganize(week || currentIsoWeek(), true)
  })
  ipcMain.handle('organize:apply', async (_, week?: string) => {
    return await runOrganize(week || currentIsoWeek(), false)
  })

  // ── Transcript processing ──
  ipcMain.handle('sync:process-transcript', async (
    _, meetingId: string, meetingName: string, transcriptText: string, meetingDate?: string
  ) => {
    const count = await processTranscript(meetingId, meetingName, transcriptText, meetingDate || '')
    return { created: count }
  })

  // ── Journal data ──
  ipcMain.handle('journal:get', () => {
    const journalContent = readRocaFile('journal.md') || '(No journal yet)'
    const promptContent = readRocaFile('roca-prompt.md') || '(No prompt file)'
    return { journal: journalContent, prompt: promptContent }
  })
}
