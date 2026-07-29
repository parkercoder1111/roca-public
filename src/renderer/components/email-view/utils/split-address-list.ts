export function splitAddressList(list: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuote = false
  for (const ch of list) {
    if (ch === '"') {
      inQuote = !inQuote
      current += ch
    } else if (ch === ',' && !inQuote) {
      if (current.trim()) result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) result.push(current.trim())
  return result
}
