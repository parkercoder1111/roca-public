import { ipcMain, app, session } from 'electron'
import path from 'path'
import fs from 'fs'
import { saveBrowserTabs, loadBrowserTabs, deleteBrowserTabs } from '../database'
import type { BrowserMode } from '../../shared/types'
import type { IpcDeps } from './types'

export function registerBrowserHandlers(deps: IpcDeps): void {
  const { browserManager } = deps

  // ═══ Browser ═══
  ipcMain.handle('browser:create', (event, taskId: number, mode: string) => {
    return browserManager.create(taskId, mode as BrowserMode, event.sender) // IPC boundary: mode arrives as string, narrowed to BrowserMode union
  })

  ipcMain.handle('browser:destroy', (_, taskId: number) => {
    browserManager.destroy(taskId)
    return { ok: true }
  })

  ipcMain.handle('browser:get', (_, taskId: number) => {
    return browserManager.getStatus(taskId)
  })

  ipcMain.handle('browser:register-webcontents', (_, taskId: number, webContentsId: number) => {
    browserManager.registerWebContents(taskId, webContentsId)
    return { ok: true }
  })

  ipcMain.handle('browser:navigate', (_, taskId: number, url: string) => {
    browserManager.updateUrl(taskId, url)
    return { ok: true }
  })

  ipcMain.handle('browser:nav-action', (_, taskId: number, action: string, url?: string) => {
    const ok = browserManager.navigate(taskId, action as 'back' | 'forward' | 'refresh' | 'load', url) // IPC boundary: action arrives as string, narrowed to navigate union
    return { ok }
  })

  ipcMain.handle('browser:send-instruction', async (_, taskId: number, instruction: string) => {
    const sessionObj = browserManager.getSession(taskId)
    if (!sessionObj) return { ok: false, error: 'No session' }

    browserManager.startClaudeLoop(taskId, instruction)
      .catch(err => console.error('[Browser] Claude loop error:', err))

    return { ok: true }
  })

  ipcMain.handle('browser:stop-claude', (_, taskId: number) => {
    const sessionObj = browserManager.getSession(taskId)
    if (sessionObj?.abortController) {
      sessionObj.abortController.abort()
    }
    return { ok: true }
  })

  // Browser tab persistence — survive app restart / update
  ipcMain.handle('browser:save-tabs', (_, taskId: number, tabs: { url: string; title: string }[], activeIndex: number) => {
    saveBrowserTabs(taskId, tabs, activeIndex)
    return { ok: true }
  })

  ipcMain.handle('browser:load-tabs', (_, taskId: number) => {
    return loadBrowserTabs(taskId)
  })

  ipcMain.handle('browser:delete-tabs', (_, taskId: number) => {
    deleteBrowserTabs(taskId)
    return { ok: true }
  })

  // Find-in-page for active webview
  ipcMain.handle('browser:find-in-page', (_, taskId: number, text: string, forward: boolean) => {
    const wc = browserManager.getWebContentsPublic(taskId)
    if (!wc) return { ok: false }
    if (!text) {
      wc.stopFindInPage('clearSelection')
      return { ok: true }
    }
    wc.findInPage(text, { forward, findNext: !forward })
    return { ok: true }
  })

  ipcMain.handle('browser:stop-find', (_, taskId: number) => {
    const wc = browserManager.getWebContentsPublic(taskId)
    if (wc) wc.stopFindInPage('clearSelection')
    return { ok: true }
  })

  // DevTools toggle for active webview
  ipcMain.handle('browser:toggle-devtools', (_, taskId: number) => {
    const wc = browserManager.getWebContentsPublic(taskId)
    if (!wc) return { ok: false }
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools()
    } else {
      wc.openDevTools({ mode: 'detach' })
    }
    return { ok: true }
  })

  // Zoom controls for active webview
  ipcMain.handle('browser:zoom', (_, taskId: number, direction: 'in' | 'out' | 'reset') => {
    const wc = browserManager.getWebContentsPublic(taskId)
    if (!wc) return { ok: false }
    const current = wc.getZoomLevel()
    if (direction === 'in') wc.setZoomLevel(Math.min(current + 0.5, 5))
    else if (direction === 'out') wc.setZoomLevel(Math.max(current - 0.5, -5))
    else wc.setZoomLevel(0)
    return { ok: true }
  })

  // Get favicon for a webview
  ipcMain.handle('browser:get-favicon', async (_, taskId: number) => {
    const wc = browserManager.getWebContentsPublic(taskId)
    if (!wc) return null
    try {
      const favicon = await wc.executeJavaScript(`
        (function() {
          const link = document.querySelector("link[rel*='icon']") || document.querySelector("link[rel='shortcut icon']");
          return link ? link.href : null;
        })()
      `)
      return favicon
    } catch {
      return null
    }
  })

  // ═══ Chrome Extensions ═══
  const extensionsConfigPath = path.join(app.getPath('userData'), 'extensions.json')

  function loadExtensionsConfig(): { id: string; name: string; path: string }[] {
    try {
      if (fs.existsSync(extensionsConfigPath)) {
        return JSON.parse(fs.readFileSync(extensionsConfigPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return []
  }

  function saveExtensionsConfig(exts: { id: string; name: string; path: string }[]) {
    fs.writeFileSync(extensionsConfigPath, JSON.stringify(exts, null, 2))
  }

  ipcMain.handle('extensions:load', async (_, extensionPath: string) => {
    try {
      const ext = await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true })
      const config = loadExtensionsConfig()
      const existing = config.findIndex(e => e.path === extensionPath)
      const entry = { id: ext.id, name: ext.name, path: extensionPath }
      if (existing >= 0) config[existing] = entry
      else config.push(entry)
      saveExtensionsConfig(config)
      console.log(`[Extensions] Loaded: ${ext.name} (${ext.id})`)
      return { ok: true, id: ext.id, name: ext.name }
    } catch (err: unknown) {
      console.error('[Extensions] Failed to load:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('extensions:list', async () => {
    try {
      const loaded = session.defaultSession.getAllExtensions()
      return loaded.map((ext: any) => ({ id: ext.id, name: ext.name, path: ext.path }))
    } catch {
      return []
    }
  })

  ipcMain.handle('extensions:remove', async (_, extensionId: string) => {
    try {
      session.defaultSession.removeExtension(extensionId)
      const config = loadExtensionsConfig().filter(e => e.id !== extensionId)
      saveExtensionsConfig(config)
      console.log(`[Extensions] Removed: ${extensionId}`)
      return { ok: true }
    } catch (err: unknown) {
      console.error('[Extensions] Failed to remove:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
