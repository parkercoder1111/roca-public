export function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMs < 0) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  if (diffMins < 1) return 'now'
  if (diffMins < 60) return `${diffMins}m`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  const yearOpts = d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...yearOpts })
}
