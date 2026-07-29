// src/renderer/components/optical-view/messages/assistant-message.tsx
import React, { useState } from 'react'
import type { RenderedMessage } from '../../../lib/use-claude-stream'
import { renderMarkdownStyled } from '../../../lib/render-markdown'
import { ToolCallCard } from './tool-call-card'
import { MessageMeta } from './message-meta'

// Thinking stays tucked behind a one-line disclosure (like the Claude app)
// so long reasoning doesn't drown the actual reply. Streams expanded.
function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  const expanded = open || !!streaming
  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] italic text-text-3 hover:text-text-2 select-none"
      >
        {expanded ? '▾' : '▸'} {streaming ? 'Thinking…' : 'Thought'}
      </button>
      {expanded && (
        <div className="text-[12px] italic text-text-3 border-l-2 border-[color:var(--color-hairline)] pl-3 mt-1 whitespace-pre-wrap select-text">
          {text}
        </div>
      )}
    </div>
  )
}

// Split on blank lines into real paragraphs (the markdown renderer joins
// single newlines with <br>, which reads as one undifferentiated wall).
// Fenced code blocks keep their blank lines.
export function splitParagraphs(text: string): string[] {
  const out: string[] = []
  let buf: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence
    if (!inFence && line.trim() === '') {
      if (buf.length) { out.push(buf.join('\n')); buf = [] }
    } else {
      buf.push(line)
    }
  }
  if (buf.length) out.push(buf.join('\n'))
  return out
}

export function AssistantMessage({ message }: { message: RenderedMessage }) {
  const plain = message.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('\n')

  // Tool-only updates (no prose) read as one activity stream — keep them
  // tight instead of giving each the full between-turns gap. An empty text
  // block (Claude sometimes emits one beside a tool call) doesn't count as
  // prose, so a bare tool turn still hugs rather than taking the wide margin.
  const hasProse = message.blocks.some(
    (b) => (b.kind === 'text' || b.kind === 'thinking') && b.text.trim() !== '',
  )

  return (
    <div className={`${hasProse ? 'mb-4' : 'mb-1'} group`}>
      {message.blocks.map((b, i) => {
        if (b.kind === 'text') {
          if (!b.text.trim()) return null
          return (
            <div key={i} className="optical-prose text-[13px] leading-[1.7] select-text space-y-3">
              {splitParagraphs(b.text).map((para, j) => (
                <div key={j} dangerouslySetInnerHTML={{ __html: renderMarkdownStyled(para) }} />
              ))}
            </div>
          )
        }
        if (b.kind === 'thinking') {
          return <ThinkingBlock key={i} text={b.text} streaming={message.streaming && i === message.blocks.length - 1} />
        }
        return (
          <ToolCallCard
            key={i}
            toolUseId={b.toolUseId}
            name={b.name}
            input={b.input}
            result={b.result}
          />
        )
      })}
      {message.streaming && (
        <span className="inline-block w-2 h-3.5 ml-0.5 align-text-bottom bg-text-3 animate-pulse" />
      )}
      {plain && !message.streaming && (
        <MessageMeta text={plain} timestamp={message.timestamp} align="left" />
      )}
    </div>
  )
}
