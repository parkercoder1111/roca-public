// The floating recording pill — a small always-on-top window shown while Scribe
// records, so the indicator + Stop are visible on top of the meeting (Zoom/Meet)
// regardless of which app is focused. Mirrors the popout-window pattern.
import { app, BrowserWindow, screen } from 'electron'
import path from 'path'

let pill: BrowserWindow | null = null

export function showPill(): void {
  if (pill && !pill.isDestroyed()) {
    pill.showInactive()
    return
  }
  const { workArea } = screen.getPrimaryDisplay()
  const width = 132
  const height = 64
  pill = new BrowserWindow({
    width,
    height,
    x: workArea.x + 24,
    y: workArea.y + workArea.height - height - 24, // bottom-left
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // Float above full-screen apps (e.g. a full-screen Zoom call).
  pill.setAlwaysOnTop(true, 'screen-saver')
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (!app.isPackaged) {
    pill.loadURL('http://localhost:5173?scribePill=1')
  } else {
    pill.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'), {
      query: { scribePill: '1' },
    })
  }
  pill.on('closed', () => {
    pill = null
  })
  pill.showInactive()
}

export function hidePill(): void {
  if (pill && !pill.isDestroyed()) {
    pill.close()
  }
  pill = null
}
