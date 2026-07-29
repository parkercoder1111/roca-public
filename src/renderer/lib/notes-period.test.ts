import { describe, it, expect } from 'vitest'
import { currentQuarter, shiftPeriod, periodLabel, currentPeriod } from './notes-period'

describe('notes-period', () => {
  it('currentPeriod is null for global, keyed for periodic kinds', () => {
    expect(currentPeriod('global')).toBeNull()
    expect(currentPeriod('weekly')).toMatch(/^\d{4}-W\d{2}$/)
    expect(currentPeriod('quarterly')).toMatch(/^\d{4}-Q[1-4]$/)
  })

  it('currentQuarter formats as YYYY-Qn', () => {
    expect(currentQuarter()).toMatch(/^\d{4}-Q[1-4]$/)
  })

  it('shifts quarters within a year', () => {
    expect(shiftPeriod('quarterly', '2026-Q2', 1)).toBe('2026-Q3')
    expect(shiftPeriod('quarterly', '2026-Q2', -1)).toBe('2026-Q1')
  })

  it('rolls quarters across year boundaries', () => {
    expect(shiftPeriod('quarterly', '2026-Q4', 1)).toBe('2027-Q1')
    expect(shiftPeriod('quarterly', '2026-Q1', -1)).toBe('2025-Q4')
  })

  it('shifts ISO weeks within a year', () => {
    expect(shiftPeriod('weekly', '2026-W10', 1)).toBe('2026-W11')
    expect(shiftPeriod('weekly', '2026-W10', -1)).toBe('2026-W09')
  })

  it('rolls ISO weeks across the year boundary', () => {
    // 2026 → W01 stepping back lands in the final week of 2025 (W52).
    expect(shiftPeriod('weekly', '2026-W01', -1)).toBe('2025-W52')
  })

  it('labels the current quarter and a named quarter', () => {
    expect(periodLabel('quarterly', currentQuarter())).toBe('This quarter')
    // A quarter that is not the current one shows its Q# + year.
    const notNow = currentQuarter() === '2001-Q1' ? '2001-Q2' : '2001-Q1'
    expect(periodLabel('quarterly', notNow)).toMatch(/^Q[1-4] 2001$/)
  })

  it('labels global notebooks with an empty string', () => {
    expect(periodLabel('global', '')).toBe('')
  })
})
