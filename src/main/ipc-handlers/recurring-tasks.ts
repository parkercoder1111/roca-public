import { ipcMain } from 'electron'
import {
  makeTaskRecurring,
  unmakeTaskRecurring,
  isTaskRecurring,
  getRecurringTasks,
  addRecurringTask,
  removeRecurringTask,
  spawnRecurringForWeek,
} from '../database'

export function registerRecurringTasksHandlers(): void {
  // ── Recurring ──
  ipcMain.handle('db:tasks:make-recurring', (_, taskId: number) => makeTaskRecurring(taskId))
  ipcMain.handle('db:tasks:unmake-recurring', (_, taskId: number) => {
    unmakeTaskRecurring(taskId)
    return { ok: true }
  })
  ipcMain.handle('db:tasks:is-recurring', (_, title: string) => isTaskRecurring(title))
  ipcMain.handle('db:recurring:list', () => getRecurringTasks())
  ipcMain.handle('db:recurring:add', (_, title: string, priority?: string, company_name?: string, deal_name?: string, notes?: string) => {
    return addRecurringTask(title, priority, company_name, deal_name, notes)
  })
  ipcMain.handle('db:recurring:remove', (_, recurringId: number) => {
    removeRecurringTask(recurringId)
    return { ok: true }
  })
  ipcMain.handle('db:recurring:spawn', (_, week?: string) => {
    return { count: spawnRecurringForWeek(week) }
  })
}
