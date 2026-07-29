import React from 'react'
import { slackEmojiChar } from './slack-emoji-char'

/** Parse basic Slack mrkdwn into React elements */
export function parseSlackMrkdwn(text: string, userMap?: Map<string, string>, channelMap?: Map<string, string>): React.ReactNode {
  if (!text) return null

  // Broadcast and special mentions
  let processed = text
    .replace(/<!channel>/g, '@channel')
    .replace(/<!here>/g, '@here')
    .replace(/<!everyone>/g, '@everyone')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<!date\^\d+\^[^|>]+\|([^>]+)>/g, '$1')
  // Channel references: <#CXXXXXXX|channel-name> -> #channel-name, bare <#CXXXXXXX> -> resolved name or #channel
  processed = processed.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
  processed = processed.replace(/<#([A-Z0-9]+)>/g, (_, id) => '#' + (channelMap?.get(id) || id.toLowerCase()))
  // Process Slack link syntax: <url|label> or <url>
  processed = processed.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url, label) => '[' + label.replace(/[\[\]()]/g, '\\$&') + '](' + url + ')')
  processed = processed.replace(/<(https?:\/\/[^>]+)>/g, '[$1]($1)')
  processed = processed.replace(/<mailto:([^|>]+)(?:\|([^>]+))?>/g, (_, addr, label) => '[' + (label || addr) + '](mailto:' + addr + ')')
  // Decode HTML entities Slack API encodes in message text (must come after all <...> token replacements).
  // API mentions arrive as bare <@USERID> (never HTML-encoded); user-typed <@USERID> arrives as &lt;@USERID&gt;.
  // Insert a zero-width space before the @ so user-typed patterns don't match the mention regex after decode.
  processed = processed
    .replace(/&lt;@/g, '<​@')
    .replace(/&lt;#/g, '<​#')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

  const parts: React.ReactNode[] = []
  let key = 0

  const linkLabelInlineRegex = /(`[^`]+`|~[^~\n]+~|(?<!\w)\*(?!\s)[^*\n]+(?<!\s)\*(?!\w)|(?<!\w)_[^_\n]+_(?!\w))/g
  const formatLinkLabel = (label: string): React.ReactNode => {
    const lp: React.ReactNode[] = []
    let li = 0
    let lm: RegExpExecArray | null
    linkLabelInlineRegex.lastIndex = 0
    while ((lm = linkLabelInlineRegex.exec(label)) !== null) {
      if (lm.index > li) lp.push(label.slice(li, lm.index))
      const seg = lm[0]
      if (seg.startsWith('*') && seg.endsWith('*')) lp.push(<strong key={key++}>{seg.slice(1, -1)}</strong>)
      else if (seg.startsWith('_') && seg.endsWith('_')) lp.push(<em key={key++}>{seg.slice(1, -1)}</em>)
      else if (seg.startsWith('~') && seg.endsWith('~')) lp.push(<del key={key++}>{seg.slice(1, -1)}</del>)
      else if (seg.startsWith('`') && seg.endsWith('`')) lp.push(<code key={key++} className="px-1 py-0.5 rounded bg-black/[0.06] text-[11px] font-mono">{seg.slice(1, -1)}</code>)
      else lp.push(seg)
      li = lm.index + seg.length
    }
    if (li < label.length) lp.push(label.slice(li))
    return lp.length === 1 ? lp[0] : <>{lp}</>
  }

  // Group lines into blockquote vs. non-blockquote chunks so multi-line inline content is preserved
  const lineGroups: Array<{ bq: boolean; level: number; text: string }> = []
  let tripleQuoteActive = false
  for (const line of processed.split('\n')) {
    const m3 = line.match(/^>>> ?(.*)/)
    const m2 = line.match(/^(?:>>|> >) (.*)/)
    if (m3) {
      tripleQuoteActive = true
      const last = lineGroups[lineGroups.length - 1]
      if (last && last.bq && last.level === 2) { last.text += '\n' + m3[1] } else { lineGroups.push({ bq: true, level: 2, text: m3[1] }) }
    } else if (tripleQuoteActive) {
      const last = lineGroups[lineGroups.length - 1]
      last.text += '\n' + line
    } else if (m2) {
      const last = lineGroups[lineGroups.length - 1]
      if (last && last.bq && last.level === 2) { last.text += '\n' + m2[1] } else { lineGroups.push({ bq: true, level: 2, text: m2[1] }) }
    } else if (line.match(/^> (.*)/)) {
      const m = line.match(/^> (.*)/)!
      const last = lineGroups[lineGroups.length - 1]
      if (last && last.bq && last.level === 1) { last.text += '\n' + m[1] } else { lineGroups.push({ bq: true, level: 1, text: m[1] }) }
    } else {
      const last = lineGroups[lineGroups.length - 1]
      if (last && !last.bq) {
        last.text += '\n' + line
      } else {
        lineGroups.push({ bq: false, level: 0, text: line })
      }
    }
  }

  const inlineRegex = /(```[\s\S]+?```|`[^`]+`|~[^~\n]+~|(?<!\w)\*(?!\s)[^*\n]+(?<!\s)\*(?!\w)|(?<!\w)_[^_\n]+_(?!\w)|\[(?:[^\]\\]|\\.)*\]\((?:[^)(]|\([^)]*\))+\)|:[a-z0-9_+\-]+:|<@[A-Z0-9]+(?:\|[^>]*)?>)/g

  const processInline = (chunk: string) => {
    inlineRegex.lastIndex = 0
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = inlineRegex.exec(chunk)) !== null) {
      if (match.index > lastIndex) parts.push(chunk.slice(lastIndex, match.index))
      const segment = match[0]
      if (segment.startsWith('```') && segment.endsWith('```')) {
        const inner = segment.slice(3, -3)
        const firstNl = inner.indexOf('\n')
        const codeBody = firstNl >= 0 ? inner.slice(firstNl + 1) : inner
        parts.push(
          <pre key={key++} className="my-1 px-2 py-1.5 rounded bg-black/[0.06] text-[11px] font-mono overflow-x-auto whitespace-pre">
            <code>{codeBody}</code>
          </pre>
        )
      } else if (segment.startsWith('~') && segment.endsWith('~')) {
        parts.push(<del key={key++}>{segment.slice(1, -1)}</del>)
      } else if (segment.startsWith('*') && segment.endsWith('*')) {
        parts.push(<strong key={key++}>{segment.slice(1, -1)}</strong>)
      } else if (segment.startsWith('_') && segment.endsWith('_')) {
        parts.push(<em key={key++}>{segment.slice(1, -1)}</em>)
      } else if (segment.startsWith('`') && segment.endsWith('`')) {
        parts.push(
          <code key={key++} className="px-1 py-0.5 rounded bg-black/[0.06] text-[11px] font-mono">
            {segment.slice(1, -1)}
          </code>
        )
      } else if (segment.startsWith('[')) {
        const linkMatch = segment.match(/^\[((?:[^\]\\]|\\.)*)\]\(((?:[^)(]|\([^)]*\))+)\)$/)
        if (linkMatch) {
          const linkLabel = linkMatch[1].replace(/\\([\[\]()])/g, '$1')
          const href = linkMatch[2]
          if (!/^(https?:|mailto:)/i.test(href)) {
            parts.push(segment)
          } else {
            parts.push(
              <a
                key={key++}
                href={href}
                className="text-blue-1 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {formatLinkLabel(linkLabel)}
              </a>
            )
          }
        } else {
          parts.push(segment)
        }
      } else if (/^:[a-z0-9_+\-]+:$/.test(segment)) {
        parts.push(slackEmojiChar(segment.slice(1, -1)))
      } else if (segment.startsWith('<@') && segment.endsWith('>')) {
        const inner = segment.slice(2, -1)
        const pipeIdx = inner.indexOf('|')
        const uid = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner
        const inlineLabel = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : undefined
        const name = userMap?.get(uid)
        const validName = (name && name !== 'Unknown User') ? name : undefined
        const display = validName ? `@${validName}` : inlineLabel ? `@${inlineLabel}` : uid.startsWith('B') ? '@Bot' : uid.startsWith('A') ? '@App' : '@…'
        parts.push(
          <span key={key++} className="bg-purple-1/10 text-purple-1 rounded px-0.5 font-medium">{display}</span>
        )
      } else {
        parts.push(segment)
      }
      lastIndex = match.index + segment.length
    }
    if (lastIndex < chunk.length) parts.push(chunk.slice(lastIndex))
  }

  let prevGroupBq: boolean | null = null
  for (const group of lineGroups) {
    if (prevGroupBq !== null && prevGroupBq !== group.bq) parts.push('\n')
    prevGroupBq = group.bq
    if (group.bq) {
      const bqStart = parts.length
      processInline(group.text)
      const bqChildren = parts.splice(bqStart)
      const bqClass = group.level === 2
        ? "block border-l-2 border-text-3/50 pl-5 ml-2 italic text-text-3 my-0.5 whitespace-pre-wrap"
        : "block border-l-2 border-text-3 pl-2 italic text-text-3 my-0.5 whitespace-pre-wrap"
      parts.push(
        <span key={key++} className={bqClass}>
          {bqChildren}
        </span>
      )
    } else {
      processInline(group.text)
    }
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>
}
