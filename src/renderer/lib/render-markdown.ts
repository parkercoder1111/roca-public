// Shared lightweight markdown -> HTML renderer

// ─────────────────────────────────────────────────────────────
// GFM tables
//
// The renderers below are line-oriented and would otherwise turn a
// `| a | b |` block into literal pipe text. We pull whole tables out FIRST
// (like fenced code), convert them to a single-line <table>, and stash a
// placeholder so the rest of the pipeline (escaping, newline→<br>, paragraph
// wrapping) leaves them untouched. Cells still get inline formatting via
// formatCell so bold/code/links inside a cell render the same as body text.
// ─────────────────────────────────────────────────────────────

// A `|---|:--:|--:|` separator row: only pipes, dashes, colons and spaces,
// and at least one of each structural char. Distinct from a `---` <hr>, which
// carries no pipe.
function isTableDelimiterRow(line: string): boolean {
  const t = line.trim()
  return t.includes('|') && t.includes('-') && /^[\s|:-]+$/.test(t)
}

// Split "| a | b |" into trimmed cells, tolerating optional edge pipes.
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
}

// Inline markdown for a single cell. Mirrors the inline rules of the block
// renderers (escape → bold → italic → code → links) so cells match body text.
function formatCell(raw: string, styled: boolean): string {
  let s = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, styled
      ? '<code class="bg-black/[0.06] px-1.5 py-0.5 rounded text-[11px] font-mono">$1</code>'
      : '<code>$1</code>')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    /^https?:\/\/|^\//.test(url)
      ? `<a href="${url.replace(/"/g, '&quot;')}"${styled ? ' class="text-blue-1 hover:underline"' : ''} target="_blank" rel="noopener noreferrer">${text}</a>`
      : `${text} (${url})`)
  return s
}

// Pull every table block out of `text`, replacing each with a \x00TABLE_n\x00
// placeholder and pushing its rendered HTML into `blocks`.
function extractTables(text: string, blocks: string[], styled: boolean): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    const delim = lines[i + 1]
    // Table = a pipe-bearing header row immediately followed by a delimiter row.
    if (header?.includes('|') && delim !== undefined && isTableDelimiterRow(delim)) {
      const headers = splitTableRow(header)
      const aligns = splitTableRow(delim).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center'
          : c.endsWith(':') ? 'right'
          : c.startsWith(':') ? 'left' : '')
      const body: string[][] = []
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        body.push(splitTableRow(lines[j]))
        j++
      }
      blocks.push(buildTableHtml(headers, aligns, body, styled))
      out.push(`\x00TABLE_BLOCK_${blocks.length - 1}\x00`)
      i = j
    } else {
      out.push(lines[i])
      i++
    }
  }
  return out.join('\n')
}

function buildTableHtml(headers: string[], aligns: string[], body: string[][], styled: boolean): string {
  const alignAttr = (k: number) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '')
  const thCls = ' class="border border-black/10 bg-black/[0.03] px-2.5 py-1.5 text-left font-semibold text-text-1"'
  const tdCls = ' class="border border-black/10 px-2.5 py-1.5 text-text-2 align-top"'
  const head = headers.map((h, k) => `<th${thCls}${alignAttr(k)}>${formatCell(h, styled)}</th>`).join('')
  const rows = body.map((cells) =>
    `<tr>${headers.map((_, k) => `<td${tdCls}${alignAttr(k)}>${formatCell(cells[k] ?? '', styled)}</td>`).join('')}</tr>`
  ).join('')
  return `<table class="my-2 w-full border-collapse text-[12px]"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
}

export function renderMarkdown(md: string): string {
  if (!md) return ''
  // Extract code blocks first to prevent bold/italic processing inside them
  const codeBlocks: string[] = []
  let html = md.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/```\w*\n?/, '').replace(/\n?```$/, '')
    const idx = codeBlocks.length
    codeBlocks.push(`<pre><code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`)
    return `\x00CODE_BLOCK_${idx}\x00`
  })
  // Tables next — before escaping, so their HTML survives the global escape
  // pass (formatCell escapes cell text itself).
  const tableBlocks: string[] = []
  html = extractTables(html, tableBlocks, false)
  html = html
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  // Bold & italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Images — must run before link substitution to prevent ![alt](url) being consumed as [alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    if (/^\/|^https?:\/\//.test(url)) return `<img src="${url.replace(/"/g, '&quot;')}" alt="${alt.replace(/"/g, '&quot;')}" class="max-w-full rounded-lg my-1" />`
    return `![${alt}](${url})`
  })
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (/^https?:\/\/|^\//.test(url)) {
      const safeUrl = url.replace(/"/g, '&quot;')
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`
    }
    return `${text} (${url})`
  })
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>')
  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
  // Ordered lists (temp tag so they don't mix with unordered grouping)
  html = html.replace(/^\d+\. (.+)$/gm, '<li-ordered>$1</li-ordered>')
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
  // Group ordered items into <ol> — use \n? to only group consecutive items
  html = html.replace(/(<li-ordered>[^\n]*<\/li-ordered>\n?)+/g, (match) =>
    `<ol>${match.replace(/<li-ordered>/g, '<li>').replace(/<\/li-ordered>/g, '</li>')}</ol>`)
  // Paragraphs — skip lines already converted to HTML tags and blank lines
  html = html.replace(/^(?!<)(?!\s*$)(.+)$/gm, '<p>$1</p>')
  // Restore tables + code blocks (placeholders survive all transforms above)
  for (let i = 0; i < tableBlocks.length; i++) {
    html = html.replace(`\x00TABLE_BLOCK_${i}\x00`, tableBlocks[i])
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODE_BLOCK_${i}\x00`, codeBlocks[i])
  }
  return html
}

// Workbook variant with Tailwind classes
export function renderMarkdownStyled(text: string): string {
  if (!text) return ''
  // Extract code blocks first (before HTML escaping) to prevent content from being processed
  const codeBlocks: string[] = []
  let processed = text.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const idx = codeBlocks.length
    codeBlocks.push(`<pre class="bg-black/[0.04] rounded-lg p-3 text-[11px] font-mono overflow-x-auto my-2"><code>${escaped}</code></pre>`)
    return `\x00CODE_BLOCK_${idx}\x00`
  })
  // Tables next — before escaping, so their HTML survives the global escape pass.
  const tableBlocks: string[] = []
  processed = extractTables(processed, tableBlocks, true)
  processed = processed
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Images — must run before link substitution
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      if (/^\/|^https?:\/\//.test(url)) return `<img src="${url.replace(/"/g, '&quot;')}" alt="${alt.replace(/"/g, '&quot;')}" class="max-w-full rounded-lg my-1" />`
      return `![${alt}](${url})`
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
      if (/^https?:\/\/|^\//.test(url)) {
        const safeUrl = url.replace(/"/g, '&quot;')
        return `<a href="${safeUrl}" class="text-blue-1 hover:underline" target="_blank" rel="noopener noreferrer">${text}</a>`
      }
      return `${text} (${url})`
    })
    .replace(/^### (.+)$/gm, '<h3 class="text-[12px] font-semibold text-text-1 mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-[13px] font-semibold text-text-1 mt-4 mb-1.5">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-[13px] font-semibold text-text-1 mt-4 mb-2">$1</h1>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-text-2">$1</li>')
    .replace(/`([^`]+)`/g, '<code class="bg-black/[0.06] px-1.5 py-0.5 rounded text-[11px] font-mono">$1</code>')
    .replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, (match) => `<ul>${match.replace(/\n/g, '')}</ul>`)
    .replace(/\n/g, '<br>')
    // Remove spurious <br> tags immediately before/after block elements
    .replace(/<br>(<(?:ul|ol)>)/g, '$1')
    .replace(/(<\/(?:ul|ol)>)<br>/g, '$1')
    .replace(/<br>(\x00TABLE_BLOCK_\d+\x00)/g, '$1')
    .replace(/(\x00TABLE_BLOCK_\d+\x00)<br>/g, '$1')
  // Restore tables + code blocks (placeholders survive all transforms above)
  for (let i = 0; i < tableBlocks.length; i++) {
    processed = processed.replace(`\x00TABLE_BLOCK_${i}\x00`, tableBlocks[i])
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CODE_BLOCK_${i}\x00`, codeBlocks[i])
  }
  return processed
}
