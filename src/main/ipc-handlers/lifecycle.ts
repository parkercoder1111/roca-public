import { ipcMain, app, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import { syncVoiceNotes, processTranscript } from '../sync'
import type { IpcDeps } from './types'

export function registerLifecycleHandlers(deps: IpcDeps): void {
  const { ptyManager, getMainWindow } = deps

  // ── App restart (with rebuild if packaged) ──
  // Hot-reload: rebuild renderer and reload BrowserWindow — PTYs survive
  ipcMain.handle('app:restart', async () => {
    deps.setIsHotReloading(true)
    const mainWindow = getMainWindow()
    if (app.isPackaged) {
      const srcDir = process.env.ROCA_SRC_DIR || path.join(os.homedir(), 'repos/roca')
      try {
        mainWindow?.webContents.send('app:rebuilding')
        // Git commit & push before building
        try {
          const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
          execSync('git add -A', { cwd: srcDir, timeout: 10000 })
          execSync(`git diff --cached --quiet || git commit -m "ROCA update ${timestamp}"`, { cwd: srcDir, timeout: 10000 })
          execSync('git push origin main', { cwd: srcDir, timeout: 30000 })
        } catch (_gitErr) {
          console.error('[roca] Git push failed:', _gitErr)
        }
        // Only rebuild renderer (fast) — not a full pack
        execSync('source $HOME/.nvm/nvm.sh && npm run build', { cwd: srcDir, timeout: 60000, shell: '/bin/bash' })
        // Copy fresh renderer build into the installed app
        const installedRenderer = '/Applications/ROCA.app/Contents/Resources/app/dist/renderer'
        const builtRenderer = path.join(srcDir, 'dist/renderer')
        execSync(`rm -rf "${installedRenderer}" && cp -R "${builtRenderer}" "${installedRenderer}"`)
        // Also update compiled main process JS
        const installedMain = '/Applications/ROCA.app/Contents/Resources/app/dist/main'
        const builtMain = path.join(srcDir, 'dist/main')
        execSync(`rm -rf "${installedMain}" && cp -R "${builtMain}" "${installedMain}"`)
        // Reload window — PTYs stay alive, renderer reconnects. Preserve the
        // window's URL search so the renderer's WINDOW_ID stays consistent
        // (non-primary windows carry ?windowId=... in their URL).
        console.log('[roca] Hot-reload: renderer updated, reloading window (PTYs preserved)')
        deps.setUpdateAvailable(false)
        deps.rebuildMenu()
        if (mainWindow) {
          // Prefer loadURL with the current URL so the search string survives;
          // fall back to loadFile when the URL isn't a file:// (dev mode).
          const currentUrl = mainWindow.webContents.getURL()
          if (currentUrl.startsWith('file://') && currentUrl.includes('?')) {
            // Parse the existing query, re-pass it via loadFile's `query` opt
            // (loadFile re-encodes properly; raw loadURL on file:// is finicky).
            try {
              const search = new URL(currentUrl).searchParams
              const query: Record<string, string> = {}
              search.forEach((v, k) => { query[k] = v })
              mainWindow.loadFile(path.join(__dirname, '../../../renderer/index.html'), { query })
            } catch {
              mainWindow.loadFile(path.join(__dirname, '../../../renderer/index.html'))
            }
          } else {
            mainWindow.loadFile(path.join(__dirname, '../../../renderer/index.html'))
          }
        }
        deps.setIsHotReloading(false)
      } catch (e: unknown) {
        deps.setIsHotReloading(false)
        dialog.showErrorBox('Update Failed', (e instanceof Error ? e.message : String(e)) || 'Build failed')
      }
    } else {
      // Dev mode: just reload the window (Vite serves fresh code)
      console.log('[roca] Dev hot-reload: reloading window (PTYs preserved)')
      deps.setUpdateAvailable(false)
      deps.rebuildMenu()
      mainWindow?.webContents.reload()
    }
  })

  // Full restart — for main process changes that require a process restart
  ipcMain.handle('app:full-restart', async () => {
    const mainWindow = getMainWindow()
    if (app.isPackaged) {
      const srcDir = process.env.ROCA_SRC_DIR || path.join(os.homedir(), 'repos/roca')
      try {
        mainWindow?.webContents.send('app:rebuilding')
        try {
          const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
          execSync('git add -A', { cwd: srcDir, timeout: 10000 })
          execSync(`git diff --cached --quiet || git commit -m "ROCA update ${timestamp}"`, { cwd: srcDir, timeout: 10000 })
          execSync('git push origin main', { cwd: srcDir, timeout: 30000 })
        } catch (_gitErr) {
          console.error('[roca] Git push failed:', _gitErr)
        }
        execSync('source $HOME/.nvm/nvm.sh && rm -rf dist release && npm run pack', { cwd: srcDir, timeout: 180000, shell: '/bin/bash' })
        const builtApp = path.join(srcDir, 'release/mac-arm64/ROCA.app')
        const installedApp = '/Applications/ROCA.app'
        execSync(`rm -rf "${installedApp}" && cp -R "${builtApp}" "${installedApp}"`)
        ptyManager.killAll()
        app.relaunch({ execPath: path.join(installedApp, 'Contents/MacOS/ROCA') })
        app.exit(0)
      } catch (e: unknown) {
        dialog.showErrorBox('Update Failed', (e instanceof Error ? e.message : String(e)) || 'Build failed')
      }
    } else {
      ptyManager.killAll()
      app.relaunch()
      app.exit(0)
    }
  })

  // ── Voice-notes webhook data (ingest from external source) ──
  // NOTE: the IPC channel id 'webhook:voice-notes' is a shared contract with
  // the preload/renderer bridge — keep both sides in sync when renaming.
  ipcMain.handle('webhook:voice-notes', async (_, payload: any) => {
    // Write to voice-notes staging file and sync — use ROCA's own data dir
    const stateDir = process.env.VOICE_NOTES_STATE_DIR || app.getPath('userData')
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })

    const stagingPath = path.join(stateDir, 'voice-notes-staging.json')
    let staging: any = { fetched_at: '', total_pending: 0, meetings: {} }
    if (fs.existsSync(stagingPath)) {
      try { staging = JSON.parse(fs.readFileSync(stagingPath, 'utf-8')) } catch { /* ignore */ }
    }

    const meetingId = payload.meeting_id || payload.meetingId || ''
    const meetingName = payload.meeting_title || payload.meetingTitle || payload.title || 'Unknown meeting'
    const meetingDate = payload.start_time || payload.startTime || payload.meeting_date || new Date().toISOString()

    let rawItems = payload.action_items || payload.actionItems || []
    if (!rawItems.length && payload.data) {
      const data = payload.data
      if (typeof data === 'object') {
        rawItems = data.action_items || data.actionItems || []
      }
    }

    if (meetingId && rawItems.length > 0) {
      const actionItems = rawItems.map((item: any, idx: number) => {
        if (typeof item === 'string') {
          return { id: `${meetingId}_${idx}`, title: item, assignee: null, completed: false }
        }
        return {
          id: item.id || `${meetingId}_${idx}`,
          title: item.title || item.text || item.description || '',
          assignee: item.assignee || item.assigned_to || null,
          completed: item.completed || item.is_completed || false,
        }
      })

      staging.meetings[meetingId] = {
        meeting_name: meetingName,
        meeting_date: meetingDate,
        action_items: actionItems,
      }
      staging.fetched_at = new Date().toISOString()
      staging.total_pending = Object.values(staging.meetings as Record<string, any>).reduce(
        (sum: number, m: any) => sum + (m.action_items || []).filter((ai: any) => !ai.completed).length,
        0
      )

      fs.writeFileSync(stagingPath, JSON.stringify(staging, null, 2))
    }

    // Sync voice notes + transcript (pass the staging path we just wrote to)
    const count = syncVoiceNotes(stagingPath)
    const transcriptText = payload.transcript || payload.transcription ||
      (payload.data && typeof payload.data === 'object' ? (payload.data.transcript || payload.data.transcription || '') : '')

    let transcriptCount = 0
    if (transcriptText) {
      transcriptCount = await processTranscript(meetingId, meetingName, transcriptText, meetingDate, 'voice_notes')
    }

    return {
      ok: true,
      meeting_id: meetingId,
      items: rawItems.length,
      has_transcript: !!transcriptText,
      voice_notes_created: count,
      transcript_created: transcriptCount,
    }
  })
}
