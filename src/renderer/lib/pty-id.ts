/**
 * The live pty id for the *currently active* tab of a terminal scope.
 *
 * `base` is the scope's pty prefix — `task-<id>` for a task, `task-assistant`
 * for the Assistant overlay. A tab carries a base36 id, so its live tmux pane is
 * `<base>-<tabId>`; the one legacy case of an empty id maps to the bare `<base>`
 * pane. A mirror tab has no pane of its own — it attaches to the source's pty —
 * so its `mirror.ptyId` is the live session to act on.
 *
 * Fork/Mirror "current" MUST resolve through this. Targeting the bare `<base>`
 * when the active tab has a suffix looks up a pty that was never spawned and
 * fails with "No live session for that pane."
 */
export function tabPtyId(base: string, activeTabId: string, mirrorPtyId?: string | null): string {
  if (mirrorPtyId) return mirrorPtyId
  return activeTabId ? `${base}-${activeTabId}` : base
}
