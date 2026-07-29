import { describe, it, expect } from 'vitest'
import {
  pickSessionByBirthtime,
  MAX_FIRST_WRITE_LAG_MS,
  CLEAR_WINNER_MARGIN_MS,
} from './pick-session-by-birthtime'

const START = 1_000_000_000_000

describe('pickSessionByBirthtime', () => {
  it('returns null when there are no candidates', () => {
    expect(pickSessionByBirthtime([], START)).toBeNull()
  })

  it('matches the lone session in a single-conversation dir', () => {
    expect(pickSessionByBirthtime([{ uuid: 'a', birthMs: START + 5_000 }], START)).toBe('a')
  })

  // The regression: a real session's first JSONL write trailed process launch by
  // 67s. The old hard 60s window rejected it, so fork fell back to "most recently
  // modified in cwd" and resumed an unrelated task's conversation.
  it('accepts a lone match whose first write lagged 67s (old 60s window rejected it)', () => {
    const candidates = [
      { uuid: 'mine', birthMs: START + 67_400 },
      { uuid: 'hours-earlier', birthMs: START - 14_740_000 },
      { uuid: 'much-later', birthMs: START + 67_522_000 },
    ]
    expect(pickSessionByBirthtime(candidates, START)).toBe('mine')
  })

  it('rejects a match that lagged beyond the acceptance window', () => {
    const candidates = [{ uuid: 'stale', birthMs: START + MAX_FIRST_WRITE_LAG_MS + 1 }]
    expect(pickSessionByBirthtime(candidates, START)).toBeNull()
  })

  it('picks the clear closest even when other sessions exist in a shared dir', () => {
    const candidates = [
      { uuid: 'neighbor-1', birthMs: START - 5_000_000 },
      { uuid: 'mine', birthMs: START + 3_000 },
      { uuid: 'neighbor-2', birthMs: START + 8_000_000 },
    ]
    expect(pickSessionByBirthtime(candidates, START)).toBe('mine')
  })

  // Two sessions created within the margin of the process start can't be told
  // apart by timing — decline rather than fork a stranger's conversation.
  it('declines when two candidates are too close to disambiguate', () => {
    const candidates = [
      { uuid: 'mine-maybe', birthMs: START + 30_000 },
      { uuid: 'neighbor-maybe', birthMs: START + 30_000 + (CLEAR_WINNER_MARGIN_MS - 1) },
    ]
    expect(pickSessionByBirthtime(candidates, START)).toBeNull()
  })

  it('trusts the closest once the runner-up is a clear margin away', () => {
    const candidates = [
      { uuid: 'mine', birthMs: START + 30_000 },
      { uuid: 'neighbor', birthMs: START + 30_000 + CLEAR_WINNER_MARGIN_MS + 1 },
    ]
    expect(pickSessionByBirthtime(candidates, START)).toBe('mine')
  })

  // A revived Claude resumes an older JSONL, so its file predates the current
  // process start — absolute distance still finds it.
  it('matches a resumed session whose file predates the current process', () => {
    const candidates = [{ uuid: 'resumed', birthMs: START - 40_000 }]
    expect(pickSessionByBirthtime(candidates, START)).toBe('resumed')
  })
})
