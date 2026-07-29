import { app, BrowserWindow, Menu, nativeImage, dialog, shell, session, webContents, ipcMain, screen } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import { getToken as getSlackToken } from './slack'
import { configureBrowserSession } from './session-config'
import { attachPopupHandler } from './popup-handler'
import { windowRegistry, getFocusedRocaWindow, renderRectToScreenRect } from './window-registry'
import { taskIdFromParams } from './helpers/pty-id'
import {
  initDatabase,
  seedOnboardingIfNeeded,
  getTasks,
  getTaskById,
  createTask,
  toggleTask,
  updateTaskFields,
  updateTaskStatus,
  getWeekData,
  getInboxCount,
  getFolders,
  markTaskTriaged,
  getOpenUnfoldered,
  populateTaskFlags,
  currentIsoWeek,
  getScheduledDueTasks,
  clearScheduledAt,
  setTaskInProgress,
  spawnRecurringForWeek,
  rolloverAllPriorWeeks,
  repairRolloverFolders,
  savePtyScrollbackBatch,
  loadPtyScrollback,
  renamePtyScrollback,
  endTaskSession,
  saveSessionSummary,
  getActiveTaskSession,
  getCompletedTasksOlderThan,
} from './database'
import { syncAll, reconcileAll, processTranscript, syncVoiceNotes } from './sync'
import { PtyManager } from './pty-manager'
import { sendClaudeUserText, stopAllClaudeStreams } from './claude-stream-manager'
import { stopAllAgentRunWatchers } from './agent-run-watcher'
import { BrowserManager } from './browser-manager'
import { RemoteServer } from './remote-server'
import { DictationManager } from './dictation-manager'
import { ScribeManager } from './scribe-manager'
import { startActiveWindowMonitor, stopActiveWindowMonitor } from './active-window'
import { registerAllIpcHandlers, type IpcDeps } from './ipc-handlers'
import { stripAnsi } from './utils/strip-ansi'
import { generateSessionSummary } from './helpers/generate-session-summary'
import { runReflection } from './helpers/run-reflection'
import { runProactive } from './helpers/run-proactive'

// ═══════════════════════════════════════════
//  LOAD SHELL ENVIRONMENT
//  macOS Dock-launched apps don't inherit .zshrc env vars
// ═══════════════════════════════════════════

try {
  const shellEnv = execSync('zsh -ilc env 2>/dev/null', { timeout: 5000 }).toString()
  for (const line of shellEnv.split('\n')) {
    const eqIdx = line.indexOf('=')
    if (eqIdx < 1) continue
    const key = line.slice(0, eqIdx)
    const val = line.slice(eqIdx + 1)
    if (!process.env[key]) process.env[key] = val
  }
} catch { /* ignore — shell env loading is best-effort */ }

// ═══════════════════════════════════════════
//  APP GLOBALS
// ═══════════════════════════════════════════

// Returns the currently focused ROCA window, falling back to the oldest open
// window if none is focused. Use this for code that just needs "the window
// the user is on". For broadcasts (rebuild banner, update-available) use
// `windowRegistry.broadcast(...)`.
function focusedWindow(): BrowserWindow | null { return getFocusedRocaWindow() }
const popoutWindows = new Map<string, BrowserWindow>()
const ptyManager = new PtyManager()
const browserManager = new BrowserManager()
const remoteServer = new RemoteServer()
const dictationManager = new DictationManager()
const scribeManager = new ScribeManager()

// Track whether a code update is available
let updateAvailable = false
// Guard: suppress window-all-closed during hot-reload
let isHotReloading = false

/**
 * Clean up tmux sessions for tasks completed more than 1 day ago.
 * Handles both in-memory PTYs and orphaned tmux sessions from prior app runs.
 */
function cleanupStaleTmuxSessions(): void {
  const staleTasks = getCompletedTasksOlderThan(1)
  if (staleTasks.length === 0) return

  let cleaned = 0
  for (const task of staleTasks) {
    const ptyId = `task-${task.id}`
    // Kill in-memory PTY + tmux if still tracked
    if (ptyManager.has(ptyId)) {
      ptyManager.killWithTmux(ptyId)
      cleaned++
    } else {
      // Kill orphaned tmux session (not in memory map but still alive)
      if (ptyManager.killOrphanedTmuxSession(ptyId)) {
        cleaned++
      }
    }
  }
  if (cleaned > 0) {
    console.log(`[tmux-cleanup] Cleaned up ${cleaned} tmux sessions for tasks completed 1+ days ago`)
  }
}

// ═══════════════════════════════════════════
//  APPLICATION MENU
// ═══════════════════════════════════════════

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        ...(updateAvailable
          ? [
              { type: 'separator' as const },
              {
                label: 'Apply Update (keep sessions)',
                accelerator: 'CmdOrCtrl+Shift+U',
                click: async () => {
                  isHotReloading = true
                  windowRegistry.broadcast('app:rebuilding')
                  const srcDir = path.join(os.homedir(), 'repos/roca')
                  try {
                    try {
                      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
                      execSync('git add -A', { cwd: srcDir, timeout: 10000 })
                      execSync(`git diff --cached --quiet || git commit -m "ROCA update ${timestamp}"`, { cwd: srcDir, timeout: 10000 })
                      execSync('git push origin main', { cwd: srcDir, timeout: 30000 })
                    } catch (_gitErr) {
                      console.error('[roca] Git push failed:', _gitErr)
                    }
                    if (app.isPackaged) {
                      execSync('source $HOME/.nvm/nvm.sh && npm run build', { cwd: srcDir, timeout: 60000, shell: '/bin/bash' })
                      const installedRenderer = '/Applications/ROCA.app/Contents/Resources/app/dist/renderer'
                      const builtRenderer = path.join(srcDir, 'dist/renderer')
                      execSync(`rm -rf "${installedRenderer}" && cp -R "${builtRenderer}" "${installedRenderer}"`)
                      const installedMain = '/Applications/ROCA.app/Contents/Resources/app/dist/main'
                      const builtMain = path.join(srcDir, 'dist/main')
                      execSync(`rm -rf "${installedMain}" && cp -R "${builtMain}" "${installedMain}"`)
                    }
                    console.log('[roca] Hot-reload: reloading window (PTYs preserved)')
                    updateAvailable = false
                    buildAppMenu()
                    // Reload every open ROCA window — preserves PTYs, gives all
                    // windows the fresh renderer bundle. Primary window omits
                    // the windowId query (matches initial-launch behavior so
                    // its WINDOW_ID stays 'primary' and existing tab state in
                    // legacy localStorage keys remains readable).
                    for (const entry of windowRegistry.all()) {
                      if (app.isPackaged) {
                        entry.window.loadFile(
                          path.join(__dirname, '../../renderer/index.html'),
                          windowRegistry.isPrimary(entry.id) ? undefined : { query: { windowId: entry.id } },
                        )
                      } else {
                        entry.window.webContents.reload()
                      }
                    }
                    isHotReloading = false
                  } catch (e: unknown) {
                    isHotReloading = false
                    dialog.showErrorBox('Update Failed', (e instanceof Error ? e.message : String(e)) || 'Build failed')
                  }
                },
              },
              {
                label: 'Full Restart (kills sessions)',
                click: async () => {
                  if (app.isPackaged) {
                    const srcDir = path.join(os.homedir(), 'repos/roca')
                    try {
                      windowRegistry.broadcast('app:rebuilding')
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
                },
              },
            ]
          : []),
        { type: 'separator' },
        { role: 'services' as const },
        { type: 'separator' },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' },
        { role: 'quit' as const },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ═══════════════════════════════════════════
//  WINDOW CREATION
// ═══════════════════════════════════════════

// Webviews capture keyboard input — ROCA's renderer never sees keydown
// events when focus is inside Gmail/CRM/etc. Forward app-level shortcuts
// (⌘+Shift+A to toggle the assistant overlay, ⌘+Left/Right to cycle tabs)
// from any guest webContents up to the renderer so they keep working from
// inside webview-tool tabs. before-input-event fires for every key BEFORE
// the page sees it, so we can intercept without consuming non-shortcut keys.
function forwardAppShortcut(event: Electron.Event, input: Electron.Input): void {
  if (input.type !== 'keyDown') return
  // Route to the focused ROCA window — the one whose webview captured the key.
  const target = focusedWindow()
  if (!target || target.isDestroyed()) return
  const key = (input.key || '').toLowerCase()
  // ⌘+Shift+A → toggle assistant overlay
  if (input.meta && input.shift && !input.alt && !input.control && key === 'a') {
    event.preventDefault()
    target.webContents.send('global-shortcut:assistant-toggle')
    return
  }
  // ⌘+Shift+S → toggle the voice overlay
  if (input.meta && input.shift && !input.alt && !input.control && key === 's') {
    event.preventDefault()
    target.webContents.send('global-shortcut:voice-toggle')
    return
  }
  // ⌘+Left/Right → cycle tabs (browser-style). Trade-off: this overrides
  // "start/end of line" inside webview text fields. Use Home/End instead
  // when editing inside Gmail/CRM/etc.
  if (input.meta && !input.alt && !input.shift && !input.control &&
      (key === 'arrowleft' || key === 'arrowright')) {
    event.preventDefault()
    target.webContents.send(
      'global-shortcut:tab-cycle',
      key === 'arrowleft' ? 'prev' : 'next',
    )
  }
}

interface CreateWindowOpts {
  // Geometry — defaults to 1200x800 at OS default position. Used by tear-off
  // and Cmd+N to position new windows near the cursor or with a slight offset
  // from the source window.
  x?: number
  y?: number
  width?: number
  height?: number
}

// Build a new top-level ROCA window. The first call wires the primary window;
// subsequent calls (Cmd+N, tear-off tab drag) create additional windows that
// each get their own renderer + tab state. Returns the new window so callers
// can hand off tab state via IPC after `did-finish-load`.
function createWindow(opts: CreateWindowOpts = {}): BrowserWindow {
  const iconPath = path.join(__dirname, '../../build/icon.png')
  const win = new BrowserWindow({
    width: opts.width ?? 1200,
    height: opts.height ?? 800,
    x: opts.x,
    y: opts.y,
    title: 'ROCA',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    icon: iconPath,
    // macOS default eats the first click on an inactive window — the click
    // only brings ROCA to front and never reaches the renderer, forcing a
    // second click to actually interact. The user switches between apps all
    // day; without this flag every return to ROCA needs a wasted click.
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      navigateOnDragDrop: false,
    },
  })

  // Register with the registry first so we can pass the new window's ID into
  // the renderer via the URL query string (read synchronously by app.tsx so
  // localStorage keys can be namespaced before any state initializer runs).
  const entry = windowRegistry.register(win)

  // Disable macOS two-finger swipe back/forward navigation
  win.webContents.on('will-navigate', (e) => { e.preventDefault() })

  // House rule: nothing escapes ROCA. Any http(s) window.open from the
  // main renderer (xterm WebLinksAddon fallback, <a target="_blank"> in
  // markdown/notes/Slack/Email views, etc.) gets routed back to the
  // renderer as a new top-level dynamic tab instead of opening Chrome.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      if (!win.isDestroyed()) win.webContents.send('roca:open-url-in-new-tab', url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('did-attach-webview', (_event, guestWc) => {
    // Make the guest's session look like vanilla Chrome (UA + frame headers)
    // BEFORE wiring popup handling, so any window.open/popup the guest fires
    // inherits the same configured session.
    configureBrowserSession(guestWc.session)
    // Belt-and-suspenders: also run the userAgentData spoof via the main
    // process on every navigation, so the override lands in the page's main
    // world before any page JS can sniff it. The preload-side script-tag
    // injection in webview-preload.ts can race with parser-blocking <script>
    // tags in the page's <head>; executeJavaScript on `dom-ready` runs after
    // documentElement exists but before user-mode JS executes.
    guestWc.on('dom-ready', () => {
      const fallbackMajor = (process.versions.chrome || '130').split('.')[0]
      // Belt-and-suspenders fallback for webview-preload.ts's userAgentData
      // spoof (which usually wins the race and makes the guard below bail).
      // Everything is derived from the page's own navigator.userAgent so the
      // spoofed platform/version always match THIS tab's UA — macOS for the
      // default identity, Chrome OS only for the Slack tab. A mismatch is what
      // trips bot checks like Cloudflare Turnstile.
      const code = `(() => {
        if (navigator.userAgentData && navigator.userAgentData.brands &&
            navigator.userAgentData.brands.some(b => b.brand === 'Google Chrome')) return;
        const ua = navigator.userAgent;
        const major = (ua.match(/Chrome\\/(\\d+)/) || [])[1] || '${fallbackMajor}';
        const isCrOS = /CrOS/.test(ua);
        const platform = isCrOS ? 'Chrome OS' : 'macOS';
        const platformVersion = isCrOS ? '14.0.0' : '15.0.0';
        const brands = [
          { brand: 'Chromium', version: major },
          { brand: 'Not?A_Brand', version: '99' },
          { brand: 'Google Chrome', version: major },
        ];
        const fullVersionList = brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' }));
        const data = {
          brands, mobile: false, platform,
          getHighEntropyValues(hints) {
            const out = { brands, mobile: false, platform };
            if (!hints) return Promise.resolve(out);
            if (hints.includes('architecture')) out.architecture = 'arm';
            if (hints.includes('bitness')) out.bitness = '64';
            if (hints.includes('model')) out.model = '';
            if (hints.includes('platformVersion')) out.platformVersion = platformVersion;
            if (hints.includes('uaFullVersion')) out.uaFullVersion = major + '.0.0.0';
            if (hints.includes('fullVersionList')) out.fullVersionList = fullVersionList;
            if (hints.includes('wow64')) out.wow64 = false;
            return Promise.resolve(out);
          },
          toJSON() { return { brands, mobile: false, platform }; },
        };
        try {
          Object.defineProperty(Navigator.prototype, 'userAgentData', {
            get() { return data; }, configurable: true,
          });
        } catch (e) { console.warn('[ROCA] userAgentData override failed:', e); }
      })();`
      guestWc.executeJavaScript(code).catch(() => { /* nav may have raced */ })
    })
    attachPopupHandler({
      guestWc,
      mainWindow: win,
      browserManager,
      onGuestAttached: (wc) => wc.on('before-input-event', forwardAppShortcut),
    })
  })

  // Set dock icon on macOS — only needs to happen once, but doing it on every
  // window is idempotent and cheap.
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(iconPath)
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
    } catch {}
  }

  // Pass the windowId via URL query so the renderer can namespace its
  // localStorage keys. The primary (first) window omits the query so its
  // renderer sees the default 'primary' WINDOW_ID and inherits any pre-
  // existing un-namespaced tab state from earlier ROCA versions.
  const isFirst = windowRegistry.isPrimary(entry.id)
  if (!app.isPackaged) {
    const url = isFirst
      ? 'http://localhost:5173'
      : `http://localhost:5173?windowId=${encodeURIComponent(entry.id)}`
    win.loadURL(url)
    win.webContents.openDevTools()
  } else {
    win.loadFile(
      path.join(__dirname, '../../renderer/index.html'),
      isFirst ? undefined : { query: { windowId: entry.id } },
    )
  }

  // Flush any URLs that came in via `open-url` while the window was still
  // loading (e.g. ROCA was launched cold by clicking a link in Mail). Only the
  // first/primary window drains the buffer — secondary windows start empty.
  if (windowRegistry.isPrimary(entry.id)) {
    win.webContents.once('did-finish-load', () => {
      while (pendingOpenUrls.length > 0) {
        const url = pendingOpenUrls.shift()!
        if (!win.isDestroyed()) win.webContents.send('roca:open-url-in-new-tab', url)
      }
    })
  }

  return win
}

// ═══════════════════════════════════════════
//  IPC HANDLERS
// ═══════════════════════════════════════════

function registerIpcHandlers(): void {
  const deps: IpcDeps = {
    getMainWindow: () => focusedWindow(),
    popoutWindows,
    ptyManager,
    browserManager,
    remoteServer,
    scribeManager,
    getUpdateAvailable: () => updateAvailable,
    setUpdateAvailable: (v) => { updateAvailable = v },
    setIsHotReloading: (v) => { isHotReloading = v },
    rebuildMenu: buildAppMenu,
  }
  registerAllIpcHandlers(deps)

  // ── Window management (Chrome-style tabs + multi-window) ──
  // Renderer asks for the window's registry ID at startup so it can namespace
  // its localStorage keys and identify itself in cross-window tab-drag IPC.
  // Lives outside the windowId URL param because URL queries don't survive
  // hot-reload reloads (Electron drops the search portion when loadFile is
  // called without `{ query }` during reload).
  ipcMain.handle('window:get-id', (event) => {
    const entry = windowRegistry.byWebContents(event.sender)
    return entry?.id ?? null
  })

  // Cmd+N from renderer. New windows open with default geometry, offset 30px
  // from the source so they don't fully stack. Returns the new window's id.
  ipcMain.handle('window:open', (event) => {
    const sender = windowRegistry.byWebContents(event.sender)
    const base = sender?.window.getBounds()
    const opts: CreateWindowOpts = base
      ? { x: base.x + 30, y: base.y + 30, width: base.width, height: base.height }
      : {}
    const win = createWindow(opts)
    return windowRegistry.byWindow(win)?.id ?? null
  })

  // Close the requesting window. Used when the last tab in a non-primary
  // window closes (Chrome behavior). Primary window's last tab leaves the
  // pinned `Tasks` tab visible, so this rarely fires from the primary.
  ipcMain.handle('window:close', (event) => {
    const entry = windowRegistry.byWebContents(event.sender)
    if (entry && !entry.window.isDestroyed()) entry.window.close()
    return { ok: true }
  })

  // Tab strip geometry — renderer reports the strip's bounding rect (in
  // window-content coords) on layout. Translated to screen coords here so the
  // main process can hit-test the cursor during cross-window tab drags.
  ipcMain.handle('window:report-strip-bounds', (event, rect: { x: number; y: number; width: number; height: number } | null) => {
    const entry = windowRegistry.byWebContents(event.sender)
    if (!entry) return { ok: false }
    if (!rect) {
      windowRegistry.setTabStripBounds(entry.id, null)
    } else {
      const screenRect = renderRectToScreenRect(entry.window, rect)
      windowRegistry.setTabStripBounds(entry.id, screenRect)
    }
    return { ok: true }
  })

  // ── Cross-window tab drag broker ──
  // HTML5 drag events don't cross OS windows. So during a tab drag, the
  // source renderer kicks this state machine off via `tab:drag-begin`. We
  // poll the cursor and, when it enters another window's tab strip, send
  // `tab:drag-hover` to that renderer for a live drop-indicator preview.
  // On `tab:drag-end` we either: do nothing (same window — renderer handled
  // it), move the tab between windows, or create a new window (tear-off).
  interface DragState {
    sourceWindowId: string
    tabId: string
    serializedTab: unknown
    pollTimer: NodeJS.Timeout | null
    lastHoverWindowId: string | null
  }
  let activeDrag: DragState | null = null

  function stopDragPoll(): void {
    if (activeDrag?.pollTimer) clearInterval(activeDrag.pollTimer)
    if (activeDrag) activeDrag.pollTimer = null
  }

  function endActiveDrag(): void {
    if (!activeDrag) return
    stopDragPoll()
    // Clear any lingering hover indicator on whichever window last saw one.
    if (activeDrag.lastHoverWindowId) {
      const last = windowRegistry.byId(activeDrag.lastHoverWindowId)
      if (last && !last.window.isDestroyed()) {
        last.window.webContents.send('tab:drag-hover', null)
      }
    }
    activeDrag = null
  }

  ipcMain.handle('tab:drag-begin', (event, payload: { tabId: string; serializedTab: unknown }) => {
    const sourceEntry = windowRegistry.byWebContents(event.sender)
    if (!sourceEntry) return { ok: false, error: 'unknown source window' }
    endActiveDrag()
    activeDrag = {
      sourceWindowId: sourceEntry.id,
      tabId: payload.tabId,
      serializedTab: payload.serializedTab,
      pollTimer: null,
      lastHoverWindowId: null,
    }
    // Poll the cursor every ~16ms so we can preview drop targets in other
    // windows. setInterval is OK here because the source renderer always
    // sends drag-end (and a watchdog clears in case it doesn't).
    activeDrag.pollTimer = setInterval(() => {
      if (!activeDrag) return
      const cursor = screen.getCursorScreenPoint()
      const hit = windowRegistry.windowAtScreenPoint(cursor)
      const hoverId = hit && hit.id !== activeDrag.sourceWindowId ? hit.id : null

      if (hoverId !== activeDrag.lastHoverWindowId) {
        // Clear indicator on the previously-hovered window.
        if (activeDrag.lastHoverWindowId) {
          const last = windowRegistry.byId(activeDrag.lastHoverWindowId)
          if (last && !last.window.isDestroyed()) {
            last.window.webContents.send('tab:drag-hover', null)
          }
        }
        activeDrag.lastHoverWindowId = hoverId
      }
      if (hoverId && hit) {
        // Send the cursor X relative to the strip's content origin so the
        // renderer can show the drop indicator at the right position.
        const stripX = hit.tabStripBounds?.x ?? 0
        hit.window.webContents.send('tab:drag-hover', { x: cursor.x - stripX })
      }
    }, 16)
    return { ok: true }
  })

  ipcMain.handle('tab:drag-end', (event, payload: { cancelled?: boolean }) => {
    if (!activeDrag) return { ok: true }
    const sourceEntry = windowRegistry.byWebContents(event.sender)
    if (!sourceEntry || sourceEntry.id !== activeDrag.sourceWindowId) {
      // Stale end from a different sender — ignore so the active drag can run
      // to its proper completion.
      return { ok: false }
    }
    stopDragPoll()
    if (payload?.cancelled) {
      endActiveDrag()
      return { ok: true }
    }

    const cursor = screen.getCursorScreenPoint()
    const hit = windowRegistry.windowAtScreenPoint(cursor)
    const drag = activeDrag
    activeDrag = null

    if (hit && hit.id !== drag.sourceWindowId) {
      // Cross-window drop — insert into target's strip, remove from source.
      hit.window.webContents.send('tab:drag-hover', null)
      const stripX = hit.tabStripBounds?.x ?? 0
      hit.window.webContents.send('tab:drop', {
        serializedTab: drag.serializedTab,
        dropX: cursor.x - stripX,
      })
      sourceEntry.window.webContents.send('tab:remove', { tabId: drag.tabId })
      return { ok: true, kind: 'cross-window' }
    }

    // No target window under cursor → tear-off. New window inherits the
    // source's size, positioned at the cursor (offset so the title bar lands
    // under the pointer, mirroring Chrome).
    if (!hit) {
      const base = sourceEntry.window.getBounds()
      const newWin = createWindow({
        x: cursor.x - 100,
        y: cursor.y - 12,
        width: base.width,
        height: base.height,
      })
      // Defer the hand-off until the new renderer has loaded — only then can
      // it receive IPC messages.
      newWin.webContents.once('did-finish-load', () => {
        if (!newWin.isDestroyed()) {
          newWin.webContents.send('tab:drop', { serializedTab: drag.serializedTab, dropX: 0 })
        }
      })
      sourceEntry.window.webContents.send('tab:remove', { tabId: drag.tabId })
      return { ok: true, kind: 'tear-off' }
    }

    // Dropped back on the source window — renderer handled it via HTML5 DnD.
    return { ok: true, kind: 'same-window' }
  })

}

// ═══════════════════════════════════════════
//  SCHEDULER
// ═══════════════════════════════════════════

function startScheduler(): void {
  // Sync every 30 minutes
  setInterval(() => {
    safeSyncAll()
  }, 30 * 60 * 1000)

  // Rollover check every hour (catches week transitions even if app stays open)
  setInterval(() => {
    const result = rolloverAllPriorWeeks()
    if (result.count > 0) {
      console.log(`[scheduler] Rolled over ${result.count} incomplete tasks to current week`)
      // Transfer tmux sessions and scrollback from old task IDs to new ones
      for (const { oldId, newId } of result.mappings) {
        const oldPtyId = `task-${oldId}`
        const newPtyId = `task-${newId}`
        ptyManager.renameTmuxSession(oldPtyId, newPtyId)
        renamePtyScrollback(oldPtyId, newPtyId)
      }
    }
  }, 60 * 60 * 1000)

  // Nightly reconcile at 11pm
  setInterval(() => {
    const now = new Date()
    if (now.getHours() === 23 && now.getMinutes() < 5) {
      reconcileAll().catch(e => console.error('[roca] reconcile_all failed:', e))
    }
  }, 5 * 60 * 1000)

  // Scheduled sessions check every minute
  setInterval(() => {
    try {
      const tasks = getScheduledDueTasks()
      for (const task of tasks) {
        console.log(`[scheduler] Firing scheduled session for task ${task.id}: ${task.title}`)
        clearScheduledAt(task.id)
        // Mark in progress
        setTaskInProgress(task.id)
        showTaskNotification(task.title, 'Scheduled session started — task is now in progress')
      }
    } catch (e) {
      console.error('[scheduler] scheduled sessions check failed:', e)
    }
  }, 60 * 1000)

  // Daily reflection at 9:30pm — rewrites journal.md using Opus
  setInterval(() => {
    const now = new Date()
    if (now.getHours() === 21 && now.getMinutes() >= 28 && now.getMinutes() <= 32) {
      runReflection(showTaskNotification).catch(e => console.error('[scheduler] reflection failed:', e))
    }
  }, 5 * 60 * 1000)

  // Proactive briefing — morning (9am) and afternoon (2pm)
  setInterval(() => {
    const now = new Date()
    const h = now.getHours()
    const m = now.getMinutes()
    if ((h === 9 && m >= 0 && m <= 4) || (h === 14 && m >= 0 && m <= 4)) {
      const mode = h < 12 ? 'morning' : 'afternoon'
      runProactive(mode, showTaskNotification).catch(e => console.error(`[scheduler] proactive ${mode} failed:`, e))
    }
  }, 5 * 60 * 1000)
}

function safeSyncAll(): void {
  syncAll().then(count => {
    if (count > 0) {
      console.log(`[scheduler] Synced ${count} tasks`)
      showTaskNotification('Sync Complete', `${count} new task${count === 1 ? '' : 's'} synced`)
    }
  }).catch(e => console.error('[roca] sync_all failed:', e))
}

function showTaskNotification(_title: string, _body: string): void {
  // macOS notifications disabled
}

// ═══════════════════════════════════════════
//  REMOTE SERVER (mobile client)
// ═══════════════════════════════════════════

function startRemoteServer(): void {
  remoteServer.setPtyManager(ptyManager)

  // Wire PTY data/exit broadcasting
  ptyManager.onRemoteData = (ptyId, data) => remoteServer.broadcastPtyData(ptyId, data)
  ptyManager.onRemoteExit = (ptyId, exitCode) => remoteServer.broadcastPtyExit(ptyId, exitCode)

  // Register RPC handlers (mirrors IPC handlers)
  remoteServer.handle('tasks:list', (p) => getTasks(p?.week, p?.status, p?.source, p?.priority))
  remoteServer.handle('tasks:get', (p) => getTaskById(p.taskId))
  remoteServer.handle('tasks:create', (p) => ({ id: createTask(p) }))
  remoteServer.handle('tasks:toggle', (p) => toggleTask(p.taskId))
  remoteServer.handle('tasks:update-status', (p) => {
    const ok = updateTaskStatus(p.taskId, p.status)
    if (ok) markTaskTriaged(p.taskId)
    return { ok }
  })
  remoteServer.handle('tasks:update-fields', (p) => {
    updateTaskFields(p.taskId, p.fields)
    return { ok: true }
  })
  remoteServer.handle('tasks:open-unfoldered', (p) => {
    const tasks = getOpenUnfoldered(p?.week, p?.source, p?.priority)
    return populateTaskFlags(tasks)
  })

  remoteServer.handle('navigate:task', (p) => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No main window' }
    target.webContents.send('app:navigate-task', p.taskId)
    return { ok: true }
  })

  // Create (optionally) + open a task AND boot its Claude session — the one-call
  // path the voice brain needs. `navigate:task` only selects a task; it does NOT
  // start a terminal or launch Claude. This drives the renderer to open the task
  // and mount its terminal, which runs the existing startPty + auto-launch flow,
  // so the session is visible in ROCA exactly as if the user opened it by hand.
  // Params: {taskId} to boot an existing task, or {title, priority?, notes?,
  // folder_id?} to create one and boot it.
  remoteServer.handle('task:boot', (p) => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No ROCA window open to boot a session in' }
    let taskId = p?.taskId != null ? Number(p.taskId) : NaN
    if (!Number.isFinite(taskId)) {
      if (!p?.title || typeof p.title !== 'string') {
        return { ok: false, error: 'taskId or title is required' }
      }
      taskId = createTask({ title: p.title, priority: p.priority || 'medium', notes: p.notes ?? null })
      if (p.folder_id != null) {
        try { updateTaskFields(taskId, { folder_id: p.folder_id }) } catch { /* non-fatal */ }
      }
    }
    target.webContents.send('app:boot-task-session', taskId)
    return { ok: true, taskId }
  })

  remoteServer.handle('assistant:notify', (_p) => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No main window' }
    target.webContents.send('app:assistant-notify')
    return { ok: true }
  })

  remoteServer.handle('browser:open', (p) => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No main window' }
    const url = p.url
    const taskId = p.taskId
    if (!url) return { ok: false, error: 'url required' }
    // Tell the renderer to open the browser panel at this URL on the given (or active) task
    target.webContents.send('app:browser-open', { taskId, url })
    return { ok: true }
  })

  remoteServer.handle('browser:send-instruction', (p) => {
    if (!p.taskId || !p.instruction) return { ok: false, error: 'taskId and instruction required' }
    const browserSession = browserManager.getSession(p.taskId)
    if (!browserSession) return { ok: false, error: 'No browser session for this task' }
    browserManager.startClaudeLoop(p.taskId, p.instruction)
      .catch(err => console.error('[Browser] Claude loop error:', err))
    return { ok: true }
  })

  remoteServer.handle('browser:execute-js', async (p) => {
    if (!p.taskId || !p.code) return { ok: false, error: 'taskId and code required' }
    const wc = browserManager.getWebContentsPublic(p.taskId)
    if (!wc) return { ok: false, error: 'No webview for this task' }
    try {
      const result = await wc.executeJavaScript(p.code)
      return { ok: true, result }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  remoteServer.handle('browser:click', async (p) => {
    if (!p.taskId || p.x == null || p.y == null) return { ok: false, error: 'taskId, x, y required' }
    const wc = browserManager.getWebContentsPublic(p.taskId)
    if (!wc) return { ok: false, error: 'No webview for this task' }
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1,
      })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1,
      })
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  remoteServer.handle('browser:load-url', async (p) => {
    if (!p.taskId || !p.url) return { ok: false, error: 'taskId and url required' }
    const wc = browserManager.getWebContentsPublic(p.taskId)
    if (!wc) return { ok: false, error: 'No webview for this task' }
    let target = p.url
    if (!target.startsWith('http://') && !target.startsWith('https://')) target = 'https://' + target
    wc.loadURL(target)
    return { ok: true }
  })

  remoteServer.handle('folders:list', (p) => getFolders(p?.week, p?.source, p?.priority))

  remoteServer.handle('week:current', () => currentIsoWeek())
  remoteServer.handle('week:get', (p) => getWeekData(p?.week))

  remoteServer.handle('inbox:count', (p) => getInboxCount(p?.week))

  remoteServer.handle('pty:statuses', () => ptyManager.getStatuses())
  remoteServer.handle('pty:scrollback', (p) => ptyManager.getScrollback(p.ptyId))
  remoteServer.handle('pty:kill', (p) => { ptyManager.killWithTmux(p.ptyId); return { ok: true } })

  remoteServer.handle('pty:write', (p) => {
    ptyManager.write(p.ptyId, p.data)
    return { ok: true }
  })

  remoteServer.handle('pty:start', (p) => {
    const id = `task-${p.taskId}`
    // The PTY owner is whichever window has focus when the start request comes
    // in. PTY data still gets broadcast (pty-manager fans out via onRemoteData),
    // so the owner choice mostly matters for the IPC channel scoping.
    const owner = focusedWindow()
    if (!owner) return { ok: false, error: 'No main window' }
    const { existing, tmuxReattached } = ptyManager.start(id, owner.webContents)
    let savedScrollback: string | undefined
    if (!existing && !tmuxReattached) {
      const saved = loadPtyScrollback(id)
      if (saved) savedScrollback = saved
    }
    return { ok: true, id, existing, tmuxReattached, savedScrollback }
  })

  remoteServer.handle('terminal:send', (p) => {
    // Accept taskId or ptyId, and input or data — the voice brain and mobile
    // client each phrase it differently. Resolve to the real pty (the renderer
    // names task ptys `task-<id>-<tabId>` now, not `task-<id>`).
    const taskId = taskIdFromParams(p)
    if (!taskId) return { ok: false, error: 'taskId is required' }
    const input = typeof p.input === 'string' ? p.input : (typeof p.data === 'string' ? p.data : null)
    if (input == null) return { ok: false, error: 'input (or data) must be a string' }
    const ptyId = ptyManager.resolvePtyIdForTask(taskId) ?? `task-${taskId}`
    // If the task is currently open in optical view, a claude-stream session
    // exists; forward to it so the message appears as a user bubble.
    if (sendClaudeUserText(ptyId, input)) {
      return { ok: true, via: 'claude-stream' }
    }
    if (!ptyManager.has(ptyId)) return { ok: false, error: `No terminal found for task ${taskId}` }
    // Auto-submit unless the caller opts out or already included a newline, so
    // a voice "send X to that terminal" actually runs the line.
    const submit = p.submit !== false
    const toWrite = submit && !/[\r\n]$/.test(input) ? input + '\r' : input
    ptyManager.write(ptyId, toWrite)
    return { ok: true, ptyId }
  })

  remoteServer.handle('terminal:read', (p) => {
    const taskId = taskIdFromParams(p)
    if (!taskId) return { ok: false, error: 'taskId is required' }
    const ptyId = ptyManager.resolvePtyIdForTask(taskId)
    if (!ptyId) return { ok: false, error: `No terminal found for task ${taskId}` }
    const rendered = ptyManager.captureRenderedText(ptyId)
    const clean = stripAnsi(rendered)
    // Return last N chars (default 4000) to avoid massive payloads
    const tail = parseInt(p.tail) || 4000
    const output = clean.length > tail ? clean.slice(-tail) : clean
    return { ok: true, output }
  })

  remoteServer.handle('terminal:status', (p) => {
    const statuses = ptyManager.getStatuses()
    const taskId = taskIdFromParams(p)
    if (taskId) {
      const ptyId = ptyManager.resolvePtyIdForTask(taskId)
      return { ok: true, status: ptyId ? (statuses[ptyId] || 'running') : 'no_terminal' }
    }
    // Return all statuses, keyed by task id (strip the `task-` prefix and any
    // `-<tabId>` suffix so callers get a clean numeric/assistant id).
    const taskStatuses: Record<string, string> = {}
    for (const [ptyId, status] of Object.entries(statuses)) {
      const tid = ptyId.replace(/^task-/, '').replace(/-[a-z0-9]+$/i, '')
      taskStatuses[tid] = status
    }
    return { ok: true, statuses: taskStatuses }
  })

  remoteServer.handle('remote:info', () => ({
    token: remoteServer.getToken(),
    port: remoteServer.getPort(),
  }))

  // ── Voice-notes webhook (HTTP endpoint for external voice-notes callbacks) ──
  remoteServer.webhook('voice_notes', async (payload: any) => {
    // Reuse the same IPC handler logic
    const stateDir = process.env.VOICE_NOTES_STATE_DIR || app.getPath('userData')
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })

    // Log to webhook log file
    const logPath = process.env.VOICE_NOTES_WEBHOOK_LOG ||
      path.join(app.getPath('userData'), 'voice-notes-webhook-log.jsonl')
    try {
      const logDir = path.dirname(logPath)
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
      const entry = JSON.stringify({ received_at: new Date().toISOString(), payload }) + '\n'
      fs.appendFileSync(logPath, entry)
    } catch (e) {
      console.error('[webhook:voice_notes] Log write error:', e)
    }

    // Extract meeting data from the voice-notes webhook format
    const data = payload.data || {}
    const meeting = data.meeting || {}
    const meetingId = meeting.id || payload.meeting_id || payload.meetingId || ''
    const meetingName = meeting.title || payload.meeting_title || 'Unknown meeting'
    const meetingDate = meeting.start_date || payload.start_time || new Date().toISOString()

    // Process transcript if present
    let transcriptCount = 0
    let transcript = ''
    if (data.raw_content) transcript = data.raw_content
    else if (Array.isArray(data.content)) {
      transcript = data.content.map((c: any) => `${c.speaker || 'Speaker'}: ${c.text || ''}`).join('\n')
    }
    if (transcript && meetingId) {
      transcriptCount = await processTranscript(meetingId, meetingName, transcript, meetingDate, 'voice_notes')
    }

    // Also handle structured action items if present
    let rawItems = payload.action_items || payload.actionItems || data.action_items || data.actionItems || []
    const stagingPath = path.join(stateDir, 'voice-notes-staging.json')
    let voiceNotesCount = 0
    if (meetingId && rawItems.length > 0) {
      let staging: any = { fetched_at: '', total_pending: 0, meetings: {} }
      if (fs.existsSync(stagingPath)) {
        try { staging = JSON.parse(fs.readFileSync(stagingPath, 'utf-8')) } catch { /* ignore */ }
      }
      const actionItems = rawItems.map((item: any, idx: number) => {
        if (typeof item === 'string') return { id: `${meetingId}_${idx}`, title: item, assignee: null, completed: false }
        return {
          id: item.id || `${meetingId}_${idx}`,
          title: item.title || item.text || item.description || '',
          assignee: item.assignee || item.assigned_to || null,
          completed: item.completed || item.is_completed || false,
        }
      })
      staging.meetings[meetingId] = { meeting_name: meetingName, meeting_date: meetingDate, action_items: actionItems }
      staging.fetched_at = new Date().toISOString()
      staging.total_pending = Object.values(staging.meetings as Record<string, any>).reduce(
        (sum: number, m: any) => sum + (m.action_items || []).filter((ai: any) => !ai.completed).length, 0
      )
      fs.writeFileSync(stagingPath, JSON.stringify(staging, null, 2))
      voiceNotesCount = syncVoiceNotes(stagingPath)
    }

    return {
      ok: true,
      meeting_id: meetingId,
      has_transcript: !!transcript,
      transcript_created: transcriptCount,
      voice_notes_created: voiceNotesCount,
    }
  }, process.env.VOICE_NOTES_WEBHOOK_SECRET)

  // ── Screenshot & Navigation (for automated walkthrough agents) ──

  remoteServer.handle('screenshot:capture', async (p) => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No main window' }
    try {
      const image = await target.webContents.capturePage()
      const png = image.toPNG()
      const outputDir = p?.outputDir || path.join(app.getPath('temp'), 'roca-screenshots')
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
      const filename = p?.filename || `screenshot-${Date.now()}.png`
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, png)
      return { ok: true, path: filePath, width: image.getSize().width, height: image.getSize().height }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  remoteServer.handle('navigate:tab', (p) => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No main window' }
    const validTabs = ['email', 'week', 'filepath', 'slack']
    if (!p?.tab || !validTabs.includes(p.tab)) {
      return { ok: false, error: `Invalid tab. Must be one of: ${validTabs.join(', ')}` }
    }
    target.webContents.send('app:navigate-tab', p.tab)
    return { ok: true }
  })

  remoteServer.handle('navigate:get-tab', async () => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No main window' }
    try {
      // Per-window localStorage keys land at `roca:<key>:<windowId>`; we fall
      // back to the legacy un-namespaced key for the primary window (which
      // retained the old keys for backwards compat).
      const windowId = windowRegistry.byWindow(target)?.id ?? ''
      const tabKey = `roca:activeTab:${windowId}`
      const dynIdKey = `roca:activeDynamicId:${windowId}`
      const dynTabsKey = `roca:dynamicTabs:${windowId}`
      const tab = await target.webContents.executeJavaScript(
        `localStorage.getItem('${tabKey}') || localStorage.getItem('roca:activeTab') || 'week'`,
      ) || 'week'
      const activeDynamicId = await target.webContents.executeJavaScript(
        `localStorage.getItem('${dynIdKey}') || localStorage.getItem('roca:activeDynamicId')`,
      )
      let dynamicLabel: string | null = null
      if (activeDynamicId) {
        dynamicLabel = await target.webContents.executeJavaScript(`
          try {
            const raw = localStorage.getItem('${dynTabsKey}') || localStorage.getItem('roca:dynamicTabs') || '[]';
            const tabs = JSON.parse(raw);
            const t = tabs.find(t => t.id === '${activeDynamicId}');
            t ? t.label || t.url || t.id : null;
          } catch { null }
        `)
      }
      return { ok: true, tab: dynamicLabel || tab, pinnedTab: tab, dynamicTab: dynamicLabel }
    } catch {
      return { ok: true, tab: 'week' }
    }
  })

  remoteServer.handle('screenshot:walkthrough', async (p) => {
    const target = focusedWindow()
    if (!target) return { ok: false, error: 'No main window' }
    const tabs = ['week', 'email', 'filepath', 'slack']
    const outputDir = p?.outputDir || path.join(app.getPath('temp'), 'roca-walkthrough', `walkthrough-${Date.now()}`)
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

    // Save current tab so we can restore it after the walkthrough. Check the
    // per-window key first; fall back to the legacy global key.
    const windowId = windowRegistry.byWindow(target)?.id ?? ''
    const tabKey = `roca:activeTab:${windowId}`
    let originalTab = 'week'
    try {
      originalTab = await target.webContents.executeJavaScript(
        `localStorage.getItem('${tabKey}') || localStorage.getItem('roca:activeTab') || 'week'`,
      ) || 'week'
    } catch { /* fall back to week */ }

    const results: { tab: string; path: string; width: number; height: number }[] = []
    for (const tab of tabs) {
      target.webContents.send('app:navigate-tab', tab)
      // Wait for render
      await new Promise(resolve => setTimeout(resolve, p?.delay || 1000))
      const image = await target.webContents.capturePage()
      const png = image.toPNG()
      const filename = `${tab}.png`
      const filePath = path.join(outputDir, filename)
      fs.writeFileSync(filePath, png)
      results.push({ tab, path: filePath, width: image.getSize().width, height: image.getSize().height })
    }

    // Restore original tab
    target.webContents.send('app:navigate-tab', originalTab)

    return { ok: true, outputDir, screenshots: results }
  })

  // ── Debug: inspect any guest webview from the outside ──
  // Pass {urlMatch?: string, code?: string, openDevTools?: boolean}. Picks the
  // first guest webview whose URL contains urlMatch (or the most-recently-
  // attached guest if no match), runs `code` (default: navigator.userAgent)
  // in the page's main world, returns the result + url + title.
  remoteServer.handle('webview:query', async (p) => {
    const all = webContents.getAllWebContents()
    const guests = all.filter(wc => {
      try { return wc.getType?.() === 'webview' } catch { return false }
    })
    if (guests.length === 0) return { ok: false, error: 'No guest webviews attached', total: all.length }
    let target = guests[guests.length - 1]
    if (p?.urlMatch) {
      const m = guests.find(wc => { try { return wc.getURL().includes(p.urlMatch) } catch { return false } })
      if (m) target = m
    }
    if (p?.openDevTools) {
      try { target.openDevTools({ mode: 'detach' }) } catch { /* noop */ }
    }
    try {
      const result = await target.executeJavaScript(p?.code || 'navigator.userAgent')
      return { ok: true, result, url: target.getURL(), title: target.getTitle(), guestCount: guests.length }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), url: target.getURL() }
    }
  })

  // Expose specific env vars to mobile (for ElevenLabs voice mode)
  const ALLOWED_REMOTE_ENV = ['ELEVENLABS_API_KEY']
  remoteServer.handle('env:get', (p) => {
    if (!ALLOWED_REMOTE_ENV.includes(p?.key)) return null
    return process.env[p.key] || null
  })

  remoteServer.start()
}

// ═══════════════════════════════════════════
//  APP LIFECYCLE
// ═══════════════════════════════════════════

// Set app name for Dock and Spotlight
app.setName('ROCA')

// Disable macOS trackpad swipe-to-navigate (back/forward)
app.commandLine.appendSwitch('disable-features', 'TouchpadOverscrollHistoryNavigation')

// Tell macOS we'd like to handle http/https URLs (the Info.plist
// CFBundleURLTypes registration is the durable one — these calls are the
// runtime nudge). After the first install the user still has to pick ROCA
// in System Settings → Desktop & Dock → Default web browser.
try { app.setAsDefaultProtocolClient('http') } catch { /* noop */ }
try { app.setAsDefaultProtocolClient('https') } catch { /* noop */ }

// Buffer URLs that arrive via `open-url` before the main window has finished
// loading (e.g. clicking a link in Mail launches ROCA cold). Flushed once
// the renderer is ready.
const pendingOpenUrls: string[] = []
function deliverUrlToRenderer(url: string) {
  const target = focusedWindow()
  const wc = target?.webContents
  if (wc && !wc.isLoading()) {
    wc.send('roca:open-url-in-new-tab', url)
  } else {
    pendingOpenUrls.push(url)
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  deliverUrlToRenderer(url)
})

app.whenReady().then(async () => {
  initDatabase()
  seedOnboardingIfNeeded()
  // Promote any API keys the user saved in Settings into process.env so the
  // rest of the app (sync, delegate, child processes) picks them up without
  // refactor. Has to happen after app is ready because it uses userData path.
  const { hydrateEnv } = await import('./api-keys-config')
  hydrateEnv()
  ptyManager.setSaveFn(savePtyScrollbackBatch)
  // Watch task terminals for claude dying inside the still-alive tmux shell
  // and relaunch it, resuming the same conversation. Deaths are logged here
  // for root-causing the recurring exits.
  ptyManager.enableClaudeRevive(path.join(app.getPath('userData'), 'claude-session-deaths.log'))

  // ═══ Browser Session Configuration ═══
  // Make every session ROCA touches look like vanilla Chrome — UA, client
  // hints, and frame headers — so embedded sites (Google OAuth, Apps Script,
  // Slack signin, custom tools doing OAuth) don't refuse to load us as an
  // "embedded browser". Per-guest sessions are configured in
  // `did-attach-webview`. The default session also gets a Slack bearer-token
  // injector so private file/thumbnail URLs render inline from the renderer.
  configureBrowserSession(session.defaultSession, { getSlackBearer: getSlackToken })

  // Wire up session-end handler for conversation history capture
  ptyManager.onSessionEnd = (ptyId: string, scrollback: string) => {
    const match = ptyId.match(/^task-(\d+)$/)
    if (!match) return
    const taskId = parseInt(match[1])
    if (isNaN(taskId)) return

    // Find active session for this task
    const activeSession = getActiveTaskSession(taskId)
    if (!activeSession) return

    // Strip ANSI codes and save clean transcript
    const transcript = stripAnsi(scrollback)
    endTaskSession(activeSession.id, transcript)
    console.log(`[session] Ended session ${activeSession.id} for task ${taskId} (${transcript.length} chars)`)

    // Generate summary asynchronously
    const task = getTaskById(taskId)
    if (task && transcript.length > 100) {
      generateSessionSummary(transcript, task.title).then(summary => {
        if (summary) {
          saveSessionSummary(activeSession.id, summary)
          console.log(`[session] Summary saved for session ${activeSession.id}`)
        }
      }).catch(e => {
        console.error(`[session] Summary generation failed for session ${activeSession.id}:`, e)
      })
    }
  }

  registerIpcHandlers()
  createWindow()
  buildAppMenu()

  // Spawn recurring tasks for current week
  spawnRecurringForWeek()

  // Repair folder_id on tasks that were rolled over without it (one-time fix)
  const repaired = repairRolloverFolders()
  if (repaired > 0) console.log(`[startup] Restored folder assignments on ${repaired} rolled-over tasks`)

  // Roll over any incomplete tasks from prior weeks into the current week
  const rolloverResult = rolloverAllPriorWeeks()
  if (rolloverResult.count > 0) {
    console.log(`[startup] Rolled over ${rolloverResult.count} incomplete tasks to current week`)
    // Transfer tmux sessions and scrollback from old task IDs to new ones
    for (const { oldId, newId } of rolloverResult.mappings) {
      const oldPtyId = `task-${oldId}`
      const newPtyId = `task-${newId}`
      // Rename tmux session so the new task reconnects to the live session
      ptyManager.renameTmuxSession(oldPtyId, newPtyId)
      // Transfer saved scrollback in DB
      renamePtyScrollback(oldPtyId, newPtyId)
    }
  }

  // Clean up tmux sessions for tasks completed 1+ days ago (startup + every 6 hours)
  cleanupStaleTmuxSessions()
  setInterval(cleanupStaleTmuxSessions, 6 * 60 * 60 * 1000)

  // Initial sync
  safeSyncAll()

  startScheduler()
  startRemoteServer()
  startActiveWindowMonitor()

  // Host Echo (fn-to-talk dictation) as a supervised sidecar. Works system-wide
  // in every app; ROCA is the engine, not the boundary.
  dictationManager.start()

  // Host Scribe (meeting note-taker). Recording is on-demand via the Scribe tab.
  scribeManager.start()
  // Poll the calendar once a minute for the "Start note taker" popup.
  setInterval(() => { void scribeManager.checkMeetingStart() }, 60_000)

  // Load saved Chrome extensions
  try {
    const extConfigPath = path.join(app.getPath('userData'), 'extensions.json')
    if (fs.existsSync(extConfigPath)) {
      const exts: { id: string; name: string; path: string }[] = JSON.parse(fs.readFileSync(extConfigPath, 'utf-8'))
      for (const ext of exts) {
        try {
          if (fs.existsSync(ext.path)) {
            session.defaultSession.loadExtension(ext.path, { allowFileAccess: true })
            console.log(`[Extensions] Auto-loaded: ${ext.name}`)
          }
        } catch (err) {
          console.error(`[Extensions] Failed to auto-load ${ext.name}:`, err)
        }
      }
    }
  } catch (err) {
    console.error('[Extensions] Failed to load saved extensions:', err)
  }

  // Watch for file changes — notify renderer to show "Restart to update" banner
  {
    // In dev: watch compiled main process JS; in production: watch source files
    const watchDir = app.isPackaged
      ? path.join(os.homedir(), 'repos/roca/src')
      : __dirname
    let debounce: NodeJS.Timeout | null = null
    fs.watch(watchDir, { recursive: true }, (_, filename) => {
      const isSourceChange = filename && (filename.endsWith('.ts') || filename.endsWith('.tsx') || filename.endsWith('.css'))
      const isBuiltChange = filename && (filename.endsWith('.js') || filename.endsWith('.css') || filename.endsWith('.html'))
      if (app.isPackaged ? isSourceChange : isBuiltChange) {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          console.log(`[roca] ${app.isPackaged ? 'Source' : 'Build output'} changed (${filename}) — notifying renderer`)
          updateAvailable = true
          buildAppMenu()
          windowRegistry.broadcast('app:update-available')
        }, 400)
      }
    })
  }
}).catch(err => console.error('[roca] startup error:', err))

// Quitting ROCA is a hard reset: tear down every sidecar and child process it
// spawned. Factored out so BOTH the quit path (before-quit, which fires reliably
// on Cmd+Q) and window-all-closed run it, and it only runs once.
let didShutdown = false
function shutdownEverything(): void {
  if (didShutdown) return
  didShutdown = true
  try { stopActiveWindowMonitor() } catch (e) { console.error('[roca] shutdown monitor:', e) }
  try { remoteServer.stop() } catch (e) { console.error('[roca] shutdown remote:', e) }
  try { ptyManager.killAll() } catch (e) { console.error('[roca] shutdown ptys:', e) }
  try { stopAllClaudeStreams() } catch (e) { console.error('[roca] shutdown claude:', e) }
  try { stopAllAgentRunWatchers() } catch (e) { console.error('[roca] shutdown agents:', e) }
  try { browserManager.destroyAll() } catch (e) { console.error('[roca] shutdown browsers:', e) }
  try { dictationManager.stop() } catch (e) { console.error('[roca] shutdown dictation:', e) }
  try { scribeManager.stop() } catch (e) { console.error('[roca] shutdown scribe:', e) }
}

// Cmd+Q / app.quit(): kill every sidecar before we exit. A crash or force-quit
// can't run this — but each sidecar self-exits when it sees ROCA die (parent
// becomes launchd), so nothing is left holding the mic or the fn tap either way.
app.on('before-quit', () => {
  if (isHotReloading) return
  shutdownEverything()
})

app.on('window-all-closed', () => {
  if (isHotReloading) return // Don't kill PTYs during hot-reload
  shutdownEverything()
  app.quit()
})
