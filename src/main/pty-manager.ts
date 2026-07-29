import * as pty from 'node-pty'
import { WebContents } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { pickPtyIdForTask } from './helpers/pty-id'
import { pickSessionByBirthtime, type SessionCandidate } from './helpers/pick-session-by-birthtime'
import { resolveLiveTmuxSession } from './helpers/live-tmux-session'

// Flush interval for batching PTY output before sending to the renderer.
// Tight enough that keystroke echoes don't visibly trail the cursor (~8ms is
// roughly half a paint frame). The renderer-side rAF coalesces same-frame
// chunks for status-bar redraws, so we don't need a wide window here.
const PTY_DATA_FLUSH_MS = 8
const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024 // 2MB per PTY
const SCROLLBACK_SAVE_INTERVAL_MS = 10_000 // Save to disk every 10s
const MIN_PTY_COLS = 2
const MIN_PTY_ROWS = 1

// ── Claude auto-revive watcher ──
// ROCA task terminals are tmux sessions with `claude` running inside a
// persistent shell. When claude exits (crash, error, killed) the shell
// survives, so the pty itself never "exits" — the tab just shows a bare
// prompt with no signal, and the user has to re-run `claude` by hand. This
// watcher notices claude vanishing from a pane it had been running in,
// records why (for root-causing the recurring deaths), and relaunches it
// resuming the same conversation.
const CLAUDE_WATCH_INTERVAL_MS = 15_000    // how often each session is checked for claude liveness
const CLAUDE_MIN_RUNTIME_MS = 120_000      // claude must have run this long before a death auto-revives (crash-loop guard)
const CLAUDE_INTENTIONAL_EXIT_MS = 6_000   // a death this soon after user input reads as an intentional /exit — don't revive
const CLAUDE_MAX_REVIVES_PER_HOUR = 6      // stop reviving a session that keeps dying, so it can't spin
const CLAUDE_SID_SAMPLE_MS = 60_000        // re-sample the resumable session id at most this often while claude runs

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
  // Host this pty is talking to ('local' or an SSH alias). Used by the
  // exit-handler to decide whether to surface a connect-error diagnostic.
  host: string
  // Wall-clock spawn time. A remote pty that dies within the first few
  // seconds almost always means mosh/ssh couldn't reach the host — we
  // print a friendly hint into the terminal in that window.
  spawnedAt: number
  // ── Claude liveness / auto-revive (see CLAUDE_WATCH_* above) ──
  claudeSeen: boolean          // claude has been observed running in this pane at least once
  claudeRunning: boolean       // claude's liveness at the last watcher tick
  claudeStartedAt: number      // when the current claude instance was first seen running
  claudeSessionId: string | null // latest resumable Claude Code session id, sampled while running
  lastSidSampleAt: number      // throttle for the (lsof-heavy) session-id sampling
  lastInputAt: number          // last write to this pty — distinguishes an intentional /exit from a crash
  reviveTimes: number[]        // recent auto-revive timestamps (rolling 1h) — rate-limits reviving
  bypassPermissions: boolean   // relaunch claude with --dangerously-skip-permissions to match the tab's launch policy
}

// Claude Code persists each conversation as ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// The encoding replaces '/' and '.' with '-'. Missing the dot case silently breaks tracking
// for any cwd containing a dot.
function claudeProjectDirForCwd(cwd: string): string {
  const encoded = cwd.replace(/[/.]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encoded)
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

// Marker-file directory the /opt/homebrew/bin/claude wrapper checks to know
// which tmux sessions explicitly picked "Local" in ROCA's host picker.
//
// Env vars are unreliable here: tmux's server inherits its env from the
// FIRST tmux process to start it, so subsequent `tmux new-session` calls
// don't propagate the spawning process's env to the shell. Marker files
// are read at `claude` invocation time and always reflect ground truth.
const LOCAL_PTY_MARKER_DIR = '/tmp/roca-local-ptys'

function writeLocalPtyMarker(ptyId: string): void {
  try {
    if (!fs.existsSync(LOCAL_PTY_MARKER_DIR)) {
      fs.mkdirSync(LOCAL_PTY_MARKER_DIR, { recursive: true })
    }
    const sessionName = tmuxSessionName(ptyId)
    // Wrapper extracts TASK_ID = session_name with the `roca-` prefix
    // stripped — the marker file must match that exact basename.
    fs.writeFileSync(path.join(LOCAL_PTY_MARKER_DIR, sessionName.replace(/^roca-/, '')), '')
  } catch (e) {
    console.warn(`[PtyManager] Could not write local-pty marker for ${ptyId}:`, e)
  }
}

function clearLocalPtyMarker(ptyId: string): void {
  try {
    const sessionName = tmuxSessionName(ptyId)
    fs.unlinkSync(path.join(LOCAL_PTY_MARKER_DIR, sessionName.replace(/^roca-/, '')))
  } catch { /* missing is fine */ }
}

export class PtyManager {
  private ptys = new Map<string, PtyRecord>()
  private saveTimer: NodeJS.Timeout | null = null
  private saveFn: ((entries: Array<{ ptyId: string; scrollback: string }>) => void) | null = null
  // Claude auto-revive watcher (started via enableClaudeRevive from main.ts).
  private claudeWatchTimer: NodeJS.Timeout | null = null
  private deathLogPath: string | null = null
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
   * If `host` is set and not 'local', spawns mosh to a remote SSH alias with
   * server-side tmux for persistence (local tmux is bypassed in that case).
   * Returns { existing: true } if PTY was already running in our map (just updates owner).
   * Returns { existing: false, tmuxReattached: true } if tmux session was alive from a prior app session.
   * Returns { existing: false } if completely new.
   */
  start(id: string, owner: WebContents, cwd?: string, host?: string, bypassPermissions = false): PtyStartResult {
    const existing = this.ptys.get(id)
    if (existing) {
      // PTY already running — just update the owner (renderer) reference
      console.log(`[PtyManager] Reconnecting to existing PTY: ${id}`)
      existing.owner = owner
      return { existing: true }
    }

    const isRemote = !!host && host !== 'local'

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
      CLAUDE_CODE_NO_FLICKER: '1',
    }

    // Pass through API keys so agent CLIs work
    for (const key of PASSTHROUGH_ENV_VARS) {
      if (process.env[key]) {
        useEnv[key] = process.env[key] as string
      }
    }

    // Tell the /opt/homebrew/bin/claude wrapper that this tab explicitly
    // picked Local — otherwise it sees the roca-* tmux name and routes
    // `claude` invocations to the VM, which is exactly what "Local" must not do.
    //
    // Two channels because env-var inheritance through an already-running
    // tmux server is unreliable; the marker file is the source of truth.
    if (!isRemote) {
      useEnv.ROCA_FORCE_LOCAL_CLAUDE = '1'
      writeLocalPtyMarker(id)
    }

    const tmuxBin = isRemote ? null : getTmuxPath()
    const tmuxName = tmuxBin ? tmuxSessionName(id) : null
    let tmuxReattached = false
    let proc: pty.IPty

    if (isRemote) {
      // Remote: spawn mosh to the SSH alias, then exec a server-side tmux
      // session named the same as the local convention (`roca-<ptyId>`).
      // `new-session -A` attaches if it already exists, so closing the laptop
      // + reopening the tab reattaches the live tmux instead of starting fresh.
      // Locale exports are critical — without them mosh-server complains about
      // an unsupported locale and falls back to ASCII, which breaks Claude's TUI.
      const moshBin = '/opt/homebrew/bin/mosh'
      const remoteTmuxName = tmuxSessionName(id)
      const quotedCwd = cwd ? cwd.replace(/'/g, "'\\''") : ''
      const cdPart = quotedCwd ? `cd '${quotedCwd}' 2>/dev/null; ` : ''
      // Force en_US.UTF-8 in the remote shell. Ubuntu defaults to C.UTF-8
      // which lacks the per-locale data Claude Code uses to render bullets
      // (●), spinners, and box-drawing glyphs — they fall back to ASCII
      // underscores and the TUI looks busted.
      const remoteCmd = `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; ${cdPart}exec tmux new-session -A -s '${remoteTmuxName}' bash -l`
      console.log(`[PtyManager] Spawning mosh to ${host} (PTY: ${id}, remote tmux: ${remoteTmuxName})`)
      proc = pty.spawn(moshBin, ['--predict=always', host as string, '--', 'bash', '-lc', remoteCmd], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME || os.homedir(),
        env: { ...useEnv, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      })
    } else if (tmuxBin && tmuxName && tmuxSessionExists(tmuxName)) {
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
      host: isRemote ? (host as string) : 'local',
      spawnedAt: Date.now(),
      // Claude liveness starts unknown — the watcher observes ground truth on
      // its next tick rather than assuming a reattached session is alive.
      claudeSeen: false,
      claudeRunning: false,
      claudeStartedAt: 0,
      claudeSessionId: null,
      lastSidSampleAt: 0,
      lastInputAt: 0,
      reviveTimes: [],
      bypassPermissions,
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

      // Surface SSH/mosh connect failures right in the terminal. A remote
      // pty that dies in the first 5 seconds almost always means mosh
      // couldn't reach the host — without this, the user just sees an empty
      // terminal close itself with no clue why.
      const isRemoteExit = record.host !== 'local'
      const elapsedMs = Date.now() - record.spawnedAt
      if (isRemoteExit && elapsedMs < 5000 && !record.owner.isDestroyed()) {
        const RED = '\x1b[31m'
        const DIM = '\x1b[2m'
        const RESET = '\x1b[0m'
        const lines = [
          ``,
          `${RED}✗ Couldn't connect to '${record.host}' (mosh exited with code ${exitCode} after ${elapsedMs}ms).${RESET}`,
          ``,
          `${DIM}Quick checks:${RESET}`,
          `${DIM}  • SSH alias exists?      ssh -G ${record.host} | head -1${RESET}`,
          `${DIM}  • Host reachable?        ssh ${record.host} echo ok${RESET}`,
          `${DIM}  • mosh-server installed? ssh ${record.host} which mosh-server${RESET}`,
          `${DIM}  • UDP 60000-61000 open?  (mosh needs UDP, not just SSH/TCP)${RESET}`,
          ``,
        ].join('\r\n')
        record.owner.send(`pty:data:${id}`, lines)
      }

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
      if (record.host === 'local') clearLocalPtyMarker(id)
      this.ptys.delete(id)
    })

    this.ptys.set(id, record)
    return { existing: false, tmuxReattached }
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  /**
   * Map a numeric task id onto the live pty backing its terminal. The renderer
   * names task ptys `task-<id>-<tabId>` now, so RPC/voice callers that only know
   * the task id can't address the pty directly — this resolves it (exact
   * `task-<id>`, else the most-recently-spawned `task-<id>-*` tab). Returns null
   * when the task has no live terminal.
   */
  resolvePtyIdForTask(taskId: string): string | null {
    const ptys = Array.from(this.ptys.values()).map(r => ({ id: r.id, spawnedAt: r.spawnedAt }))
    return pickPtyIdForTask(taskId, ptys)
  }

  getScrollback(id: string): string {
    return this.ptys.get(id)?.scrollback || ''
  }

  /**
   * The live tmux session backing this pty id, from the in-memory record when
   * present, else the durable `roca-<id>` session if `tmux ls` still shows it —
   * so Fork/Mirror see the same live panes the mirror picker does, even for a
   * pane whose record hasn't been rebuilt since a restart. See
   * `resolveLiveTmuxSession`.
   */
  private liveTmuxSession(id: string): string | null {
    const name = tmuxSessionName(id)
    return resolveLiveTmuxSession(
      this.ptys.get(id)?.tmuxSession,
      name,
      () => tmuxSessionExists(name),
    )
  }

  /**
   * Locate the Claude Code session UUID that the pane's live Claude process is writing.
   * Correlates the pane's Claude child PID start time to a JSONL birthtime in the
   * cwd's project dir — deterministic even when 20+ Claude sessions share the cwd
   * (which makes the "most recently modified" heuristic misattribute to whichever
   * session happened to flush last).
   *
   * Returns null if no Claude is running in the pane, or if no JSONL is a clear
   * enough birthtime match to trust (see pickSessionByBirthtime). Callers should
   * fall back to forkClaudeSession.
   */
  getClaudeSessionId(id: string): string | null {
    const session = this.liveTmuxSession(id)
    if (!session) return null
    const tmux = getTmuxPath()
    if (!tmux) return null
    try {
      const shellPid = execSync(
        `"${tmux}" display-message -p -t '${session}' '#{pane_pid}' 2>/dev/null`
      ).toString().trim()
      if (!shellPid) return null
      const claudePid = execSync(`pgrep -P ${shellPid} claude 2>/dev/null | head -1`).toString().trim()
      if (!claudePid) return null
      const startRaw = execSync(`ps -p ${claudePid} -o lstart= 2>/dev/null`).toString().trim()
      if (!startRaw) return null
      const claudeStartMs = new Date(startRaw).getTime()
      if (!Number.isFinite(claudeStartMs)) return null
      // Use Claude's actual cwd (via lsof on its cwd file descriptor) rather than the
      // pane's launch cwd — the user may have cd'd before running claude, and Claude's
      // JSONL lives under the project dir of its own cwd, not the shell's original cwd.
      const claudeCwd = execSync(
        `lsof -a -p ${claudePid} -d cwd 2>/dev/null | tail -1 | awk '{print $NF}'`
      ).toString().trim()
      if (!claudeCwd) return null

      const dir = claudeProjectDirForCwd(claudeCwd)
      if (!fs.existsSync(dir)) return null
      const candidates: SessionCandidate[] = []
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const stat = fs.statSync(path.join(dir, name))
        // birthtime = creation time; on macOS this is the actual file-create timestamp
        candidates.push({ uuid: name.replace(/\.jsonl$/, ''), birthMs: stat.birthtimeMs || stat.ctimeMs })
      }
      return pickSessionByBirthtime(candidates, claudeStartMs)
    } catch {
      return null
    }
  }

  /**
   * The session id last sampled from this pane's Claude while it was alive (the
   * same value the auto-revive watcher uses to `--resume` the exact conversation).
   * Preferred over a fresh getClaudeSessionId() probe when Claude has since been
   * revived: a revived process's start time no longer matches its resumed JSONL's
   * birthtime, so the live probe fails — but this cached id, captured before the
   * death, still points at the right conversation. null if never sampled.
   */
  getTrackedClaudeSessionId(id: string): string | null {
    return this.ptys.get(id)?.claudeSessionId ?? null
  }

  /**
   * True when this pane's Claude is running on a REMOTE host — i.e. the pane's
   * foreground command is a mosh/ssh client (ROCA's VM-routing wrapper moshes
   * task terminals to a remote host). A remote Claude has no local process for
   * getClaudeSessionId to find, so the optical view can't mirror it: the caller
   * should refuse to fork a *local* Claude (which would show a different
   * conversation) and point the user at the Terminal tab instead.
   *
   * Best-effort and conservative: only returns true on a confident mosh/ssh
   * match. Any ambiguity (no tmux, lookup fails, plain shell) returns false so
   * behavior is unchanged for every local pane.
   */
  isPaneRemote(id: string): boolean {
    const session = this.liveTmuxSession(id)
    if (!session) return false
    const tmux = getTmuxPath()
    if (!tmux) return false
    try {
      const cmd = execSync(
        `"${tmux}" display-message -p -t '${session}' '#{pane_current_command}' 2>/dev/null`
      ).toString().trim()
      return /^(mosh|mosh-client|ssh)$/.test(cmd)
    } catch {
      return false
    }
  }

  /**
   * Return the cwd of the Claude process running in this pane (via lsof), if any.
   * Preferred over getPaneCwd() at fork time — Claude's own cwd is the project-dir
   * source of truth, and the pane's shell may have cd'd elsewhere since launch.
   */
  getClaudeCwd(id: string): string | null {
    const session = this.liveTmuxSession(id)
    if (!session) return null
    const tmux = getTmuxPath()
    if (!tmux) return null
    try {
      const shellPid = execSync(
        `"${tmux}" display-message -p -t '${session}' '#{pane_pid}' 2>/dev/null`
      ).toString().trim()
      if (!shellPid) return null
      const claudePid = execSync(`pgrep -P ${shellPid} claude 2>/dev/null | head -1`).toString().trim()
      if (!claudePid) return null
      const claudeCwd = execSync(
        `lsof -a -p ${claudePid} -d cwd 2>/dev/null | tail -1 | awk '{print $NF}'`
      ).toString().trim()
      return claudeCwd || null
    } catch {
      return null
    }
  }

  /**
   * Get the current working directory of a PTY's tmux pane (follows shell cd's).
   * Returns null if no tmux session or the query fails.
   */
  getPaneCwd(id: string): string | null {
    const session = this.liveTmuxSession(id)
    if (!session) return null
    const tmux = getTmuxPath()
    if (!tmux) return null
    try {
      const cwd = execSync(
        `"${tmux}" display-message -p -t '${session}' '#{pane_current_path}' 2>/dev/null`
      ).toString().trim()
      return cwd || null
    } catch {
      return null
    }
  }

  /**
   * Capture rendered terminal text via tmux capture-pane.
   * Returns properly spaced text (unlike raw scrollback which loses cursor-positioned spaces).
   * Falls back to raw scrollback if tmux capture fails.
   */
  captureRenderedText(id: string): string {
    const record = this.ptys.get(id)
    if (!record?.tmuxSession) return record?.scrollback || ''
    const tmux = getTmuxPath()
    if (!tmux) return record.scrollback || ''
    try {
      // -p prints to stdout, -S - starts from beginning of scrollback, -E - ends at bottom
      const text = execSync(
        `"${tmux}" capture-pane -p -S - -E - -t '${record.tmuxSession}' 2>/dev/null`,
        { maxBuffer: 10 * 1024 * 1024 }
      ).toString()
      return text || record.scrollback || ''
    } catch {
      return record.scrollback || ''
    }
  }

  /**
   * Get terminal status for all active PTYs.
   * Returns a map of PTY id → 'running' | 'needs_input'.
   */
  /**
   * Every live ROCA-owned tmux session, returned as the original ptyId
   * (the `roca-` prefix stripped). Covers main task tabs (`task-<id>`),
   * sub-tabs (`task-<id>-<suffix>`), the assistant (`task-assistant`) and
   * assistant sub-tabs (`task-assistant-<suffix>`). Used by the mirror
   * picker so any live tab — not just main task tabs — is mirrorable.
   */
  getLivePtyIds(): string[] {
    const tmux = getTmuxPath()
    if (!tmux) return []
    try {
      const out = execSync(`"${tmux}" ls -F '#{session_name}' 2>/dev/null`).toString()
      const ids: string[] = []
      for (const line of out.split('\n')) {
        const m = line.match(/^roca-(.+)$/)
        if (m) ids.push(m[1])
      }
      return ids
    } catch {
      return []
    }
  }

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
      // Timestamp every write so the revive watcher can tell an intentional
      // /exit (claude dies right after a keystroke) from a crash (dies idle).
      record.lastInputAt = Date.now()
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
      if (record.host === 'local') clearLocalPtyMarker(id)
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
    if (this.claudeWatchTimer) {
      clearInterval(this.claudeWatchTimer)
      this.claudeWatchTimer = null
    }
    for (const [id] of this.ptys) {
      this.kill(id)
    }
  }

  killAll() {
    this.saveAndKillAll()
  }

  /**
   * Rename a tmux session from one PTY ID to another.
   * Used during week rollover to transfer sessions from old task IDs to new ones.
   */
  renameTmuxSession(oldPtyId: string, newPtyId: string): boolean {
    const tmux = getTmuxPath()
    if (!tmux) return false
    const oldName = tmuxSessionName(oldPtyId)
    const newName = tmuxSessionName(newPtyId)
    if (!tmuxSessionExists(oldName)) return false
    try {
      execSync(`"${tmux}" rename-session -t '${oldName}' '${newName}' 2>/dev/null`, { stdio: 'ignore' })
      console.log(`[PtyManager] Renamed tmux session: ${oldName} → ${newName}`)
      return true
    } catch {
      return false
    }
  }

  /**
   * Kill orphaned tmux sessions by name (for sessions not in the in-memory map).
   * Used by the startup/periodic sweep to clean up old completed task sessions.
   */
  killOrphanedTmuxSession(ptyId: string): boolean {
    const tmux = getTmuxPath()
    if (!tmux) return false
    const sessionName = tmuxSessionName(ptyId)
    if (!tmuxSessionExists(sessionName)) return false
    try {
      execSync(`"${tmux}" kill-session -t '${sessionName}' 2>/dev/null`, { stdio: 'ignore' })
      console.log(`[PtyManager] Cleaned up orphaned tmux session: ${sessionName}`)
      return true
    } catch {
      return false
    }
  }

  // ═══════════════════════════════════════════
  //  CLAUDE AUTO-REVIVE
  // ═══════════════════════════════════════════

  /**
   * Start watching every local tmux-backed session for its inner `claude`
   * process dying, so a crashed claude gets logged and relaunched instead of
   * silently leaving a bare shell the user has to notice and restart by hand.
   * `deathLogPath` receives one JSON line per death (for root-causing).
   */
  enableClaudeRevive(deathLogPath: string) {
    this.deathLogPath = deathLogPath
    if (!this.claudeWatchTimer) {
      this.claudeWatchTimer = setInterval(() => this.checkClaudeLiveness(), CLAUDE_WATCH_INTERVAL_MS)
    }
  }

  // Map of tmux session name → its pane's shell pid, for every live session,
  // in one exec. Claude-liveness is then decided in-process rather than with
  // an exec per session (which would stall the main thread with many tabs).
  private readPaneShellPids(): Map<string, string> {
    const map = new Map<string, string>()
    const tmux = getTmuxPath()
    if (!tmux) return map
    try {
      const out = execSync(`"${tmux}" list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null`).toString()
      for (const line of out.split('\n')) {
        const [name, pid] = line.split(' ')
        if (name && pid) map.set(name, pid)
      }
    } catch {}
    return map
  }

  // The set of pids that have a `claude` process as a direct child, from one
  // `ps` snapshot. A pane's shell pid being in this set means claude is alive
  // in that pane. (Sub-agent claudes parent to the main claude, not the shell,
  // so they can't produce a false positive for our sessions.)
  private readShellPidsRunningClaude(): Set<string> {
    const parents = new Set<string>()
    try {
      const out = execSync(`ps -Ao ppid=,comm= 2>/dev/null`).toString()
      for (const line of out.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const sp = trimmed.indexOf(' ')
        if (sp < 0) continue
        const ppid = trimmed.slice(0, sp)
        const comm = trimmed.slice(sp + 1)
        // macOS `comm` is the full executable path; match the claude binary.
        if (comm === 'claude' || comm.endsWith('/claude')) parents.add(ppid)
      }
    } catch {}
    return parents
  }

  private checkClaudeLiveness() {
    const paneShellPids = this.readPaneShellPids()
    if (paneShellPids.size === 0) return
    const shellsRunningClaude = this.readShellPidsRunningClaude()
    const now = Date.now()
    let sampledSidThisTick = false // bound the lsof-heavy session-id sampling to one session per tick

    for (const record of this.ptys.values()) {
      // Only local tmux panes can be inspected + relaunched. Remote (mosh)
      // panes run claude on the far host where our ps snapshot can't see it.
      if (!record.tmuxSession || record.host !== 'local') continue
      const shellPid = paneShellPids.get(record.tmuxSession)
      const running = !!shellPid && shellsRunningClaude.has(shellPid)

      if (running) {
        if (!record.claudeRunning) {
          record.claudeRunning = true
          record.claudeStartedAt = now
        }
        record.claudeSeen = true
        // Keep a fresh resumable session id on hand so a future revive can
        // --resume the exact conversation rather than guess with --continue.
        if (!sampledSidThisTick &&
            (!record.claudeSessionId || now - record.lastSidSampleAt > CLAUDE_SID_SAMPLE_MS)) {
          sampledSidThisTick = true
          record.lastSidSampleAt = now
          const sid = this.getClaudeSessionId(record.id)
          if (sid) record.claudeSessionId = sid
        }
      } else if (record.claudeRunning) {
        // Was running last tick, gone now → claude just died.
        record.claudeRunning = false
        this.onClaudeDied(record, record.claudeStartedAt ? now - record.claudeStartedAt : 0)
      }
    }
  }

  private onClaudeDied(record: PtyRecord, ranMs: number) {
    const now = Date.now()
    const intentional = now - record.lastInputAt < CLAUDE_INTENTIONAL_EXIT_MS // died right after a keystroke → likely /exit
    const tooShort = ranMs < CLAUDE_MIN_RUNTIME_MS                            // crashed almost immediately → don't spin
    record.reviveTimes = record.reviveTimes.filter(t => now - t < 60 * 60 * 1000)
    const rateLimited = record.reviveTimes.length >= CLAUDE_MAX_REVIVES_PER_HOUR
    const willRevive = record.claudeSeen && !intentional && !tooShort && !rateLimited

    this.logClaudeDeath(record, ranMs, { intentional, tooShort, rateLimited, willRevive })
    if (willRevive) this.reviveClaude(record)
  }

  // Append one JSON line per death, including the tail of the pane so a claude
  // that printed an error before dying leaves a trace to diagnose from.
  private logClaudeDeath(record: PtyRecord, ranMs: number, decision: Record<string, boolean>) {
    console.log(`[PtyManager] claude exited in ${record.id} after ${Math.round(ranMs / 1000)}s — revive=${decision.willRevive}`)
    if (!this.deathLogPath) return
    let paneTail = ''
    try {
      paneTail = this.captureRenderedText(record.id)
        .split('\n').map(l => l.trimEnd()).filter(l => l).slice(-20).join('\n')
    } catch {}
    const entry = {
      ts: new Date().toISOString(),
      ptyId: record.id,
      host: record.host,
      ranSeconds: Math.round(ranMs / 1000),
      claudeSessionId: record.claudeSessionId,
      decision,
      paneTail,
    }
    try {
      fs.appendFileSync(this.deathLogPath, JSON.stringify(entry) + '\n')
    } catch (e) {
      console.warn('[PtyManager] Could not write claude-death log:', e)
    }
  }

  private reviveClaude(record: PtyRecord) {
    const perm = record.bypassPermissions ? ' --dangerously-skip-permissions' : ''
    // --resume the known session id (exact conversation); fall back to
    // --continue (most recent conversation in the cwd) if we never captured one.
    const cmd = record.claudeSessionId
      ? `claude --resume ${record.claudeSessionId}${perm}`
      : `claude --continue${perm}`
    record.reviveTimes.push(Date.now())
    // Breadcrumb so the relaunch isn't a mysterious self-typing terminal.
    if (!record.owner.isDestroyed()) {
      record.owner.send(`pty:data:${record.id}`, `\r\n\x1b[2m[ROCA] Claude exited — reviving session…\x1b[0m\r\n`)
    }
    // Ctrl-U clears any half-typed line first; write() refreshes lastInputAt,
    // so an immediate re-death is treated as intentional and won't loop.
    this.write(record.id, '\x15' + cmd + '\r')
    console.log(`[PtyManager] Reviving claude in ${record.id}: ${cmd}`)
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
