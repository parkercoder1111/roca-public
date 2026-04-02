import * as pty from 'node-pty'
import { WebContents } from 'electron'
import os from 'os'
import { execSync } from 'child_process'

// Flush interval for batching PTY output before sending to the renderer.
// 32ms (~2 frames) coalesces Claude Code's cursor-position + erase + rewrite
// sequences into single IPC messages, reducing visible flicker from status
// bar redraws that would otherwise render an intermediate "erased" state.
const PTY_DATA_FLUSH_MS = 32
const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024 // 2MB per PTY
const SCROLLBACK_SAVE_INTERVAL_MS = 10_000 // Save to disk every 10s
const MIN_PTY_COLS = 2
const MIN_PTY_ROWS = 1

// Environment variables to pass through for agent/tool authentication
const PASSTHROUGH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
]

export type PtyStatus = 'running' | 'needs_input'

interface PtyRecord {
  id: string
  proc: pty.IPty
  buffer: string
  flushTimer: NodeJS.Timeout | null
  owner: WebContents
  scrollback: string
  scrollbackDirty: boolean
  cols: number
  rows: number
  busy: boolean // true = command running, false = at shell prompt
  everBusy: boolean // true once a command has been submitted — gates status visibility
  promptTimer: NodeJS.Timeout | null // debounce timer for prompt detection
  idleTimer: NodeJS.Timeout | null // timeout: transition to idle if no substantial output
  tmuxSession: string | null // tmux session name if using tmux
}

export interface PtyStartResult {
  existing: boolean
  tmuxReattached?: boolean // true if we attached to a surviving tmux session (Claude still alive)
}

// Find tmux binary — Electron's PATH may not include /opt/homebrew/bin
let _tmuxPath: string | null | undefined = undefined // undefined = not checked yet
function getTmuxPath(): string | null {
  if (_tmuxPath !== undefined) return _tmuxPath
  const candidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
  ]
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { stdio: 'ignore' })
      _tmuxPath = p
      console.log(`[PtyManager] Found tmux at: ${p}`)
      return _tmuxPath
    } catch {}
  }
  // Fallback: try PATH
  try {
    const found = execSync('which tmux', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (found) { _tmuxPath = found; return _tmuxPath }
  } catch {}
  _tmuxPath = null
  console.log('[PtyManager] tmux not found — falling back to direct shell')
  return null
}

// Check if a tmux session with the given name exists
function tmuxSessionExists(name: string): boolean {
  const tmux = getTmuxPath()
  if (!tmux) return false
  try {
    execSync(`"${tmux}" has-session -t '${name}' 2>/dev/null`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Sanitize session name for tmux (alphanumeric, dash, underscore only)
function tmuxSessionName(ptyId: string): string {
  return `roca-${ptyId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export class PtyManager {
  private ptys = new Map<string, PtyRecord>()
  private saveTimer: NodeJS.Timeout | null = null
  private saveFn: ((entries: Array<{ ptyId: string; scrollback: string }>) => void) | null = null
  // Remote broadcast callbacks (set by RemoteServer)
  onRemoteData: ((ptyId: string, data: string) => void) | null = null
  onRemoteExit: ((ptyId: string, exitCode: number) => void) | null = null
  // Session lifecycle callback (set from main.ts for conversation history)
  onSessionEnd: ((ptyId: string, scrollback: string) => void) | null = null

  /**
   * Set the function used to persist scrollback to disk (called from main.ts after DB init).
   */
  setSaveFn(fn: (entries: Array<{ ptyId: string; scrollback: string }>) => void) {
    this.saveFn = fn
    // Start periodic flush
    if (!this.saveTimer) {
      this.saveTimer = setInterval(() => this.flushScrollbackToDisk(), SCROLLBACK_SAVE_INTERVAL_MS)
    }
  }

  /**
   * Start a PTY or reconnect to an existing one.
   * Uses tmux for session persistence — Claude sessions survive full app restarts.
   * Returns { existing: true } if PTY was already running in our map (just updates owner).
   * Returns { existing: false, tmuxReattached: true } if tmux session was alive from a prior app session.
   * Returns { existing: false } if completely new.
   */
  start(id: string, owner: WebContents, cwd?: string): PtyStartResult {
    const existing = this.ptys.get(id)
    if (existing) {
      // PTY already running — just update the owner (renderer) reference
      console.log(`[PtyManager] Reconnecting to existing PTY: ${id}`)
      existing.owner = owner
      return { existing: true }
    }

    const shell = process.platform === 'win32'
      ? 'powershell.exe'
      : process.env.SHELL || '/bin/bash'

    const cols = 120
    const rows = 30

    // Build a clean environment instead of inheriting process.env wholesale.
    // Prevents packaging artifacts from breaking user tools.
    const useEnv: Record<string, string> = {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'roca',
      HOME: process.env.HOME || os.homedir(),
      USER: process.env.USER || os.userInfo().username,
      SHELL: process.env.SHELL || shell,
      PATH: process.env.PATH || '',
      ...(process.env.LANG && { LANG: process.env.LANG }),
      ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
      ...(process.env.SSH_AUTH_SOCK && { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
    }

    // Pass through API keys so agent CLIs work
    for (const key of PASSTHROUGH_ENV_VARS) {
      if (process.env[key]) {
        useEnv[key] = process.env[key] as string
      }
    }

    const tmuxBin = getTmuxPath()
    const tmuxName = tmuxBin ? tmuxSessionName(id) : null
    let tmuxReattached = false
    let proc: pty.IPty

    if (tmuxBin && tmuxName && tmuxSessionExists(tmuxName)) {
      // Tmux session survived a full restart — attach to it (Claude is still alive inside)
      // Hide tmux status bar and disable scrollback history
      try {
        execSync(`"${tmuxBin}" set -t '${tmuxName}' status off 2>/dev/null`, { stdio: 'ignore' })
        execSync(`"${tmuxBin}" set -t '${tmuxName}' history-limit 50000 2>/dev/null`, { stdio: 'ignore' })
        execSync(`"${tmuxBin}" set -t '${tmuxName}' mouse on 2>/dev/null`, { stdio: 'ignore' })
      } catch {}
      console.log(`[PtyManager] Reattaching to tmux session: ${tmuxName} (PTY: ${id})`)
      proc = pty.spawn(tmuxBin, ['attach', '-t', tmuxName], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwd || os.homedir(),
        env: useEnv,
      })
      tmuxReattached = true
    } else if (tmuxBin && tmuxName) {
      // Create new tmux session — shell (and future Claude) will survive app restarts
      console.log(`[PtyManager] Creating new tmux session: ${tmuxName} (PTY: ${id})${cwd ? ` (cwd: ${cwd})` : ''}`)
      const tmuxArgs = [
        'new-session', '-s', tmuxName,
        '-x', String(cols), '-y', String(rows),
      ]
      // Set cwd for the tmux session
      if (cwd) tmuxArgs.push('-c', cwd)
      proc = pty.spawn(tmuxBin, tmuxArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwd || os.homedir(),
        env: useEnv,
      })
      // Hide tmux status bar and disable scrollback history
      setTimeout(() => {
        try {
          execSync(`"${tmuxBin}" set -t '${tmuxName}' status off 2>/dev/null`, { stdio: 'ignore' })
          execSync(`"${tmuxBin}" set -t '${tmuxName}' history-limit 50000 2>/dev/null`, { stdio: 'ignore' })
          execSync(`"${tmuxBin}" set -t '${tmuxName}' mouse on 2>/dev/null`, { stdio: 'ignore' })
        } catch {}
      }, 200)
    } else {
      // Fallback: no tmux available — direct shell (original behavior)
      console.log(`[PtyManager] Creating new PTY (no tmux): ${id}${cwd ? ` (cwd: ${cwd})` : ''}`)
      proc = pty.spawn(shell, ['-i'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwd || os.homedir(),
        env: useEnv,
      })
    }

    const record: PtyRecord = {
      id,
      proc,
      buffer: '',
      flushTimer: null,
      owner,
      scrollback: '',
      scrollbackDirty: false,
      cols,
      rows,
      busy: false,
      everBusy: tmuxReattached, // If reattaching, Claude is already running
      promptTimer: null,
      idleTimer: null,
      tmuxSession: tmuxName,
    }

    proc.onData((data: string) => {
      // Accumulate scrollback for reconnection
      record.scrollback += data
      if (record.scrollback.length > MAX_SCROLLBACK_BYTES) {
        record.scrollback = record.scrollback.slice(-MAX_SCROLLBACK_BYTES)
      }
      record.scrollbackDirty = true

      // Busy detection: detect when the terminal is at a prompt (idle) vs. actively outputting.
      //
      // Challenge: Claude Code's status bar continuously emits ANSI escape sequences
      // (cursor moves, color codes, progress updates) even when idle/waiting for input.
      // After ANSI stripping, this status bar text is indistinguishable from real output.
      //
      // Strategy:
      //   1. Shell prompt detected → idle immediately
      //   2. Claude Code status bar / prompt chrome → ignore (not real output)
      //   3. Substantial output (>2 lines or >80 visible chars) → busy + start 15s idle countdown
      //   4. Small output (status bar noise) → ignore, don't touch busy state
      //   5. If no substantial output for 15s, transition to idle (catches Claude Code TUI idle)

      const stripped = data
        .replace(/\x1b\[\?25[hl]/g, '')           // hide/show cursor
        .replace(/\x1b\[s|\x1b\[u/g, '')          // save/restore cursor
        .replace(/\x1b\[\d*[ABCDEFGH]/g, '')       // cursor movement
        .replace(/\x1b\[\d*;\d*[Hf]/g, '')         // cursor positioning
        .replace(/\x1b\[[\d;]*m/g, '')             // color/style codes
        .replace(/\x1b\[\?[\d;]*[a-zA-Z]/g, '')   // private mode sequences
        .replace(/\x1b\[[\d;]*[JK]/g, '')          // erase line/screen
        .replace(/\x1b7|\x1b8/g, '')               // save/restore cursor (alt)
        .replace(/\r/g, '')                         // carriage returns

      const lines = stripped.split('\n')
      const contentLines = lines.filter(l => l.trim().length > 0)
      const lastNonEmpty = contentLines[contentLines.length - 1]

      // Claude Code status bar / prompt chrome — ignore entirely, never counts as output.
      // These lines get redrawn constantly even when idle and can be >80 chars.
      const isStatusBar = (text: string) =>
        /bypass permissions|shift\+tab|ctrl\+o|Press up to edit/i.test(text) ||
        /\b(?:Opus|Sonnet|Haiku)\b.*context/i.test(text) ||
        /[│]\s*(?:Opus|Sonnet|Haiku)\b/i.test(text)

      const isAllStatusBar = contentLines.length > 0 && contentLines.every(l => isStatusBar(l.trim()))

      // When output is ONLY status bar chrome and no idle timer is pending,
      // Claude Code is sitting at its prompt — transition to idle.
      // The status bar redraws constantly when idle but the prompt has no $/%/#/❯
      // character, so the prompt-detection branch never fires.
      if (isAllStatusBar && record.busy && !record.idleTimer) {
        record.busy = false
      }

      if (lastNonEmpty && !isAllStatusBar) {
        const trimmed = lastNonEmpty.trimEnd()

        if (/[$%#❯]\s*$/.test(trimmed)) {
          // Shell prompt → idle immediately
          record.busy = false
          if (record.promptTimer) { clearTimeout(record.promptTimer); record.promptTimer = null }
          if (record.idleTimer) { clearTimeout(record.idleTimer); record.idleTimer = null }
        } else if (contentLines.length > 2 || trimmed.length > 80) {
          // Substantial output → mark busy, restart idle countdown
          if (record.promptTimer) { clearTimeout(record.promptTimer); record.promptTimer = null }
          record.busy = true
          record.everBusy = true
          if (record.idleTimer) clearTimeout(record.idleTimer)
          record.idleTimer = setTimeout(() => {
            record.busy = false
            record.idleTimer = null
          }, 15000)
        }
        // Small output (≤2 short lines): likely status bar noise — don't touch busy state.
        // The idle timer from the last substantial output will fire and transition to idle.
      }

      // Claude Code thinking spinners (e.g. "Wibbling… (14m 27s · 19.2k tokens)")
      // These are small output that doesn't trip the >2-line / >80-char threshold,
      // but indicates Claude is still working. Reset the idle timer so it doesn't
      // falsely transition to needs_input mid-thought.
      const isThinkingSpinner = (text: string) =>
        /\w+…\s*\(.*\d+.*tokens?\)/i.test(text) ||
        /\w+ing\.{3}\s*\(/i.test(text)

      if (record.busy && record.idleTimer && contentLines.some(l => isThinkingSpinner(l.trim()))) {
        clearTimeout(record.idleTimer)
        record.idleTimer = setTimeout(() => {
          record.busy = false
          record.idleTimer = null
        }, 15000)
      }

      // Broadcast to remote clients
      if (this.onRemoteData) this.onRemoteData(id, data)

      record.buffer += data
      if (!record.flushTimer) {
        record.flushTimer = setTimeout(() => {
          if (record.buffer && !record.owner.isDestroyed()) {
            record.owner.send(`pty:data:${id}`, record.buffer)
          }
          record.buffer = ''
          record.flushTimer = null
        }, PTY_DATA_FLUSH_MS)
      }
    })

    proc.onExit(({ exitCode }) => {
      console.log(`[PtyManager] PTY exited: ${id} (code ${exitCode})`)
      // Broadcast exit to remote clients
      if (this.onRemoteExit) this.onRemoteExit(id, exitCode)
      // Flush remaining buffer
      if (record.buffer && !record.owner.isDestroyed()) {
        record.owner.send(`pty:data:${id}`, record.buffer)
        record.buffer = ''
      }
      if (record.flushTimer) {
        clearTimeout(record.flushTimer)
        record.flushTimer = null
      }
      if (record.promptTimer) {
        clearTimeout(record.promptTimer)
        record.promptTimer = null
      }
      if (record.idleTimer) {
        clearTimeout(record.idleTimer)
        record.idleTimer = null
      }
      if (!record.owner.isDestroyed()) {
        record.owner.send(`pty:exit:${id}`, exitCode)
      }
      // Save final scrollback before removing record
      if (this.saveFn && record.scrollback) {
        this.saveFn([{ ptyId: id, scrollback: record.scrollback }])
      }
      // Notify session end for conversation history capture
      if (this.onSessionEnd && record.scrollback) {
        this.onSessionEnd(id, record.scrollback)
      }
      this.ptys.delete(id)
    })

    this.ptys.set(id, record)
    return { existing: false, tmuxReattached }
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  getScrollback(id: string): string {
    return this.ptys.get(id)?.scrollback || ''
  }

  /**
   * Get terminal status for all active PTYs.
   * Returns a map of PTY id → 'running' | 'needs_input'.
   */
  getStatuses(): Record<string, PtyStatus> {
    const result: Record<string, PtyStatus> = {}
    for (const [id, record] of this.ptys) {
      // Only show status once a command has been run — otherwise leave blank
      if (!record.everBusy) continue
      result[id] = record.busy ? 'running' : 'needs_input'
    }
    return result
  }

  write(id: string, data: string) {
    const record = this.ptys.get(id)
    if (record) {
      // Mark busy when user sends a newline (command execution)
      if (data.includes('\r') || data.includes('\n')) {
        record.busy = true
        record.everBusy = true
      }
      record.proc.write(data)
    }
  }

  resize(id: string, cols: number, rows: number) {
    const record = this.ptys.get(id)
    if (!record) return

    const normalizedCols = Number.isFinite(cols) ? Math.max(MIN_PTY_COLS, Math.floor(cols)) : 0
    const normalizedRows = Number.isFinite(rows) ? Math.max(MIN_PTY_ROWS, Math.floor(rows)) : 0
    if (normalizedCols <= 0 || normalizedRows <= 0) return
    if (record.cols === normalizedCols && record.rows === normalizedRows) return

    try {
      record.proc.resize(normalizedCols, normalizedRows)
      record.cols = normalizedCols
      record.rows = normalizedRows
    } catch (error: any) {
      // Expected during shutdown — PTY already exited
      if (
        error?.code === 'EBADF' ||
        /EBADF/.test(String(error)) ||
        /ENOTTY/.test(String(error)) ||
        /ioctl\(2\) failed/.test(String(error)) ||
        error?.message?.includes('not open')
      ) {
        return
      }
      console.error(`[PtyManager] resize failed for ${id}:`, error)
    }
  }

  /**
   * Kill a PTY client. Does NOT kill the tmux session — it persists for reconnection.
   * Use killWithTmux() to also destroy the tmux session.
   */
  kill(id: string) {
    const record = this.ptys.get(id)
    if (record) {
      console.log(`[PtyManager] KILLING PTY: ${id}`)
      if (record.flushTimer) clearTimeout(record.flushTimer)
      if (record.promptTimer) clearTimeout(record.promptTimer)
      if (record.idleTimer) clearTimeout(record.idleTimer)
      record.proc.kill()
      this.ptys.delete(id)
    }
  }

  /**
   * Kill a PTY client AND its tmux session (used when user explicitly kills a task terminal).
   */
  killWithTmux(id: string) {
    const record = this.ptys.get(id)
    if (record?.tmuxSession) {
      const tmux = getTmuxPath()
      if (tmux) {
        try {
          execSync(`"${tmux}" kill-session -t '${record.tmuxSession}' 2>/dev/null`, { stdio: 'ignore' })
          console.log(`[PtyManager] Killed tmux session: ${record.tmuxSession}`)
        } catch {}
      }
    }
    this.kill(id)
  }

  /**
   * Flush all dirty scrollback buffers to disk, then kill all PTY clients.
   * Tmux sessions are preserved — they'll be reattached on next app start.
   * Call this before app quit.
   */
  saveAndKillAll() {
    this.flushScrollbackToDisk()
    if (this.saveTimer) {
      clearInterval(this.saveTimer)
      this.saveTimer = null
    }
    for (const [id] of this.ptys) {
      this.kill(id)
    }
  }

  killAll() {
    this.saveAndKillAll()
  }

  private flushScrollbackToDisk() {
    if (!this.saveFn) return
    const entries: Array<{ ptyId: string; scrollback: string }> = []
    for (const record of this.ptys.values()) {
      if (record.scrollbackDirty && record.scrollback) {
        entries.push({ ptyId: record.id, scrollback: record.scrollback })
        record.scrollbackDirty = false
      }
    }
    if (entries.length > 0) {
      this.saveFn(entries)
    }
  }
}
