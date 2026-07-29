/**
 * Extract the set of task ids that have at least one live terminal session,
 * from the raw list of live ROCA pty ids (`tmux ls` names with the `roca-`
 * prefix already stripped — see PtyManager.getLivePtyIds).
 *
 * This drives the "Flow State" filter, which surfaces every task the user has an
 * ongoing terminal for — regardless of which tab of that task is live, and
 * regardless of whether they've reopened its panel since launch (tmux runs
 * out-of-process, so the sessions survive ROCA restarts).
 *
 * Session names come in these shapes:
 *   - `task-<id>`                  — legacy bare primary tab
 *   - `task-<id>-<tabsuffix>`      — a normal tab (every tab now carries a suffix)
 *   - `task-<id>-merge-<suffix>`   — a merge/compare tab
 *   - `task-assistant`, `task-assistant-<suffix>` — the virtual assistant (excluded)
 *
 * We match the leading numeric id off any `task-<id>…` name and dedupe. A task
 * counts once no matter how many of its tabs are live. `task-assistant…` never
 * matches (`assistant` isn't digits), so the assistant is naturally excluded.
 *
 * The previous implementation matched only the exact `^task-(\d+)$` (bare) form,
 * so once tabs gained a per-tab suffix it saw only the single legacy bare
 * session and Flow State collapsed to one task.
 */
export function flowStateTaskIds(livePtyIds: string[]): number[] {
  const ids = new Set<number>()
  for (const ptyId of livePtyIds) {
    const m = ptyId.match(/^task-(\d+)(?:-|$)/)
    if (m) ids.add(Number(m[1]))
  }
  return [...ids]
}
