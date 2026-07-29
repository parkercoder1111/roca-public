import { ipcMain } from 'electron'
import {
  getWeekData,
  updateChallenges,
  updateMeetingsHeld,
  currentIsoWeek,
} from '../database'

export function registerWeeksHandlers(): void {
  // ── Week ──
  ipcMain.handle('db:week:get', (_, week?: string) => getWeekData(week))
  ipcMain.handle('db:week:challenges', (_, week: string, text: string) => {
    updateChallenges(week, text)
    return { ok: true }
  })
  ipcMain.handle('db:week:meetings', (_, week: string, count: number) => {
    updateMeetingsHeld(week, count)
    return { ok: true }
  })
  ipcMain.handle('db:week:current', () => currentIsoWeek())
}
