import { ipcMain, app, clipboard } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { exec } from 'child_process'
import {
  getTaskById,
  loadPtyScrollback,
  createTaskSession,
} from '../database'
import { enrichFromCrm } from '../delegate'
import { buildTaskContext, buildAssistantContext } from '../helpers/build-task-context'
import { resolveTaskCwd, shouldBypassPermissions } from '../helpers/resolve-task-cwd'
import { flowStateTaskIds } from '../helpers/flow-state-task-ids'
import type { IpcDeps } from './types'

export function registerPtyHandlers(deps: IpcDeps): void {
  const { ptyManager } = deps

  // ── PTY ──
  ipcMain.handle('pty:start', (event, taskId: string, cwd?: string, host?: string) => {
    const id = `task-${taskId}`
    const numericId = parseInt(taskId)
    let contextPath: string | undefined
    let finalCwd = cwd
    // Whether this task's claude should launch with permissions bypassed
    // (Development-folder or [Bug]/[Feature] tasks). The renderer still gates
    // this on a local host before adding --dangerously-skip-permissions.
    let bypassPermissions = false

    const isAssistant = taskId === 'assistant' || taskId.startsWith('assistant-')
    if (isAssistant) {
      // Assistant mode — generate desktop-control context, default cwd to home
      try {
        const contextDir = path.join(app.getPath('userData'), 'task-contexts')
        if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true })
        contextPath = path.join(contextDir, `${taskId}.md`)
        fs.writeFileSync(contextPath, buildAssistantContext())
      } catch (e) {
        console.error('[pty] Error writing assistant context:', e)
      }
      if (!finalCwd) finalCwd = os.homedir()
    } else if (!isNaN(numericId)) {
      const task = getTaskById(numericId)
      if (task) {
        // Generate task context file — write basic context immediately, enrich async
        try {
          const contextDir = path.join(app.getPath('userData'), 'task-contexts')
          if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true })
          contextPath = path.join(contextDir, `task-${taskId}.md`)
          // Write basic context immediately (no API delay)
          const md = buildTaskContext(task, numericId)
          fs.writeFileSync(contextPath, md)
          // Enrich from CRM in background — shell takes ~3-5s to init,
          // so the file will be updated before `cat` runs
          enrichFromCrm(task).then(enrichment => {
            if (enrichment.summary) {
              const enrichedMd = buildTaskContext(task, numericId, enrichment.summary)
              fs.writeFileSync(contextPath!, enrichedMd)
            }
          }).catch(e => {
            console.error('[pty] CRM enrichment failed (basic context still available):', e)
          })
        } catch (e) {
          console.error('[pty] Error writing task context:', e)
        }
        // Working directory: forked source cwd, then Development -> ROCA repo.
        // Shared with the optical view's headless launch so they can't drift.
        if (!finalCwd) finalCwd = resolveTaskCwd(task)
        bypassPermissions = shouldBypassPermissions(task)
      }
    }
    const { existing, tmuxReattached } = ptyManager.start(id, event.sender, finalCwd, host, bypassPermissions)
    // If this is a brand new PTY (not reconnecting or reattaching tmux), check for saved scrollback
    let savedScrollback: string | undefined
    if (!existing && !tmuxReattached) {
      const saved = loadPtyScrollback(id)
      if (saved) savedScrollback = saved
      // Create a new session record for conversation tracking
      if (!isNaN(numericId)) {
        try {
          const sessionId = createTaskSession(numericId)
          console.log(`[session] Created session ${sessionId} for task ${numericId}`)
        } catch (e) {
          console.error('[session] Failed to create session:', e)
        }
      }
    }
    return { ok: true, id, existing, tmuxReattached, savedScrollback, contextPath, bypassPermissions }
  })

  ipcMain.handle('pty:scrollback', (_, id: string) => {
    return ptyManager.getScrollback(id)
  })

  // Paste image from clipboard → save to temp file → return path + dataUrl for preview
  ipcMain.handle('clipboard:paste-image', () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return { ok: false, path: null, dataUrl: null }
    const tmpDir = path.join(app.getPath('temp'), 'roca-clipboard')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
    const filename = `paste-${Date.now()}.png`
    const filePath = path.join(tmpDir, filename)
    const png = img.toPNG()
    fs.writeFileSync(filePath, png)
    return { ok: true, path: filePath, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })

  // Opens Warp terminal and activates it. Script param reserved for future use.
  ipcMain.handle('open:warp', (_event, _script?: string) => {
    exec(`open -a "Warp" && sleep 0.5 && osascript -e 'tell application "Warp" to activate'`,
      (err) => { if (err) console.error('[open:warp] failed:', err.message) })
    return { ok: true }
  })

  ipcMain.handle('pty:statuses', () => {
    return ptyManager.getStatuses()
  })

  // Task ids with at least one live tmux tab. Survives ROCA restart since tmux
  // runs out-of-process — drives the "Flow State" filter, which wants every
  // task the user is mid-flow on regardless of whether they've reopened its
  // terminal panel since launch. See flowStateTaskIds for the session-name shapes.
  ipcMain.handle('pty:live-task-ids', () => {
    return flowStateTaskIds(ptyManager.getLivePtyIds())
  })

  ipcMain.on('pty:input', (_, { id, data }: { id: string; data: string }) => {
    ptyManager.write(id, data)
  })
  ipcMain.on('pty:resize', (_, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    ptyManager.resize(id, cols, rows)
  })
  ipcMain.handle('pty:kill', (_, id: string) => {
    // User explicitly killed — destroy tmux session too so it doesn't linger
    ptyManager.killWithTmux(id)
    return { ok: true }
  })
}
