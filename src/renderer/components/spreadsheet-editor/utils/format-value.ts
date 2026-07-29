export function formatValue(value: any, numFmt?: string): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'string') {
    if (numFmt && /[dmy]/i.test(numFmt) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      try {
        const d = new Date(value)
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      } catch { /* fall through */ }
    }
    return value
  }
  if (typeof value !== 'number') return String(value)

  if (!numFmt || numFmt === 'General') {
    return Number(value.toPrecision(10)).toString()
  }

  const fmt = numFmt

  // Percentage
  if (fmt.includes('%')) {
    const pct = value * 100
    const decMatch = fmt.match(/0\.(0+)%/)
    const decimals = decMatch ? decMatch[1].length : 0
    const neg = pct < 0
    const abs = Math.abs(pct).toFixed(decimals)
    if (fmt.includes('(') && neg) return `(${abs}%)`
    return (neg ? '-' : '') + abs + '%'
  }

  // Currency
  const currMatch = fmt.match(/^([^#0\s]*)/)
  let currency = ''
  if (currMatch && currMatch[1]) {
    currency = currMatch[1].replace(/[#,0.;\[\]]/g, '').trim()
    if (currency.includes('$')) currency = '$'
    else if (currency.includes('€')) currency = '€'
    else if (currency.includes('£')) currency = '£'
    else currency = ''
  }

  const decMatch = fmt.match(/0\.(0+)/)
  const decimals = decMatch ? decMatch[1].length : 0
  const useCommas = fmt.includes('#,') || fmt.includes('0,')
  const neg = value < 0
  const absVal = Math.abs(value)
  let formatted: string

  if (useCommas) {
    formatted = absVal.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  } else {
    formatted = absVal.toFixed(decimals)
  }

  if (neg && fmt.includes('(')) return `${currency}(${formatted})`
  const suffix = fmt.endsWith('x') ? 'x' : ''
  return (neg ? '-' : '') + currency + formatted + suffix
}
