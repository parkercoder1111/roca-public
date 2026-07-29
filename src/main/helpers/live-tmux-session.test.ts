import { describe, it, expect, vi } from 'vitest'
import { resolveLiveTmuxSession } from './live-tmux-session'

describe('resolveLiveTmuxSession', () => {
  it('returns the recorded session without probing tmux (happy path)', () => {
    const probe = vi.fn(() => true)
    const result = resolveLiveTmuxSession('roca-task-1919-mrtkl18z', 'roca-task-1919-mrtkl18z', probe)
    expect(result).toBe('roca-task-1919-mrtkl18z')
    // A live record is authoritative — no need to shell out to `tmux has-session`.
    expect(probe).not.toHaveBeenCalled()
  })

  it('falls back to the deterministic name when no record but the tmux session is alive', () => {
    // The exact post-restart state: this.ptys is empty, yet `roca-<id>` is
    // still running in tmux (what getLivePtyIds/`tmux ls` sees). Fork must
    // resolve it, not return null.
    const result = resolveLiveTmuxSession(null, 'roca-task-1919-mrtkl18z', () => true)
    expect(result).toBe('roca-task-1919-mrtkl18z')
  })

  it('returns null when there is neither a record nor a live tmux session', () => {
    const result = resolveLiveTmuxSession(undefined, 'roca-task-1919-mrtkl18z', () => false)
    expect(result).toBeNull()
  })
})
