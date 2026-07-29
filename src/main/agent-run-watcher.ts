// src/main/agent-run-watcher.ts
//
// Surfaces the sub-agents the main claude session spins up while the user is
// talking to it directly (the Task/Agent tool). It tails the SAME session
// transcript the optical mirror reads — but only to observe, never to spawn —
// and rebuilds a small list of "agent runs" plus each run's own sidechain
// transcript, which the files sidebar shows as a red, click-into-able row.
//
// Deliberately isolated from ClaudeMirrorSession: it owns its own poll loop and
// IPC channel so harvesting agent runs can never perturb the optical view's
// stream (whose replay semantics are easy to double up).
import { WebContents } from 'electron'
import fs from 'fs'
import { parseStreamLine, type StreamJsonEvent } from '../shared/stream-json-events'
import { findTerminalClaude } from './claude-stream-manager'
import type { AgentRun } from '../shared/types'

// Subagent steps don't need sub-second latency — a relaxed poll keeps the
// pgrep-backed session lookup cheap. We re-resolve the transcript path only
// every RESOLVE_EVERY ticks so a new conversation (new session id) is picked
// up without hammering the process table four times a second.
const POLL_MS = 500
const RESOLVE_EVERY = 4 // → re-resolve the live session every ~2s

class AgentRunWatcher {
  readonly ptyId: string
  private owner: WebContents
  private jsonlPath: string | null = null
  private offset = 0
  private tick = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  // Run id (the spawning tool_use id) → run state, in spawn order.
  private readonly runs = new Map<string, AgentRun>()
  private readonly order: string[] = []
  // Run id → the sub-agent's own transcript lines, for the click-into view.
  private readonly events = new Map<string, StreamJsonEvent[]>()
  // The most-recently-spawned run — sidechain lines without an explicit parent
  // are attributed here (correct for the common one-at-a-time case).
  private currentRunId: string | null = null

  constructor(ptyId: string, owner: WebContents) {
    this.ptyId = ptyId
    this.owner = owner
  }

  start(): void {
    this.resolve()
    this.drain()
    this.timer = setInterval(() => {
      if (this.stopped) return
      this.tick++
      if (this.tick % RESOLVE_EVERY === 0) this.resolve()
      this.drain()
    }, POLL_MS)
  }

  /** Point at the terminal's current claude transcript; reset on a new session. */
  private resolve(): void {
    const terminal = findTerminalClaude(this.ptyId)
    if (!terminal) return // no live claude (yet) — keep whatever we had
    if (terminal.jsonlPath === this.jsonlPath) return
    // New conversation → start its run list clean.
    this.jsonlPath = terminal.jsonlPath
    this.offset = 0
    this.runs.clear()
    this.order.length = 0
    this.events.clear()
    this.currentRunId = null
    this.emit()
  }

  /** Read transcript lines appended since the last drain and fold them in. */
  private drain(): void {
    if (this.stopped || !this.jsonlPath) return
    let size: number
    try {
      size = fs.statSync(this.jsonlPath).size
    } catch {
      return
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
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) return
    const complete = text.slice(0, lastNewline + 1)
    this.offset += Buffer.byteLength(complete, 'utf8')
    let changed = false
    for (const line of complete.split('\n')) {
      const ev = parseStreamLine(line)
      if (ev && this.fold(ev)) changed = true
    }
    if (changed) this.emit()
  }

  /** Apply one transcript event; return whether it changed the run list. */
  private fold(ev: StreamJsonEvent): boolean {
    const parentId = (ev as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined
    const sidechain = !!(ev as { isSidechain?: boolean }).isSidechain || !!parentId

    if (sidechain) return this.foldSidechain(ev, parentId)

    // Main chain: spawn (assistant Task/Agent tool_use) and completion (its
    // tool_result coming back).
    if (ev.type === 'assistant') {
      let changed = false
      for (const block of ev.message.content) {
        if (block.type !== 'tool_use') continue
        if (block.name !== 'Task' && block.name !== 'Agent') continue
        if (this.runs.has(block.id)) continue
        const input = block.input ?? {}
        const desc = typeof input.description === 'string' ? input.description : ''
        this.runs.set(block.id, {
          id: block.id,
          title: desc || 'Sub-agent',
          subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : '',
          status: 'running',
          startedAt: ev.timestamp ? Date.parse(ev.timestamp) : Date.now(),
          endedAt: null,
          steps: 0,
        })
        this.order.push(block.id)
        this.currentRunId = block.id
        changed = true
      }
      return changed
    }

    if (ev.type === 'user' && Array.isArray(ev.message.content)) {
      let changed = false
      const blocks = ev.message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>
      for (const block of blocks) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const run = this.runs.get(block.tool_use_id)
        if (!run || run.status !== 'running') continue
        run.status = block.is_error ? 'error' : 'done'
        run.endedAt = ev.timestamp ? Date.parse(ev.timestamp) : Date.now()
        changed = true
      }
      return changed
    }

    return false
  }

  /** Attribute a sub-agent's own line to its run and bank it for the preview. */
  private foldSidechain(ev: StreamJsonEvent, parentId?: string): boolean {
    const runId = parentId && this.runs.has(parentId) ? parentId : this.currentRunId
    if (!runId || !this.runs.has(runId)) return false
    const list = this.events.get(runId) ?? []
    list.push(ev)
    this.events.set(runId, list)
    if (ev.type === 'assistant') {
      const tools = ev.message.content.filter((b) => b.type === 'tool_use').length
      if (tools) { this.runs.get(runId)!.steps += tools; return true }
    }
    return false // banked the line, but the run summary itself didn't change
  }

  private list(): AgentRun[] {
    return this.order.map((id) => this.runs.get(id)).filter((r): r is AgentRun => !!r)
  }

  private emit(): void {
    if (this.owner.isDestroyed()) return
    this.owner.send(`agent-runs:update:${this.ptyId}`, this.list())
  }

  getRuns(): AgentRun[] {
    return this.list()
  }

  getEvents(runId: string): StreamJsonEvent[] {
    return this.events.get(runId) ?? []
  }

  attachOwner(owner: WebContents): void {
    this.owner = owner
    this.emit()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

const watchers = new Map<string, AgentRunWatcher>()

export function watchAgentRuns(ptyId: string, owner: WebContents): void {
  const existing = watchers.get(ptyId)
  if (existing) { existing.attachOwner(owner); return }
  const w = new AgentRunWatcher(ptyId, owner)
  watchers.set(ptyId, w)
  w.start()
}

export function unwatchAgentRuns(ptyId: string): void {
  const w = watchers.get(ptyId)
  if (!w) return
  w.stop()
  watchers.delete(ptyId)
}

export function getAgentRuns(ptyId: string): AgentRun[] {
  return watchers.get(ptyId)?.getRuns() ?? []
}

export function getAgentRunEvents(ptyId: string, runId: string): StreamJsonEvent[] {
  return watchers.get(ptyId)?.getEvents(runId) ?? []
}

export function stopAllAgentRunWatchers(): void {
  for (const w of watchers.values()) w.stop()
  watchers.clear()
}
