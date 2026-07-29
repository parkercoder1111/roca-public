// src/main/ipc-handlers/claude-stream.ts
import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  ensureClaudeStream,
  sendClaudeUserText,
  setClaudeStreamPtyManager,
  stopClaudeStream,
} from '../claude-stream-manager'
import {
  cancelScheduledMessage,
  createScheduledMessage,
  initScheduledMessages,
  listScheduledMessages,
} from '../scheduled-messages'
import type { IpcDeps } from './types'

/**
 * Claude Code's OAuth token — Keychain first (where the CLI keeps it fresh),
 * ~/.claude/.credentials.json as fallback (often stale, but better than nothing).
 */
async function getClaudeOauthToken(): Promise<string | null> {
  const fromKeychain = await new Promise<string | null>((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      (err, stdout) => {
        if (err) return resolve(null)
        try { resolve(JSON.parse(stdout).claudeAiOauth?.accessToken ?? null) }
        catch { resolve(null) }
      })
  })
  if (fromKeychain) return fromKeychain
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')
    return JSON.parse(raw).claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

let usageCache: { at: number; data: unknown } | null = null
const USAGE_CACHE_MS = 60_000

// The TUI's status line is the ground truth for permission mode — transcript
// "permission-mode" lines lag or only appear later, but the screen always
// shows e.g. "⏵⏵ accept edits on (shift+tab to cycle)".
const SCREEN_MODE_PATTERNS: Array<[RegExp, string]> = [
  [/accept edits on/i, 'acceptEdits'],
  [/plan mode on/i, 'plan'],
  [/auto mode on/i, 'auto'],
  [/bypass permissions on/i, 'bypassPermissions'],
  [/don'?t ask on/i, 'dontAsk'],
]

function parseScreenMode(screenTail: string): string {
  for (const [re, mode] of SCREEN_MODE_PATTERNS) {
    if (re.test(screenTail)) return mode
  }
  return 'default'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function registerClaudeStreamHandlers(deps: IpcDeps): void {
  setClaudeStreamPtyManager(deps.ptyManager)
  initScheduledMessages(deps.ptyManager)

  ipcMain.handle('claude-stream:start', (e, ptyId: string, cwd: string) => {
    ensureClaudeStream(ptyId, cwd, e.sender)
    return { ok: true }
  })

  ipcMain.handle('claude-stream:send', (_, ptyId: string, text: string) => {
    return { ok: sendClaudeUserText(ptyId, text) }
  })

  ipcMain.handle('claude-stream:stop', (_, ptyId: string) => {
    stopClaudeStream(ptyId)
    return { ok: true }
  })

  // Plan usage (the numbers behind claude's /usage) for the footer popover.
  ipcMain.handle('claude-stream:usage', async () => {
    if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) {
      return { ok: true, data: usageCache.data }
    }
    const token = await getClaudeOauthToken()
    if (!token) return { ok: false, error: 'no Claude credentials found' }
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      })
      if (!res.ok) return { ok: false, error: `usage endpoint returned ${res.status}` }
      const data = await res.json()
      usageCache = { at: Date.now(), data }
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Switch the terminal TUI's permission mode by pressing shift+tab and
  // reading the status line off the screen after each press. Stops when the
  // target shows up, or when the cycle laps back to where it started (the
  // mode isn't enabled for this session).
  ipcMain.handle('claude-stream:set-permission-mode', async (e, ptyId: string, target: string) => {
    const readMode = () => {
      const screen = deps.ptyManager.captureRenderedText(ptyId)
      const tail = screen.trimEnd().split('\n').slice(-8).join('\n')
      return parseScreenMode(tail)
    }
    let mode = readMode()
    const startMode = mode
    if (mode !== target) {
      for (let press = 1; press <= 10; press++) {
        deps.ptyManager.write(ptyId, '\x1b[Z')
        await sleep(350)
        mode = readMode()
        if (mode === target) break
        // Lapped the cycle without finding the target → it's not available.
        if (mode === startMode && press >= 2) break
      }
    }
    if (!e.sender.isDestroyed()) {
      e.sender.send(`claude-stream:event:${ptyId}`, { type: 'permission-mode', permissionMode: mode })
    }
    return { ok: mode === target, mode }
  })

  // Scheduled messages (clock button in the chat input).
  ipcMain.handle('claude-schedule:create', (_, ptyId: string, text: string, sendAtMs: number) => {
    if (!text.trim() || !Number.isFinite(sendAtMs)) return { ok: false }
    return { ok: true, item: createScheduledMessage(ptyId, text, sendAtMs) }
  })

  ipcMain.handle('claude-schedule:list', (_, ptyId: string) => {
    return { ok: true, items: listScheduledMessages(ptyId) }
  })

  ipcMain.handle('claude-schedule:cancel', (_, id: string) => {
    return { ok: cancelScheduledMessage(id) }
  })
}
