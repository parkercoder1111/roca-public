/**
 * Resolve the tmux session name backing a pty id, tolerating a missing
 * in-memory PtyRecord.
 *
 * ROCA's terminals live in detached tmux sessions named `roca-<ptyId>`, which
 * survive app restarts, laptop sleep, and the process that spawned them. The
 * in-memory `this.ptys` map does NOT — it only holds panes the *current* ROCA
 * process has `start()`ed. So there's a window (right after a restart, before a
 * tab's terminal has re-attached) where a pane is very much alive in tmux but
 * has no record. Fork/Mirror-current used to read only the record and fail with
 * "No live session for that pane." on a pane the mirror picker (which trusts
 * `tmux ls`) plainly lists as live.
 *
 * `recorded` is the session stored on a live record (authoritative when set —
 * always `roca-<id>`). `deterministicName` is that same `roca-<id>` name,
 * recomputed from the id. `sessionAlive` probes tmux and is only consulted when
 * there's no record, so the happy path pays no extra `tmux has-session` call.
 */
export function resolveLiveTmuxSession(
  recorded: string | null | undefined,
  deterministicName: string,
  sessionAlive: () => boolean,
): string | null {
  if (recorded) return recorded
  return sessionAlive() ? deterministicName : null
}
