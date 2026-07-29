// src/renderer/components/optical-view/messages/message-meta.tsx
//
// The quiet "⧉ 3d ago" row under a message — copy affordance + relative
// timestamp, revealed on hover like the Claude desktop app.
//
// Copy writes BOTH clipboard flavors so pastes come out clean everywhere:
// rich text (real bold, bullets, paragraphs) for Notes/Gmail/Word, and
// markdown-stripped plain text for anything that only takes text.
import React, { useState } from 'react'
import { renderMarkdownStyled } from '../../../lib/render-markdown'
import { splitParagraphs } from './assistant-message'

export function relativeTime(ms?: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** Strip markdown syntax for a readable plain-text paste. */
function markdownToPlain(md: string): string {
  return md
    .replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => code)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,3} /gm, '')
    .replace(/^- /gm, '• ')
}

/** Semantic HTML (real <p>/<strong>/<ul>) — apps keep the structure on paste. */
function markdownToClipboardHtml(md: string): string {
  return splitParagraphs(md)
    .map((para) => `<p>${renderMarkdownStyled(para)}</p>`)
    .join('')
}

async function copyRich(text: string): Promise<void> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([markdownToClipboardHtml(text)], { type: 'text/html' }),
        'text/plain': new Blob([markdownToPlain(text)], { type: 'text/plain' }),
      }),
    ])
  } catch {
    await navigator.clipboard.writeText(markdownToPlain(text))
  }
}

export function MessageMeta({ text, timestamp, align }: { text: string; timestamp?: number; align: 'left' | 'right' }) {
  const [copied, setCopied] = useState(false)
  return (
    <div
      className={`flex items-center gap-1.5 mt-1 text-[10px] text-text-3 opacity-0 group-hover:opacity-100 transition-opacity select-none ${align === 'right' ? 'justify-end' : ''}`}
    >
      <button
        onClick={() => {
          copyRich(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
        className="flex items-center gap-1 hover:text-text-1"
        title="Copy message"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        {copied && <span>Copied</span>}
      </button>
      {timestamp && <span>{relativeTime(timestamp)}</span>}
    </div>
  )
}
