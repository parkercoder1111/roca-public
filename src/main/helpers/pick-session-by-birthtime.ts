// Attributing a live Claude pane to the exact session JSONL it is writing is the
// crux of "fork this task": Claude persists each conversation as
// <session-uuid>.jsonl and picks the uuid itself, so ROCA has to reverse it from
// the outside. The only signal available is timing — the file is born when Claude
// first writes to it, shortly after the process launches. In a busy shared project
// dir ($HOME, where every non-repo task's Claude runs, or the ROCA repo dir for
// dev tasks) dozens of unrelated sessions pile up, so the match has to be careful:
// pick the birthtime closest to the process start, but only trust it when it wins
// by a clear margin — otherwise a near-simultaneous neighbor could be mistaken for
// this pane's session and the fork would resume a stranger's conversation.

export interface SessionCandidate {
  uuid: string
  birthMs: number // file creation time (ms since epoch)
}

// The first JSONL write can trail the process launch by over a minute when a large
// context is piped in (`cat context | claude …`) — measured at ~67s in the wild —
// so the acceptance window is generous. Beyond it we assume no candidate is ours.
export const MAX_FIRST_WRITE_LAG_MS = 300_000

// The closest match must beat the runner-up by at least this much to be trusted.
// When two sessions were created within this window of the process start we can't
// tell them apart from timing alone, so we decline rather than guess wrong.
export const CLEAR_WINNER_MARGIN_MS = 120_000

/**
 * Given every session JSONL in a project dir and the start time of the Claude
 * process we're trying to attribute, return the uuid of the session that process
 * created — or null when no candidate is a clear enough winner to trust.
 *
 * Uses absolute distance (not a "born after start" floor) on purpose: a revived
 * Claude resumes an older JSONL, so its file predates the current process start.
 */
export function pickSessionByBirthtime(
  candidates: SessionCandidate[],
  claudeStartMs: number,
): string | null {
  const ranked = candidates
    .map(c => ({ uuid: c.uuid, diffMs: Math.abs(c.birthMs - claudeStartMs) }))
    .sort((a, b) => a.diffMs - b.diffMs)

  const best = ranked[0]
  if (!best || best.diffMs >= MAX_FIRST_WRITE_LAG_MS) return null

  const runnerUp = ranked[1]
  if (runnerUp && runnerUp.diffMs - best.diffMs < CLEAR_WINNER_MARGIN_MS) return null

  return best.uuid
}
