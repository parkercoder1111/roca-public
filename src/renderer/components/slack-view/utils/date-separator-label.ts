export function dateSeparatorLabel(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr

  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'

  const yearOpt = d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...yearOpt })
}
