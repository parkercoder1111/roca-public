export function isoWeeksInYear(year: number): number {
  const dec28 = new Date(year, 11, 28)
  const jan4 = new Date(year, 0, 4)
  const startOfW1 = new Date(jan4)
  startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  return 1 + Math.floor((dec28.getTime() - startOfW1.getTime()) / (7 * 86400000))
}

// ISO week calculation with Sunday-start shift (matches database.ts logic)
export function currentIsoWeek(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1) // Sunday-start shift
  const year = d.getFullYear()
  const jan4 = new Date(year, 0, 4)
  const startOfW1 = new Date(jan4)
  startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  const weekNum = 1 + Math.floor((d.getTime() - startOfW1.getTime()) / (7 * 86400000))
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}

export function formatDate(dateStr?: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
