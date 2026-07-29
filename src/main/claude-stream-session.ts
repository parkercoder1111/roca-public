// src/main/claude-stream-session.ts
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { WebContents } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseStreamLine, type StreamJsonEvent } from '../shared/stream-json-events'
import { findClaudeBinarySync } from './utils/find-claude-binary'
import { randomUUID } from 'crypto'

// Claude Code stores conversations at ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// Encoding replaces '/' and '.' with '-'. Mirrors the helper in pty-manager.ts.
export function claudeProjectDirForCwd(cwd: string): string {
  const encoded = cwd.replace(/[/.]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encoded)
}

/** Find the most-recently-modified JSONL session file in the project dir. */
function findRecentSessionForCwd(cwd: string): { sessionId: string; jsonlPath: string } | null {
  try {
    const dir = claudeProjectDirForCwd(cwd)
    if (!fs.existsSync(dir)) return null
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(dir, f)
        return { p, mtimeMs: fs.statSync(p).mtimeMs, uuid: f.replace(/\.jsonl$/, '') }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (files.length === 0) return null
    return { sessionId: files[0].uuid, jsonlPath: files[0].p }
  } catch {
    return null
  }
}

/** Read the JSONL session file and return its event lines (filtering out anything unparseable). */
function loadSessionHistory(jsonlPath: string): StreamJsonEvent[] {
  try {
    const raw = fs.readFileSync(jsonlPath, 'utf8')
    const events: StreamJsonEvent[] = []
    for (const line of raw.split('\n')) {
      const ev = parseStreamLine(line)
      if (ev) events.push(ev)
    }
    return events
  } catch {
    return []
  }
}

interface ClaudeStreamOptions {
  ptyId: string         // matches the existing per-task identifier
  sessionId?: string    // existing claude session UUID (resume); generate if absent
  cwd: string
  owner: WebContents
  // Reports the session UUID claude actually runs under. When resuming with
  // --fork-session that differs from opts.sessionId — the manager needs the
  // forked UUID so the *next* resume continues this conversation, not the
  // pre-fork one (which would drop everything said in optical view since).
  onSessionId?: (sessionId: string) => void
  // The task's opening turn (context + "Help me with this task"), delivered
  // once when the session spawns fresh — the headless equivalent of the
  // terminal's `cat context | claude "..."` launch. Skipped when resuming an
  // existing JSONL, which already contains its own opening turn.
  openingMessage?: string
  // Explicit new(false)/resume(true) control. When set (with sessionId), it
  // overrides the recency-based derivation below. Used by the voice brain,
  // which owns its own session lifecycle via VoiceSessionManager.
  resumeFrom?: boolean
  // Override the model (e.g. a faster one for voice). Omit = inherit default.
  model?: string
  // Extra system-prompt text appended to the session (e.g. voice-style rules).
  appendSystemPrompt?: string
  // Permission mode passed to claude. Default 'acceptEdits'; voice uses
  // 'bypassPermissions' so a headless session never stalls on a prompt.
  permissionMode?: string
}

export class ClaudeStreamSession {
  readonly ptyId: string
  readonly sessionId: string
  private readonly cwd: string
  // True when sessionId points to an existing JSONL we want to resume from.
  // Drives --resume + --fork-session vs --session-id at spawn time.
  private readonly resumeFrom: boolean
  private owner: WebContents
  private readonly onSessionId?: (sessionId: string) => void
  private readonly openingMessage?: string
  private readonly model?: string
  private readonly appendSystemPrompt?: string
  private readonly permissionMode: string
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private exited = false
  // Turn ordinals let a consumer tell which user turn a given event belongs to.
  // Claude processes turns strictly in order and emits exactly one `result` per
  // user message, so `turnsCompleted` (results seen so far) is the ordinal of the
  // turn currently generating. The voice renderer uses this to discard a prior,
  // barged-in turn's late events instead of speaking them in the next turn.
  private turnsSent = 0
  private turnsCompleted = 0

  constructor(opts: ClaudeStreamOptions) {
    this.ptyId = opts.ptyId
    const hasRealCwd = !!(opts.cwd && opts.cwd.trim().length > 0)
    this.cwd = hasRealCwd ? opts.cwd : os.homedir()
    // If an explicit sessionId wasn't passed, try to resume the most recent
    // session in this cwd — that's the conversation the user has open in
    // terminal view, so optical view picks up the same context. Only resume by
    // recency when we have a real project cwd: with no cwd we fall back to the
    // home dir, whose most-recent transcript is some unrelated past
    // conversation — resuming it would surface stale history in a brand-new
    // session. Start fresh instead.
    if (opts.sessionId && opts.resumeFrom !== undefined) {
      // Explicit lifecycle control (voice brain): trust the caller's id + intent.
      this.sessionId = opts.sessionId
      this.resumeFrom = opts.resumeFrom
    } else if (opts.sessionId) {
      this.sessionId = opts.sessionId
      this.resumeFrom = true
    } else if (opts.openingMessage) {
      // A brand-new task being kicked off — always a fresh conversation. Never
      // resume by recency here: Development tasks all share the ROCA repo cwd,
      // so the most-recent transcript is almost always a *different* task's
      // session (or this fix's own), which we'd otherwise hijack instead of
      // starting the new task.
      this.sessionId = randomUUID()
      this.resumeFrom = false
    } else {
      const recent = hasRealCwd ? findRecentSessionForCwd(this.cwd) : null
      if (recent) {
        this.sessionId = recent.sessionId
        this.resumeFrom = true
      } else {
        this.sessionId = randomUUID()
        this.resumeFrom = false
      }
    }
    this.owner = opts.owner
    this.onSessionId = opts.onSessionId
    this.openingMessage = opts.openingMessage
    this.model = opts.model
    this.appendSystemPrompt = opts.appendSystemPrompt
    this.permissionMode = opts.permissionMode ?? 'acceptEdits'
  }

  start(): void {
    const bin = findClaudeBinarySync()
    if (!bin) {
      console.error(`[ClaudeStream ${this.ptyId}] claude binary not found`)
      if (!this.owner.isDestroyed()) {
        this.owner.send(`claude-stream:error:${this.ptyId}`, 'claude binary not found')
      }
      return
    }
    // When resuming an existing JSONL we must --fork-session, because the
    // terminal view's PTY may still own the original session UUID and claude
    // refuses to attach two processes to the same session ("Session ID
    // already in use"). Forking reads the history but writes to a fresh UUID.
    const sessionArgs = this.resumeFrom
      ? ['--resume', this.sessionId, '--fork-session']
      : ['--session-id', this.sessionId]
    const args = [
      '--print',
      ...sessionArgs,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', this.permissionMode,
      ...(this.model ? ['--model', this.model] : []),
      ...(this.appendSystemPrompt ? ['--append-system-prompt', this.appendSystemPrompt] : []),
    ]

    const cwd = this.cwd
    console.log(`[ClaudeStream ${this.ptyId}] spawning ${bin} ${args.join(' ')} in cwd=${cwd}`)

    // Replay any saved JSONL history for this session so the optical view
    // shows the prior conversation before the live stream starts emitting.
    // Batched: per-event sends would trigger one renderer re-render per line.
    const jsonlPath = path.join(claudeProjectDirForCwd(cwd), `${this.sessionId}.jsonl`)
    if (fs.existsSync(jsonlPath)) {
      const history = loadSessionHistory(jsonlPath)
      console.log(`[ClaudeStream ${this.ptyId}] replaying ${history.length} historical events from ${jsonlPath}`)
      if (history.length > 0 && !this.owner.isDestroyed()) {
        this.owner.send(`claude-stream:batch:${this.ptyId}`, history)
      }
    }

    this.proc = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (!this.owner.isDestroyed()) {
      this.owner.send(`claude-stream:status:${this.ptyId}`, { state: 'starting', sessionId: this.sessionId, cwd })
    }

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.handleStdout(chunk))

    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      console.warn(`[ClaudeStream ${this.ptyId}] stderr:`, chunk.trimEnd())
      if (!this.owner.isDestroyed()) {
        this.owner.send(`claude-stream:stderr:${this.ptyId}`, chunk)
      }
    })

    this.proc.on('exit', (code) => {
      this.exited = true
      console.log(`[ClaudeStream ${this.ptyId}] exited with code=${code}`)
      if (!this.owner.isDestroyed()) {
        this.owner.send(`claude-stream:exit:${this.ptyId}`, code)
      }
    })

    this.proc.on('error', (err) => {
      console.error(`[ClaudeStream ${this.ptyId}] spawn error:`, err)
      if (!this.owner.isDestroyed()) {
        this.owner.send(`claude-stream:error:${this.ptyId}`, String(err))
      }
    })

    // Swallow stdin pipe errors (EPIPE): if the child is killed (model switch,
    // rotation, interrupt) while a write is in flight, the broken-pipe error would
    // otherwise surface as an uncaught exception and crash the main process.
    this.proc.stdin.on('error', (err) => {
      console.warn(`[ClaudeStream ${this.ptyId}] stdin error (ignored):`, String(err))
    })

    // Brand-new session with a task to kick off: deliver the opening turn the
    // same way the terminal does (`cat context | claude "..."`). stdin is a
    // pipe, so writing now is buffered until claude is ready to read it.
    // Resumed/forked sessions already hold their history — never re-inject.
    if (!this.resumeFrom && this.openingMessage) {
      console.log(`[ClaudeStream ${this.ptyId}] sending opening turn (${this.openingMessage.length} chars)`)
      this.sendUserText(this.openingMessage)
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIdx: number
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIdx)
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1)
      const event = parseStreamLine(line)
      if (!event) continue
      this.dispatch(event)
    }
  }

  private dispatch(event: StreamJsonEvent): void {
    if (event.type === 'system' && event.subtype === 'init') {
      this.onSessionId?.(event.session_id)
    }
    if (this.owner.isDestroyed()) return
    // Tag with the ordinal of the turn this event belongs to, then advance the
    // counter once the turn's closing `result` has gone out.
    this.owner.send(`claude-stream:event:${this.ptyId}`, { ...event, __turnOrdinal: this.turnsCompleted })
    if (event.type === 'result') this.turnsCompleted++
  }

  /** Send a user message (text) to the claude process. Returns the turn ordinal
   *  this message will be answered under (its reply + closing `result` carry the
   *  same `__turnOrdinal`), so a consumer can attribute the reply to this turn. */
  sendUserText(text: string): number {
    if (!this.proc || this.exited || !this.proc.stdin.writable) return this.turnsSent
    const ordinal = this.turnsSent
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n'
    try {
      this.proc.stdin.write(line)
    } catch (err) {
      console.warn(`[ClaudeStream ${this.ptyId}] stdin write failed (ignored):`, String(err))
      return ordinal
    }
    this.turnsSent++
    return ordinal
  }

  stop(): void {
    if (!this.proc || this.exited) return
    try { this.proc.stdin.end() } catch { /* ignore */ }
    // SIGTERM with a 2s SIGKILL fallback.
    this.proc.kill('SIGTERM')
    setTimeout(() => {
      if (!this.exited && this.proc) this.proc.kill('SIGKILL')
    }, 2000)
  }

  /** Switch the renderer the events broadcast to (e.g. after a window reload). */
  attachOwner(owner: WebContents): void {
    this.owner = owner
  }

  /** True when the child process is alive and accepting input. */
  isAlive(): boolean {
    return this.proc !== null && !this.exited
  }
}
