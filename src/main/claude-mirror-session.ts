// src/main/claude-mirror-session.ts
//
// Mirrors the Claude Code session that is already running inside a task's
// terminal pane. Instead of forking a second headless claude process (see
// ClaudeStreamSession), this tails the live session's JSONL transcript at
// ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl and forwards each line to the
// renderer as a stream event. User input is written into the PTY itself, so
// the terminal view and the optical (chat) view stay one and the same
// conversation — switching modes never diverges the history.
import { WebContents } from 'electron'
import fs from 'fs'
import { parseStreamLine } from '../shared/stream-json-events'

interface ClaudeMirrorOptions {
  ptyId: string
  sessionId: string   // session UUID of the claude process in the terminal
  jsonlPath: string   // transcript file that process is writing
  cwd: string         // claude's own cwd (project-dir source of truth)
  owner: WebContents
  writeToPty: (data: string) => void
}

// fs.watch on macOS occasionally drops events after atomic rewrites, so a
// poll backstops it. Tight enough that footer state (permission mode etc.)
// confirms promptly; a 4×/s statSync is negligible.
const POLL_INTERVAL_MS = 250

export class ClaudeMirrorSession {
  readonly ptyId: string
  readonly sessionId: string
  private readonly jsonlPath: string
  private readonly cwd: string
  private owner: WebContents
  private readonly writeToPty: (data: string) => void
  private watcher: fs.FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private offset = 0 // byte offset of the next unread transcript byte
  private stopped = false

  constructor(opts: ClaudeMirrorOptions) {
    this.ptyId = opts.ptyId
    this.sessionId = opts.sessionId
    this.jsonlPath = opts.jsonlPath
    this.cwd = opts.cwd
    this.owner = opts.owner
    this.writeToPty = opts.writeToPty
  }

  start(): void {
    console.log(`[ClaudeMirror ${this.ptyId}] tailing ${this.jsonlPath}`)
    this.sendStatus('starting')
    this.drain()
    try {
      this.watcher = fs.watch(this.jsonlPath, () => this.drain())
    } catch (err) {
      console.warn(`[ClaudeMirror ${this.ptyId}] fs.watch failed, polling only:`, err)
    }
    this.pollTimer = setInterval(() => this.drain(), POLL_INTERVAL_MS)
    this.sendStatus('ready')
  }

  /** Read any complete transcript lines appended since the last drain. */
  private drain(): void {
    if (this.stopped) return
    let size: number
    try {
      size = fs.statSync(this.jsonlPath).size
    } catch {
      return // transient: file briefly missing during atomic replace
    }
    if (size < this.offset) this.offset = 0 // truncated/replaced: re-read
    if (size === this.offset) return
    let text: string
    try {
      const fd = fs.openSync(this.jsonlPath, 'r')
      const buf = Buffer.alloc(size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      fs.closeSync(fd)
      text = buf.toString('utf8')
    } catch {
      return
    }
    // Only consume up to the last newline — a partial trailing line is mid-write.
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) return
    const complete = text.slice(0, lastNewline + 1)
    this.offset += Buffer.byteLength(complete, 'utf8')
    const events = complete.split('\n').map(parseStreamLine).filter((e) => e !== null)
    if (events.length === 0 || this.owner.isDestroyed()) return
    // One IPC message per drain — a history replay can be thousands of lines,
    // and per-line sends would mean one renderer re-render each.
    this.owner.send(`claude-stream:batch:${this.ptyId}`, events)
  }

  private sendStatus(state: 'starting' | 'ready'): void {
    if (this.owner.isDestroyed()) return
    this.owner.send(`claude-stream:status:${this.ptyId}`, {
      state,
      sessionId: this.sessionId,
      cwd: this.cwd,
      mirrored: true,
    })
  }

  /**
   * Type the message into the terminal's claude prompt and submit. Multiline
   * text goes through bracketed paste so embedded newlines don't submit
   * early. The Enter is a separate delayed write: a `\r` inside the same
   * chunk reads as paste content (a newline in the input box) to the TUI,
   * not a keypress — the message would sit in the prompt unsent.
   */
  sendUserText(text: string): void {
    const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text
    this.writeToPty(payload)
    setTimeout(() => this.writeToPty('\r'), 200)
  }

  /** Re-point at a fresh renderer (window reload) and replay the full history. */
  attachOwner(owner: WebContents): void {
    this.owner = owner
    this.offset = 0
    this.sendStatus('starting')
    this.drain()
    this.sendStatus('ready')
  }

  isAlive(): boolean {
    return !this.stopped
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }
}
