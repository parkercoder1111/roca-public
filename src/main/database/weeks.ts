import type { Week } from '../../shared/types'
import { getDb } from './connection'

// ═══════════════════════════════════════════
//  DATE / WEEK HELPERS
// ═══════════════════════════════════════════

export function currentIsoWeek(): string {
  // Sunday-start: shift boundary so Sunday begins new week (add 1 day)
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const year = d.getFullYear()
  const jan4 = new Date(year, 0, 4)
  const startOfW1 = new Date(jan4)
  startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7)) // Monday of ISO W1
  const diff = d.getTime() - startOfW1.getTime()
  const weekNum = 1 + Math.floor(diff / (7 * 86400000))
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}

export function weekForDate(dateStr: string | null | undefined): string {
  if (!dateStr) return currentIsoWeek()
  try {
    const d = new Date(dateStr.slice(0, 10))
    if (isNaN(d.getTime())) return currentIsoWeek()
    d.setDate(d.getDate() + 1) // Sunday-start shift
    const year = d.getFullYear()
    const jan4 = new Date(year, 0, 4)
    const startOfW1 = new Date(jan4)
    startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
    const diff = d.getTime() - startOfW1.getTime()
    const weekNum = 1 + Math.floor(diff / (7 * 86400000))
    return `${year}-W${String(weekNum).padStart(2, '0')}`
  } catch {
    return currentIsoWeek()
  }
}

// ═══════════════════════════════════════════
//  WEEK
// ═══════════════════════════════════════════

export function ensureWeek(week?: string): string {
  const db = getDb()
  week = week || currentIsoWeek()
  const existing = db.prepare('SELECT id FROM weeks WHERE week = ?').get(week)
  if (!existing) {
    db.prepare('INSERT INTO weeks (week, created_at) VALUES (?, ?)').run(
      week, new Date().toISOString()
    )
  }
  return week
}

export function getWeekData(week?: string): Week | undefined {
  const db = getDb()
  week = week || currentIsoWeek()
  ensureWeek(week)
  return db.prepare('SELECT * FROM weeks WHERE week = ?').get(week) as Week | undefined
}

export function updateChallenges(week: string, text: string): void {
  const db = getDb()
  ensureWeek(week)
  db.prepare('UPDATE weeks SET challenges = ? WHERE week = ?').run(text, week)
}

export function updateMeetingsHeld(week: string, count: number): void {
  const db = getDb()
  ensureWeek(week)
  db.prepare('UPDATE weeks SET meetings_held = ? WHERE week = ?').run(count, week)
}
