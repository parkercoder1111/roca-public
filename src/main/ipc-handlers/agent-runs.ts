// src/main/ipc-handlers/agent-runs.ts
import { ipcMain } from 'electron'
import {
  watchAgentRuns,
  unwatchAgentRuns,
  getAgentRuns,
  getAgentRunEvents,
} from '../agent-run-watcher'

export function registerAgentRunsHandlers(): void {
  ipcMain.handle('agent-runs:watch', (e, ptyId: string) => {
    watchAgentRuns(ptyId, e.sender)
    return { ok: true }
  })
  ipcMain.handle('agent-runs:unwatch', (_, ptyId: string) => {
    unwatchAgentRuns(ptyId)
    return { ok: true }
  })
  ipcMain.handle('agent-runs:get', (_, ptyId: string) => getAgentRuns(ptyId))
  ipcMain.handle('agent-runs:events', (_, ptyId: string, runId: string) =>
    getAgentRunEvents(ptyId, runId),
  )
}
