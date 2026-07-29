import { currentIsoWeek, isoWeeksInYear } from './format-date'

// A notebook is either global (one doc) or scoped to a repeating period —
// an ISO week or a calendar quarter. These helpers give the notes UI a single
// vocabulary for "what's the current period", "step to the next/previous one",
// and "how do I label it", regardless of which kind of notebook is on screen.
export type NotebookKind = 'global' | 'weekly' | 'quarterly'

const WEEK_RE = /^(\d{4})-W(\d{2})$/
const QUARTER_RE = /^(\d{4})-Q([1-4])$/

export function currentQuarter(): string {
  const d = new Date()
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}

function shiftIsoWeek(week: string, dir: -1 | 1): string {
  const m = week.match(WEEK_RE)
  if (!m) return currentIsoWeek()
  let y = parseInt(m[1], 10)
  let w = parseInt(m[2], 10)
  if (dir === 1) { if (w >= isoWeeksInYear(y)) { y += 1; w = 1 } else { w += 1 } }
  else { if (w <= 1) { y -= 1; w = isoWeeksInYear(y) } else { w -= 1 } }
  return `${y}-W${String(w).padStart(2, '0')}`
}

function shiftQuarter(quarter: string, dir: -1 | 1): string {
  const m = quarter.match(QUARTER_RE)
  if (!m) return currentQuarter()
  let y = parseInt(m[1], 10)
  let q = parseInt(m[2], 10) + dir
  if (q > 4) { q = 1; y += 1 } else if (q < 1) { q = 4; y -= 1 }
  return `${y}-Q${q}`
}

// The current period key for a kind, or null for global notebooks (no nav).
export function currentPeriod(kind: NotebookKind): string | null {
  if (kind === 'weekly') return currentIsoWeek()
  if (kind === 'quarterly') return currentQuarter()
  return null
}

export function shiftPeriod(kind: NotebookKind, key: string, dir: -1 | 1): string {
  return kind === 'quarterly' ? shiftQuarter(key, dir) : shiftIsoWeek(key, dir)
}

// Short label shown between the nav arrows.
export function periodLabel(kind: NotebookKind, key: string): string {
  if (kind === 'weekly') {
    const now = currentIsoWeek()
    if (key === now) return 'This week'
    if (key === shiftIsoWeek(now, -1)) return 'Last week'
    const m = key.match(WEEK_RE)
    return m ? `Week ${parseInt(m[2], 10)}` : key
  }
  if (kind === 'quarterly') {
    const now = currentQuarter()
    if (key === now) return 'This quarter'
    const m = key.match(QUARTER_RE)
    return m ? `Q${m[2]} ${m[1]}` : key
  }
  return ''
}
