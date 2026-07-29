import { BrowserWindow, Menu, clipboard, shell, session } from 'electron'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import type { BrowserManager } from './browser-manager'

// Popup routing for <webview> guests. ROCA hosts two kinds of webviews:
//   1. Task-browser webviews — popups open as new tabs in the task's tab
//      bar (handled by browserManager).
//   2. Dynamic-tool webviews (Gmail, Sheets, custom user-added tools, ...) —
//      popups land in one of three places, by Chromium `disposition` + URL:
//        • foreground-tab / background-tab (target="_blank" links)
//          → new ROCA tab in the guest's partition (login flows through).
//        • new-window with `about:blank` (Sheets→Apps Script pattern —
//          opens a popup ref then assigns `popup.location.href = url`)
//          → hidden receiver BrowserWindow that captures the first
//            navigation and reroutes the URL to a ROCA tab.
//        • new-window with a real URL (typically OAuth)
//          → top-level BrowserWindow popup so window.opener + postMessage
//            works for the OAuth callback. Top-level (no `parent`) so the
//            popup stays interactable when ROCA's mainWindow is fullscreen.

// Keep in sync with WEBVIEW_TOOLS partitions in renderer/lib/webview-tools.ts.
const KNOWN_PARTITIONS = [
  'persist:google-workspace',
  'persist:crm',
  'persist:slack-webview',
]

// Map a webContents.session back to the partition string the renderer used
// to create it, so popup tabs can inherit the existing login. Custom-tool
// partitions are stored on disk under `Partitions/custom-<domain>` — their
// session has a `storagePath` we can pattern-match.
function partitionOfSession(s: Electron.Session): string | null {
  for (const p of KNOWN_PARTITIONS) {
    if (session.fromPartition(p) === s) return p
  }
  const sp = (s as unknown as { storagePath?: string }).storagePath
  if (typeof sp === 'string') {
    const m = sp.match(/Partitions\/(custom-[^/]+)$/)
    if (m) return `persist:${m[1]}`
  }
  return null
}

// Real BrowserWindow popup — used for OAuth-style window.open calls so the
// site keeps a working window.opener handle. Top-level (no `parent`) so the
// popup behaves like a normal Chrome popup window — interactable, focusable,
// and not bound to ROCA's mainWindow z-order (which broke Apps Script when
// mainWindow was fullscreen on macOS).
function dynamicToolPopupOptions(
  guestWc: Electron.WebContents,
): { action: 'allow'; overrideBrowserWindowOptions: Electron.BrowserWindowConstructorOptions } {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      show: true,
      width: 980,
      height: 720,
      autoHideMenuBar: true,
      webPreferences: {
        session: guestWc.session,
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  }
}

// Hidden "receiver" BrowserWindow used for the about:blank → set-location
// pattern (Sheets→Apps Script): `window.open('about:blank',w,h);
// popup.location.href = url`. The popup ref must be a real window so the
// parent's `popup.location.href = …` assignment works. Once the popup
// navigates, we capture the URL and reroute it to a ROCA tab.
function aboutBlankReceiverOptions(
  guestWc: Electron.WebContents,
): { action: 'allow'; overrideBrowserWindowOptions: Electron.BrowserWindowConstructorOptions } {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        session: guestWc.session,
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  }
}

function popupLog(msg: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    console.log(line.trim())
    fs.appendFileSync(path.join(app.getPath('userData'), 'popup-debug.log'), line)
  } catch { /* swallow log errors */ }
}

interface AttachOptions {
  guestWc: Electron.WebContents
  mainWindow: BrowserWindow | null
  browserManager: BrowserManager
  // Forward additional events back into main.ts (keyboard shortcut routing,
  // etc.). Kept as a callback so popup-handler stays unaware of app-level
  // shortcut semantics.
  onGuestAttached?: (guestWc: Electron.WebContents) => void
}

// Guest webContents whose next did-create-window is an about:blank "receiver"
// popup (Sheets→Apps Script pattern). Tracked with a WeakSet so destroyed
// guests get GC'd without manual cleanup.
const aboutBlankReceivers = new WeakSet<Electron.WebContents>()

// Attach popup-routing + recursion-on-popup-chain to a guest webContents.
// Call from the main window's `did-attach-webview` event for every guest.
export function attachPopupHandler(opts: AttachOptions): void {
  const { guestWc, mainWindow, browserManager, onGuestAttached } = opts
  popupLog(`did-attach-webview wc=${guestWc.id} url=${guestWc.getURL()}`)

  // Same-tab navigations still get logged so we can tell if a click on
  // (e.g.) Apps Script does a same-tab nav rather than opening a popup.
  guestWc.on('will-navigate', (_e, url) => {
    popupLog(`will-navigate wc=${guestWc.id} url=${url}`)
  })
  guestWc.on('will-redirect', (_e, url) => {
    popupLog(`will-redirect wc=${guestWc.id} url=${url}`)
  })

  // Shared "open URL in a new ROCA tab" routing. Used by both
  // setWindowOpenHandler (for window.open / target=_blank) and the
  // context menu (for right-click "Open Link in New Tab"). Returns true
  // if the URL was routed somewhere — false if the caller should fall
  // back (e.g. open externally).
  const routeUrlToNewTab = (url: string): boolean => {
    if (!url || url === 'about:blank') return false
    const taskId = browserManager.getTaskIdForWebContents(guestWc.id)
    if (taskId != null) {
      const browserSession = browserManager.getSession(taskId)
      if (browserSession && !browserSession.owner.isDestroyed()) {
        browserSession.owner.send(`browser:open-tab:${taskId}`, url)
        return true
      }
      return false
    }
    const partition = partitionOfSession(guestWc.session)
    if (partition && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:open-popup-tab', { url, partition })
      return true
    }
    return false
  }

  guestWc.setWindowOpenHandler((details) => {
    const { url, disposition, frameName } = details
    const taskId = browserManager.getTaskIdForWebContents(guestWc.id)
    popupLog(`window-open wc=${guestWc.id} url=${url} taskId=${taskId} ` +
      `frame=${frameName} disp=${disposition}`)

    // Task-browser path — owned by a ROCA task, route into its tab bar.
    if (taskId != null) {
      if (url && url !== 'about:blank') {
        const browserSession = browserManager.getSession(taskId)
        if (browserSession && !browserSession.owner.isDestroyed()) {
          browserSession.owner.send(`browser:open-tab:${taskId}`, url)
          return { action: 'deny' }
        }
      }
      return { action: 'deny' }
    }

    const partition = partitionOfSession(guestWc.session)

    // about:blank + new-window — Sheets→Apps Script pattern. The host page
    // calls `window.open('about:blank', name, 'width=…,height=…')` and then
    // assigns `popup.location.href = appsScriptUrl`. The popup ref must
    // exist as a real window for that assignment to work, so we open a
    // hidden receiver and reroute to a ROCA tab on first navigation.
    if (url === 'about:blank' && disposition === 'new-window' &&
        partition && mainWindow && !mainWindow.isDestroyed()) {
      popupLog('about:blank new-window → hidden receiver, will transfer to tab')
      aboutBlankReceivers.add(guestWc)
      return aboutBlankReceiverOptions(guestWc)
    }

    // OAuth-style popup with a real URL — needs a real BrowserWindow so the
    // site keeps a working window.opener for postMessage callbacks.
    if (disposition === 'new-window') {
      popupLog('disposition=new-window → real BrowserWindow popup')
      return dynamicToolPopupOptions(guestWc)
    }

    // target="_blank" / window.open(url, '_blank') without features —
    // route to a NEW in-app ROCA tab using the same partition so cookies
    // and login state flow through.
    if (url && url !== 'about:blank') {
      popupLog(`partition=${partition}`)
      if (partition && mainWindow && !mainWindow.isDestroyed()) {
        popupLog(`routing to renderer tab url=${url}`)
        mainWindow.webContents.send('app:open-popup-tab', { url, partition })
        return { action: 'deny' }
      }
    }

    popupLog('falling back to BrowserWindow popup')
    return dynamicToolPopupOptions(guestWc)
  })

  // Right-click context menu — gives the user a reliable way to open a
  // link in a new ROCA tab even when the host page intercepts clicks
  // and same-tab-navigates (many CRMs and SPAs). Without this, plain
  // <a href> links can't escape the current tab.
  guestWc.on('context-menu', (_event, params) => {
    const linkUrl = params.linkURL || ''
    popupLog(`context-menu wc=${guestWc.id} linkURL=${linkUrl} ` +
      `selection=${params.selectionText ? 'yes' : 'no'} editable=${params.isEditable}`)

    const items: Electron.MenuItemConstructorOptions[] = []
    if (linkUrl) {
      items.push({
        label: 'Open Link in New Tab',
        click: () => {
          if (!routeUrlToNewTab(linkUrl)) {
            shell.openExternal(linkUrl).catch(() => {})
          }
        },
      })
      items.push({
        label: 'Open Link in External Browser',
        click: () => { shell.openExternal(linkUrl).catch(() => {}) },
      })
      items.push({
        label: 'Copy Link Address',
        click: () => { clipboard.writeText(linkUrl) },
      })
      items.push({ type: 'separator' })
    }
    if (params.selectionText) {
      items.push({ label: 'Copy', role: 'copy' })
      items.push({ type: 'separator' })
    }
    if (params.isEditable) {
      items.push({ label: 'Cut', role: 'cut' })
      items.push({ label: 'Paste', role: 'paste' })
      items.push({ type: 'separator' })
    }
    items.push({ label: 'Back', enabled: guestWc.canGoBack(), click: () => guestWc.goBack() })
    items.push({ label: 'Forward', enabled: guestWc.canGoForward(), click: () => guestWc.goForward() })
    items.push({ label: 'Reload', click: () => guestWc.reload() })
    items.push({ type: 'separator' })
    items.push({
      label: 'Inspect Element',
      click: () => {
        try { guestWc.inspectElement(params.x, params.y) } catch {}
      },
    })

    const menu = Menu.buildFromTemplate(items)
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    menu.popup(owner ? { window: owner } : undefined)
  })

  // Page-level popup routing. Chromium silently blocks native window.open /
  // target=_blank popups inside these <webview> guests even with allowpopups set
  // (no user-gesture activation reaches the guest, and setWindowOpenHandler never
  // fires — verified via the popup-debug log). So we bridge open-intents out of
  // the page over `console-message`: the injected code console.logs a
  // `__ROCA_POPUP__:` line, and the handler below routes the URL into a ROCA tab.
  //
  // First-principles design: we do NOT decide folder-vs-file or synthesize opens
  // from DOM ids. The app (esp. Google Drive) already decides — it fires a popup
  // to open a FILE and navigates in place for a FOLDER. We only rescue the popup
  // the webview would otherwise eat, and leave everything else alone, so folders
  // (and any same-tab navigation) behave natively. See the injected body below.
  const installPopupOverride = () => {
    guestWc.executeJavaScript(`
      (function() {
        if (window.__rocaPopupOverrideInstalled) return;
        window.__rocaPopupOverrideInstalled = true;
        var P = '__ROCA_POPUP__:';
        function route(url) {
          try { console.log(P + JSON.stringify({ url: String(url || ''), target: '_blank', features: '' })); } catch (e) {}
        }
        // Stub window ref so callers that poke .location / .focus() don't throw.
        function stub(u) {
          return { closed: false, close: function(){ this.closed = true; }, focus: function(){}, blur: function(){},
                   postMessage: function(){}, location: { href: String(u || '') },
                   document: { write: function(){}, close: function(){} }, opener: null };
        }
        function isFileUrl(u) {
          return u.indexOf('docs.google.com/document/d/') > -1
            || u.indexOf('docs.google.com/spreadsheets/d/') > -1
            || u.indexOf('docs.google.com/presentation/d/') > -1
            || u.indexOf('docs.google.com/drawings/d/') > -1
            || u.indexOf('docs.google.com/forms/d/') > -1
            || u.indexOf('drive.google.com/file/d/') > -1
            || u.indexOf('drive.google.com/open?id=') > -1;
        }
        function isFolderUrl(u) { return u.indexOf('drive.google.com/drive/folders/') > -1; }
        // First principles: we do NOT classify folders vs files, nor synthesize an
        // "open" from a row's data-id. Drive already classifies: it fires a POPUP to
        // open a FILE (new tab) and navigates IN PLACE for a FOLDER. Inside this
        // webview Chromium blocks the popup, so all we do is catch Drive's popup and
        // route it to a ROCA tab. Folders are never touched, so they navigate in
        // place natively, like a normal browser — no per-view folder heuristics.
        //
        // Drive fires that file-open popup two ways, both caught below:
        //   (1) window.open(fileUrl)
        //   (2) a programmatically-clicked <a target="_blank" href="…file…"> — what
        //       grid/list double-clicks and search-dropdown results use.
        window.open = function(u, t, f) { var s = String(u || ''); if (s && s !== 'about:blank') route(s); return stub(s); };
        document.addEventListener('click', function(e) {
          if (e.button !== 0) return;
          var a = null, n = e.target, ad = 0;
          while (n && n !== document && ad < 14) { if (n.tagName === 'A' && n.href) { a = n; break; } n = n.parentNode; ad++; }
          if (!a) return;
          // Cmd/Ctrl-click → new tab for anything. Otherwise new-tab only target=
          // "_blank" / real file URLs, and never folder links (those stay in place).
          var explicit = e.metaKey || e.ctrlKey;
          var autoNewTab = (a.target === '_blank' || isFileUrl(a.href)) && !isFolderUrl(a.href);
          if (explicit || autoNewTab) { e.preventDefault(); e.stopPropagation(); route(a.href); }
        }, true);
      })();
    `).catch(() => { /* navigation in flight, retry on next dom-ready */ })
  }
  guestWc.on('dom-ready', installPopupOverride)

  // Receive popup-intent messages emitted by the injected override.
  // Routes through the same helper as the right-click context menu and
  // the (rarely-firing) setWindowOpenHandler, so a popup ends up in the
  // right surface (task tab strip vs. dynamic tab strip).
  const POPUP_PREFIX = '__ROCA_POPUP__:'
  const DEBUG_PREFIX = '__ROCA_DEBUG__:'
  guestWc.on('console-message', (_event, _level, message) => {
    if (!message) return
    if (message.startsWith(POPUP_PREFIX)) {
      const payload = message.slice(POPUP_PREFIX.length)
      popupLog(`page-popup wc=${guestWc.id} ${payload}`)
      try {
        const { url } = JSON.parse(payload) as { url: string }
        if (!url || url === 'about:blank') return
        if (!routeUrlToNewTab(url)) {
          popupLog(`page-popup route failed url=${url} → shell.openExternal`)
          shell.openExternal(url).catch(() => {})
        }
      } catch (err) {
        popupLog(`page-popup parse error: ${err}`)
      }
      return
    }
    if (message.startsWith(DEBUG_PREFIX)) {
      popupLog(`page-debug wc=${guestWc.id} ${message.slice(DEBUG_PREFIX.length)}`)
    }
  })

  // Popups that open more popups (common in OAuth flows) — wire the same
  // popup handler onto the new window so the chain keeps working. The
  // about:blank-receiver branch handles its own popup (no recursion needed).
  guestWc.on('did-create-window', (newWin) => {
    if (aboutBlankReceivers.has(guestWc)) {
      aboutBlankReceivers.delete(guestWc)
      attachAboutBlankReceiver(newWin, mainWindow)
      return
    }
    attachRecursivePopup(newWin, mainWindow)
  })

  onGuestAttached?.(guestWc)
}

// Wire a hidden receiver popup so its first non-about:blank navigation gets
// transferred to a ROCA tab in the same partition; the receiver is then
// closed. Falls back to showing the popup if no navigation arrives within 5s.
function attachAboutBlankReceiver(
  popup: BrowserWindow,
  mainWindow: BrowserWindow | null,
): void {
  const wc = popup.webContents
  let transferred = false

  const transfer = (navUrl: string) => {
    if (transferred || !navUrl || navUrl === 'about:blank') return
    transferred = true
    const partition = partitionOfSession(wc.session)
    popupLog(`receiver transfer url=${navUrl} partition=${partition}`)
    if (partition && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:open-popup-tab', { url: navUrl, partition })
    }
    if (!popup.isDestroyed()) popup.close()
  }

  wc.on('will-navigate', (e, navUrl) => {
    if (transferred || navUrl === 'about:blank') return
    e.preventDefault()
    transfer(navUrl)
  })
  wc.on('did-start-navigation', (_e, navUrl, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    transfer(navUrl)
  })

  setTimeout(() => {
    if (!transferred && !popup.isDestroyed()) {
      popupLog('about:blank receiver never navigated — showing directly')
      popup.setSize(980, 720)
      popup.center()
      popup.show()
    }
  }, 5000)
}

function attachRecursivePopup(win: BrowserWindow, mainWindow: BrowserWindow | null): void {
  const wc = win.webContents
  wc.setWindowOpenHandler(() => dynamicToolPopupOptions(wc))
  wc.on('did-create-window', (newWin) => attachRecursivePopup(newWin, mainWindow))
}
