/**
 * Active Window Monitor
 *
 * Polls macOS for the frontmost application and window title every few seconds.
 * Writes a JSON file that Claude sessions can read to know what the user is looking at.
 *
 * When ROCA (Electron) is frontmost, the file retains the *previous* app info
 * so Claude knows what the user was just looking at before switching to ROCA.
 */

import { execFile } from 'child_process'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const POLL_INTERVAL_MS = 3_000

export interface ActiveWindowInfo {
  app: string
  title: string
  url: string | null
  timestamp: string
}

// JXA (JavaScript for Automation) — more reliable than AppleScript for conditional logic
const JXA_SCRIPT = `
function run() {
  const se = Application("System Events");
  const procs = se.processes.whose({frontmost: true});
  let appName = "", winTitle = "", tabURL = "";

  if (procs.length > 0) {
    appName = procs[0].name();
    try { winTitle = procs[0].windows[0].name(); } catch(e) {}
  }

  // Chromium-based browsers all use the same activeTab API
  const chromiumBrowsers = ["Google Chrome", "Google Chrome Canary", "Microsoft Edge", "Brave Browser", "Vivaldi", "Opera"];
  if (chromiumBrowsers.includes(appName)) {
    try {
      const browser = Application(appName);
      tabURL = browser.windows[0].activeTab.url();
    } catch(e) {}
  } else if (appName === "Safari") {
    try {
      const safari = Application("Safari");
      tabURL = safari.windows[0].currentTab.url();
    } catch(e) {}
  }
  // Firefox and Arc don't expose URLs via scripting — window title is the best we get

  return appName + "|||" + winTitle + "|||" + tabURL;
}
`

let pollTimer: NodeJS.Timeout | null = null
let lastInfo: ActiveWindowInfo | null = null
let filePath: string | null = null

function getFilePath(): string {
  if (!filePath) {
    filePath = path.join(app.getPath('userData'), 'active-window.json')
  }
  return filePath
}

function poll(): void {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], { timeout: 5_000 }, (err, stdout) => {
    if (err) return // silently skip on error (e.g., permission denied, timeout)

    const parts = stdout.trim().split('|||')
    if (parts.length < 3) return

    const [appName, title, url] = parts

    // Ignore ROCA itself — keep the previous app info so Claude knows
    // what the user was looking at before switching to ROCA
    if (appName === 'ROCA' || appName === 'Electron') return

    const info: ActiveWindowInfo = {
      app: appName,
      title: title || '',
      url: url || null,
      timestamp: new Date().toISOString(),
    }

    // Only write if something changed (avoid unnecessary disk writes)
    if (lastInfo && lastInfo.app === info.app && lastInfo.title === info.title && lastInfo.url === info.url) {
      // Just update timestamp in memory, write every 30s even if unchanged
      const lastWrite = lastInfo.timestamp
      const elapsed = Date.now() - new Date(lastWrite).getTime()
      if (elapsed < 30_000) return
    }

    lastInfo = info

    try {
      fs.writeFileSync(getFilePath(), JSON.stringify(info, null, 2) + '\n')
    } catch {
      // Non-critical — don't crash the app
    }
  })
}

/**
 * Start polling for the active window.
 * Call once after app is ready.
 */
export function startActiveWindowMonitor(): void {
  if (pollTimer) return
  console.log(`[ActiveWindow] Starting monitor → ${getFilePath()}`)
  poll() // immediate first poll
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
}

/**
 * Stop polling (for cleanup on app quit).
 */
export function stopActiveWindowMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * Get the current active window info (from memory, no disk read).
 */
export function getActiveWindow(): ActiveWindowInfo | null {
  return lastInfo
}

/**
 * Get the file path where active window info is written.
 */
export function getActiveWindowFilePath(): string {
  return getFilePath()
}
