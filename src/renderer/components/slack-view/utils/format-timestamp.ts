export function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr

  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()

  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  if (isToday) return time
  if (isYesterday) return `Yesterday at ${time}`
  const dateOpts: Intl.DateTimeFormatOptions = d.getFullYear() !== now.getFullYear()
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' }
  return `${d.toLocaleDateString('en-US', dateOpts)}, ${time}`
}
