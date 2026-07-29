import { ipcMain, shell } from 'electron'
import { listAgents, getAgentState, tailAgentLog, startAgent, stopAgent, openAgentOutput, getAgentFiles, readAgentFile } from '../agent-manager'

export function registerAgentsHandlers(): void {
  // ── Agent management ──
  ipcMain.handle('agents:list', () => listAgents())
  ipcMain.handle('agents:state', (_, agentName: string) => getAgentState(agentName))
  ipcMain.handle('agents:logs', (_, agentLabel: string, lines?: number) => tailAgentLog(agentLabel, lines))
  ipcMain.handle('agents:start', (_, agentLabel: string) => startAgent(agentLabel))
  ipcMain.handle('agents:stop', (_, agentLabel: string) => stopAgent(agentLabel))
  ipcMain.handle('agents:files', (_, agentName: string) => getAgentFiles(agentName))
  ipcMain.handle('agents:read-file', (_, filePath: string) => readAgentFile(filePath))
  ipcMain.handle('agents:open-output', (_, agentLabel: string) => {
    const result = openAgentOutput(agentLabel)
    if (result.path) shell.openPath(result.path)
    return { ok: result.ok }
  })
}
