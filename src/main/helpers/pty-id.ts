// Resolving RPC/voice "which terminal for this task" requests to the real pty id.
//
// The renderer now names each task's terminal pty `task-<id>-<tabId>` (the tab
// id is a base36 timestamp minted in right-panel.tsx), so the old assumption
// that a task's pty is simply `task-<id>` is wrong. RPC callers (the mobile
// client, and especially the voice brain) only know the numeric task id, so the
// terminal:* handlers must map a task id onto whichever live pty is actually
// backing that task's visible terminal.

/** Pull a task id out of loosely-typed RPC params. Accepts `taskId` directly,
 *  or derives it from a `ptyId` like "task-1855" / "task-1855-mrjqvs8i" /
 *  "task-assistant-xyz". Returns null when nothing usable is present. */
export function taskIdFromParams(p: { taskId?: string | number; ptyId?: string } | null | undefined): string | null {
  if (!p) return null
  if (p.taskId != null && String(p.taskId).trim() !== '') return String(p.taskId).trim()
  if (p.ptyId) {
    const raw = String(p.ptyId).trim()
    const numeric = raw.match(/^task-(\d+)(?:-|$)/)
    if (numeric) return numeric[1]
    const assistant = raw.match(/^task-(assistant(?:-[a-z0-9]+)?)$/i)
    if (assistant) return assistant[1]
    const stripped = raw.replace(/^task-/, '')
    return stripped || null
  }
  return null
}

/** Choose the live pty id backing a task's terminal. Prefers an exact
 *  `task-<id>` (legacy / main pty); otherwise the most-recently-spawned
 *  `task-<id>-<tabId>` tab, which is the best proxy for the tab in use.
 *  Returns null when the task has no live pty. */
export function pickPtyIdForTask(
  taskId: string,
  ptys: Array<{ id: string; spawnedAt: number }>,
): string | null {
  const exact = `task-${taskId}`
  if (ptys.some(p => p.id === exact)) return exact
  const prefix = `${exact}-`
  const suffixed = ptys.filter(p => p.id.startsWith(prefix))
  if (suffixed.length === 0) return null
  return suffixed.reduce((best, p) => (p.spawnedAt > best.spawnedAt ? p : best)).id
}
