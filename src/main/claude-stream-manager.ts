// src/main/claude-stream-manager.ts
import { WebContents } from 'electron'
import fs from 'fs'
import path from 'path'
import { ClaudeStreamSession, claudeProjectDirForCwd } from './claude-stream-session'
import { ClaudeMirrorSession } from './claude-mirror-session'
import { getTaskById } from './database'
import { buildTaskContext, buildAssistantContext } from './helpers/build-task-context'
import { resolveTaskCwd } from './helpers/resolve-task-cwd'
import type { PtyManager } from './pty-manager'

const sessions = new Map<string, ClaudeStreamSession | ClaudeMirrorSession>()
// Persist UUIDs across mode toggles so resume works.
const sessionIdByPty = new Map<string, string>()

// Injected once at IPC registration so optical view can attach to the claude
// process already running in the task's terminal pane.
let ptyManager: PtyManager | null = null
export function setClaudeStreamPtyManager(pm: PtyManager): void {
  ptyManager = pm
}

interface TerminalClaude {
  sessionId: string
  cwd: string
  jsonlPath: string
}

// Last successful mirror target per pty. The live process-correlation lookup
// is timing-sensitive (claude mid-restart, resumed sessions, pgrep windows) —
// without memory, a transient miss silently flips the view to the forked
// fallback, swapping out the visible history and footer controls.
const mirrorMemory = new Map<string, TerminalClaude>()

/** Locate the live claude session inside this pty's terminal pane, if any.
 *  Exported so passive observers (the agent-run watcher) can resolve the same
 *  transcript without spawning their own claude. */
export function findTerminalClaude(ptyId: string): TerminalClaude | null {
  if (!ptyManager) return null
  const sessionId = ptyManager.getClaudeSessionId(ptyId)
  if (sessionId) {
    const cwd = ptyManager.getClaudeCwd(ptyId)
    if (cwd) {
      const jsonlPath = path.join(claudeProjectDirForCwd(cwd), `${sessionId}.jsonl`)
      if (fs.existsSync(jsonlPath)) {
        const found = { sessionId, cwd, jsonlPath }
        mirrorMemory.set(ptyId, found)
        return found
      }
    }
  }
  // Live lookup missed — keep mirroring the last known session as long as
  // the pane still exists and its transcript is still on disk.
  const remembered = mirrorMemory.get(ptyId)
  if (remembered && ptyManager.has(ptyId) && fs.existsSync(remembered.jsonlPath)) {
    return remembered
  }
  return null
}

/** Numeric task id from a pty id (`task-123`, `task-123-<tab>`). The assistant
 *  pty (`task-assistant…`) has no numeric id, so this returns null for it. */
function numericTaskIdFromPtyId(ptyId: string): number | null {
  const m = ptyId.match(/^task-(\d+)(?:-|$)/)
  return m ? Number(m[1]) : null
}

export function ensureClaudeStream(ptyId: string, cwd: string, owner: WebContents): ClaudeStreamSession | ClaudeMirrorSession | null {
  // Prefer mirroring the terminal's own claude — the optical view then shows
  // the exact same conversation the terminal does, and input typed in either
  // view lands in the same session.
  const terminal = findTerminalClaude(ptyId)
  const existing = sessions.get(ptyId)
  if (existing && existing.isAlive()) {
    // Reuse unless the terminal now runs a different session than the one we
    // mirror (claude restarted) or a terminal claude appeared while a forked
    // fallback was active — both mean rebuild against the terminal session.
    const stale = terminal
      ? !(existing instanceof ClaudeMirrorSession) || existing.sessionId !== terminal.sessionId
      : false
    if (!stale) {
      existing.attachOwner(owner)
      return existing
    }
    existing.stop()
    sessions.delete(ptyId)
  }

  if (terminal) {
    const session = new ClaudeMirrorSession({
      ptyId,
      sessionId: terminal.sessionId,
      jsonlPath: terminal.jsonlPath,
      cwd: terminal.cwd,
      owner,
      writeToPty: (data) => ptyManager?.write(ptyId, data),
    })
    sessionIdByPty.set(ptyId, session.sessionId)
    session.start()
    sessions.set(ptyId, session)
    return session
  }

  // Terminal Claude runs on the VM (the pane is a mosh/ssh client), so there's
  // no local process to mirror. Forking a *local* Claude here would spin up a
  // separate conversation — the "optical shows completely different text" bug.
  // Refuse to fork; tell the view the session lives in the Terminal tab instead.
  if (ptyManager?.isPaneRemote(ptyId)) {
    if (!owner.isDestroyed()) {
      owner.send(`claude-stream:status:${ptyId}`, { state: 'remote', cwd, mirrored: false })
    }
    return null
  }

  // Fallback: no claude running in the terminal — fork/spawn a headless one.
  // This is the path a brand-new task takes when it's opened straight into the
  // optical view: there's no terminal claude to mirror, so we have to *start*
  // the task here, the same way the terminal does (resolve its cwd, then hand
  // claude the task context as the opening turn).
  const numericTaskId = numericTaskIdFromPtyId(ptyId)
  const isAssistant = ptyId === 'task-assistant' || ptyId.startsWith('task-assistant-')
  const task = numericTaskId != null ? getTaskById(numericTaskId) : null

  // Working directory: caller's cwd, then the pane's shell cwd, then the task's
  // resolved cwd (forked source / Development → ROCA repo). The task cwd matters
  // for resume too — the recency heuristic only searches the project dir.
  const effectiveCwd = cwd || ptyManager?.getPaneCwd(ptyId) || (task ? resolveTaskCwd(task) : undefined) || ''

  const sessionId = sessionIdByPty.get(ptyId)
  // First optical open of this pty (no remembered session) → deliver the task's
  // opening turn so claude actually begins. The session only sends it when it
  // spawns fresh; a resumed JSONL already carries its own opening turn.
  // Forked tasks are excluded: they must resume their cloned conversation
  // (matching the terminal's `claude --resume <forked_session_id>`), not start
  // a fresh one — so they fall through to the recency-resume path below.
  const openingMessage = sessionId
    ? undefined
    : isAssistant
      ? buildAssistantContext()
      : task && numericTaskId != null && !task.forked_session_id
        ? `${buildTaskContext(task, numericTaskId)}\n\nHelp me with this task`
        : undefined
  const session = new ClaudeStreamSession({
    ptyId,
    cwd: effectiveCwd,
    owner,
    sessionId,
    openingMessage,
    onSessionId: (actual) => sessionIdByPty.set(ptyId, actual),
  })
  sessionIdByPty.set(ptyId, session.sessionId)
  session.start()
  sessions.set(ptyId, session)
  return session
}

export function sendClaudeUserText(ptyId: string, text: string): boolean {
  const s = sessions.get(ptyId)
  if (!s || !s.isAlive()) return false
  s.sendUserText(text)
  return true
}

export function stopClaudeStream(ptyId: string): void {
  const s = sessions.get(ptyId)
  if (!s) return
  s.stop()
  sessions.delete(ptyId)
}

export function stopAllClaudeStreams(): void {
  for (const s of sessions.values()) s.stop()
  sessions.clear()
}
