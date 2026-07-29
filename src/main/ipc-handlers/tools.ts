import { ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { getTools, createTool, updateTool, deleteTool, getTaskById } from '../database'
import { enrichFromCrm } from '../delegate'
import { getToolFiles } from '../agent-manager'
import { buildTaskContext } from '../helpers/build-task-context'
import type { IpcDeps } from './types'

export function registerToolsHandlers(deps: IpcDeps): void {
  const { browserManager } = deps

  // ═══ Tools / Integrations ═══
  ipcMain.handle('tools:list', () => getTools())

  ipcMain.handle('tools:create', (_, tool: {
    name: string; description?: string; category?: string;
    connection_type?: string; status?: string; config?: string;
    icon?: string; capabilities?: string; account?: string; details?: string;
  }) => createTool(tool))

  ipcMain.handle('tools:update', (_, toolId: number, fields: Record<string, unknown>) => {
    updateTool(toolId, fields)
    return { ok: true }
  })

  ipcMain.handle('tools:delete', (_, toolId: number) => {
    deleteTool(toolId)
    return { ok: true }
  })

  ipcMain.handle('tools:files', (_, toolName: string) => getToolFiles(toolName))

  // ═══ Task Context ═══
  ipcMain.handle('task-context:generate', async (_, taskId: number) => {
    try {
      const task = getTaskById(taskId)
      if (!task) return { path: '' }

      const contextDir = path.join(app.getPath('userData'), 'task-contexts')
      if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true })

      // Enrich from CRM
      let enrichmentSummary: string | undefined
      try {
        const enrichment = await enrichFromCrm(task)
        if (enrichment.summary) enrichmentSummary = enrichment.summary
      } catch (e) {
        console.error('[task-context] CRM enrichment failed:', e)
      }

      let md = buildTaskContext(task, taskId, enrichmentSummary)

      // Browser session notes
      const browserStatus = browserManager.getStatus(taskId)
      if (browserStatus) {
        md += `## Browser Session\n\n`
        md += `**URL:** ${browserStatus.url}\n`
        md += `**Mode:** ${browserStatus.mode}\n`
        if (browserStatus.claudeStatus) md += `**Last action:** ${browserStatus.claudeStatus}\n`
        md += `\n`
      }

      const contextPath = path.join(contextDir, `task-${taskId}.md`)
      fs.writeFileSync(contextPath, md)
      return { path: contextPath }
    } catch (e) {
      console.error('[task-context] Error generating context:', e)
      return { path: '' }
    }
  })
}
