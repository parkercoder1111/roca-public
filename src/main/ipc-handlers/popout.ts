import { ipcMain, app, BrowserWindow } from 'electron'
import path from 'path'
import type { IpcDeps } from './types'

export function registerPopoutHandlers(deps: IpcDeps): void {
  const { popoutWindows, getMainWindow } = deps

  // ── Popout windows ──
  ipcMain.handle('popout:open', (_event, { taskId, tab, taskTitle }: { taskId: number; tab: string; taskTitle?: string }) => {
    const key = `${taskId}-${tab}`
    const existing = popoutWindows.get(key)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return { ok: true }
    }

    const popout = new BrowserWindow({
      width: 900,
      height: 700,
      title: taskTitle ? `${taskTitle} — ${tab}` : `ROCA — ${tab}`,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      // Match the main window: don't make the user double-click after they
      // switch focus back from another app. See main.ts for context.
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
        navigateOnDragDrop: false,
      },
    })

    popoutWindows.set(key, popout)

    popout.on('closed', () => {
      popoutWindows.delete(key)
      // Notify main window that popout was closed
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('popout:closed', { taskId, tab })
      }
    })

    const params = `popout=1&taskId=${taskId}&tab=${tab}`
    if (!app.isPackaged) {
      popout.loadURL(`http://localhost:5173?${params}`)
    } else {
      popout.loadFile(path.join(__dirname, '..', '..', '..', 'renderer/index.html'), {
        query: { popout: '1', taskId: String(taskId), tab },
      })
    }

    return { ok: true }
  })

  ipcMain.handle('popout:close', (_event, { taskId, tab }: { taskId: number; tab: string }) => {
    const key = `${taskId}-${tab}`
    const win = popoutWindows.get(key)
    if (win && !win.isDestroyed()) {
      win.close()
    }
    return { ok: true }
  })

  ipcMain.handle('popout:get-params', (event) => {
    // Return the URL params for the requesting window so popout can know its task/tab
    const wc = event.sender
    const url = wc.getURL()
    try {
      const parsed = new URL(url)
      return {
        popout: parsed.searchParams.get('popout') === '1',
        taskId: parsed.searchParams.has('taskId') ? parseInt(parsed.searchParams.get('taskId')!) : null,
        tab: parsed.searchParams.get('tab'),
      }
    } catch {
      return { popout: false, taskId: null, tab: null }
    }
  })
}
