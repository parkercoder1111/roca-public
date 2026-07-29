import { describe, it, expect } from 'vitest'
import { flowStateTaskIds } from './flow-state-task-ids'

describe('flowStateTaskIds', () => {
  it('counts every task with a live tab, deduped — not just the bare session', () => {
    // Verbatim from a real `tmux ls` (with the `roca-` prefix stripped, exactly
    // what getLivePtyIds returns). Before the fix, `^task-(\d+)$` matched only
    // the lone bare `task-1897`, so Flow State showed one task.
    const live = [
      'task-1842-mrhxtamw',
      'task-1843-merge-mrl6hbi8',
      'task-1843-merge-mrm6mstq',
      'task-1843-mrjdaveo',
      'task-1844-mrjppohb',
      'task-1897',
      'task-1897-mrrzv4mo',
      'task-1914-mrrzlhy1',
      'task-1919-mrtkl18z',
      'task-1920-mrtqn83v',
      'task-1921-mruxqomw',
      'task-1922-mrvcvaz2',
      'task-1930-mrxk4sap',
      'task-1931-mrxorvl8',
      'task-1932-mrxvr35k',
      'task-1933-mrxz24ly',
      'task-1934-mrybhwt3',
      'task-1935-mryyp58v',
      'task-assistant-mrdzscax',
      'task-assistant-mrxx7wv1',
    ]
    expect(flowStateTaskIds(live).sort((a, b) => a - b)).toEqual([
      1842, 1843, 1844, 1897, 1914, 1919, 1920, 1921, 1922, 1930, 1931, 1932, 1933, 1934, 1935,
    ])
  })

  it('excludes the assistant and anything without a numeric task id', () => {
    expect(flowStateTaskIds(['task-assistant', 'task-assistant-abc', 'filepath-terminal'])).toEqual([])
  })

  it('matches the bare legacy `task-<id>` form', () => {
    expect(flowStateTaskIds(['task-42'])).toEqual([42])
  })

  it('returns an empty list when nothing is live', () => {
    expect(flowStateTaskIds([])).toEqual([])
  })
})
