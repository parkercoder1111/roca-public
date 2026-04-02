// Shared lightweight markdown -> HTML renderer

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
  // Restore code blocks (placeholders survive all transformations above)
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
    // Remove spurious <br> tags immediately before/after block list elements
    .replace(/<br>(<(?:ul|ol)>)/g, '$1')
    .replace(/(<\/(?:ul|ol)>)<br>/g, '$1')
  // Restore code blocks (placeholders survive all transformations above)
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CODE_BLOCK_${i}\x00`, codeBlocks[i])
  }
  return processed
}
