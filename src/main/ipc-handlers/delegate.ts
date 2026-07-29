import { ipcMain } from 'electron'
import {
  getTaskById,
  getCachedDelegate,
  saveDelegateCache,
  clearDelegateCache,
  createExecution,
  updateExecution,
  getExecution,
  getLatestExecution,
  addDelegateMessage,
  getDelegateMessages,
  clearDelegateMessages,
  getDelegateMessageCount,
} from '../database'
import {
  enrichAndAnalyze,
  refineOutput,
  executePlan,
  learnFromFeedback,
} from '../delegate'

export function registerDelegateHandlers(): void {
  // ── Delegate cache ──
  ipcMain.handle('db:delegate:get-cache', (_, taskId: number) => getCachedDelegate(taskId))
  ipcMain.handle('db:delegate:save-cache', (
    _, taskId: number, plan: string, context: string,
    cost: number, turns: number, error: string | null, sessionId?: string | null
  ) => {
    saveDelegateCache(taskId, plan, context, cost, turns, error, sessionId)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:clear-cache', (_, taskId: number) => {
    clearDelegateCache(taskId)
    return { ok: true }
  })

  // ── Delegate executions ──
  ipcMain.handle('db:delegate:create-execution', (_, taskId: number) => {
    return { id: createExecution(taskId) }
  })
  ipcMain.handle('db:delegate:update-execution', (
    _, execId: number, status: string, output?: string | null, cost?: number
  ) => {
    updateExecution(execId, status, output, cost)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:get-execution', (_, execId: number) => getExecution(execId))
  ipcMain.handle('db:delegate:latest-execution', (_, taskId: number) => getLatestExecution(taskId))

  // ── Delegate messages ──
  ipcMain.handle('db:delegate:add-message', (
    _, taskId: number, role: string, content: string, cost?: number, turns?: number
  ) => {
    addDelegateMessage(taskId, role, content, cost || 0, turns || 0)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:get-messages', (_, taskId: number) => getDelegateMessages(taskId))
  ipcMain.handle('db:delegate:clear-messages', (_, taskId: number) => {
    clearDelegateMessages(taskId)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:message-count', (_, taskId: number, role?: string) => {
    return getDelegateMessageCount(taskId, role)
  })

  // ── Delegate AI (enrichment + Claude headless) ──
  ipcMain.handle('delegate:analyze', async (_, taskId: number, userContext?: string) => {
    const task = getTaskById(taskId)
    if (!task) return { error: 'Task not found' }
    try {
      const result = await enrichAndAnalyze(task, userContext)
      // Persist to cache
      saveDelegateCache(
        taskId, result.plan || '', result.context || '',
        result.cost, result.turns, result.error || null, result.sessionId || null
      )
      return result
    } catch (e: unknown) {
      return { plan: '', context: '', cost: 0, turns: 0, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('delegate:refine', async (_, taskId: number, feedback: string) => {
    const task = getTaskById(taskId)
    if (!task) return { error: 'Task not found' }
    const cached = getCachedDelegate(taskId)
    const msgs = getDelegateMessages(taskId)
    try {
      const result = await refineOutput(
        task,
        cached?.plan || '',
        cached?.context || '',
        msgs || [],
        feedback,
        cached?.session_id || null
      )
      // Update cache with refined result
      if (result.plan) {
        saveDelegateCache(
          taskId, result.plan, result.context || cached?.context || '',
          (cached?.cost || 0) + result.cost, (cached?.turns || 0) + result.turns,
          result.error || null, result.sessionId || cached?.session_id || null
        )
      }
      return result
    } catch (e: unknown) {
      return { plan: '', context: '', cost: 0, turns: 0, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('delegate:execute', async (_, taskId: number) => {
    const task = getTaskById(taskId)
    if (!task) return { error: 'Task not found' }
    const cached = getCachedDelegate(taskId)
    if (!cached?.plan) return { error: 'No plan to execute' }
    try {
      const execId = createExecution(taskId)
      const result = await executePlan(task, cached.plan, cached.context || '')
      updateExecution(execId, result.output ? 'done' : 'error', result.output, result.cost)
      return { ...result, execId }
    } catch (e: unknown) {
      return { output: '', cost: 0, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('delegate:learn', async (_, taskId: number) => {
    const task = getTaskById(taskId)
    if (!task) return { ok: false }
    const msgs = getDelegateMessages(taskId)
    try {
      await learnFromFeedback('Task completed', task.title, msgs || [])
      return { ok: true }
    } catch (e: unknown) {
      console.error('[delegate:learn] Error:', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
