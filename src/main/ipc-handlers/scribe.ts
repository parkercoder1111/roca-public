import { ipcMain } from 'electron'
import type { IpcDeps } from './types'
import { getRecordings, getRecording, getSegments } from '../database'
import { FOLLOW_UP_EMAIL_QUESTION } from '../scribe-claude'

export function registerScribeHandlers(deps: IpcDeps): void {
  ipcMain.handle('scribe:start', (_e, a: { title: string; calendarEventId?: string | null }) =>
    deps.scribeManager.startRecording(a)
  )
  ipcMain.handle('scribe:stop', () => {
    deps.scribeManager.stopRecording()
    return { ok: true }
  })
  ipcMain.handle('scribe:status', () => deps.scribeManager.getStatus())
  ipcMain.handle('scribe:list', () => getRecordings())
  ipcMain.handle('scribe:get', (_e, id: number) => ({
    recording: getRecording(id),
    segments: getSegments(id),
  }))
  ipcMain.handle('scribe:ask', (_e, a: { id: number; question: string }) =>
    deps.scribeManager.ask(a.id, a.question)
  )
  ipcMain.handle('scribe:followup-email', (_e, id: number) =>
    deps.scribeManager.ask(id, FOLLOW_UP_EMAIL_QUESTION)
  )
  ipcMain.handle('scribe:upcoming', () => deps.scribeManager.getUpcoming())
  ipcMain.handle('scribe:rename', (_e, a: { id: number; title: string }) =>
    deps.scribeManager.rename(a.id, a.title)
  )
}
