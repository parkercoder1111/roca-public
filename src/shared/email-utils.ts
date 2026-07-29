export function buildQuoteHtml(lines: string[]): string {
  const bqStyle = 'margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex'
  const parts: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].startsWith('>')) {
      const nested: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        nested.push(lines[i].startsWith('> ') ? lines[i].slice(2) : lines[i].slice(1))
        i++
      }
      parts.push(`<blockquote style="${bqStyle}">${buildQuoteHtml(nested)}</blockquote>`)
    } else {
      const plain: string[] = []
      while (i < lines.length && !lines[i].startsWith('>')) {
        plain.push(lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        i++
      }
      parts.push(plain.join('<br>'))
    }
  }
  return parts.join('')
}
