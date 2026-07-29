// src/renderer/components/optical-view/message-list.tsx
import React, { useEffect, useRef, useState } from 'react'
import type { RenderedMessage } from '../../lib/use-claude-stream'
import { UserMessage } from './messages/user-message'
import { AssistantMessage } from './messages/assistant-message'

// Claude-Code-style activity phrases, rotated while a turn is in flight.
const WORKING_WORDS = [
  'Thinking', 'Pondering', 'Scheming', 'Brewing', 'Mulling it over', 'Noodling',
  'Percolating', 'Conjuring', 'Marinating', 'Crunching', 'Tinkering',
  'Sleuthing', 'Cogitating', 'Wrangling bits', 'Cooking', 'Working some magic',
  'Connecting dots', 'Plotting', 'Deliberating', 'Spelunking',
]

// "✱ 51s · Editing app.tsx…" — same shape as the Claude desktop app. When a
// concrete step is known (a running tool call) we name it via `label`; while
// claude is just thinking we fall back to the rotating whimsical words.
function WorkingIndicator({ label }: { label?: string | null }) {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * WORKING_WORDS.length))
  const [elapsed, setElapsed] = useState(0)
  // Elapsed counts the whole turn — tied to mount, not to the changing label.
  useEffect(() => {
    const startedAt = Date.now()
    const clock = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(clock)
  }, [])
  // Rotate whimsical words only when there's no concrete step to show.
  useEffect(() => {
    if (label) return
    const words = setInterval(() => setIdx((i) => (i + 1) % WORKING_WORDS.length), 2400)
    return () => clearInterval(words)
  }, [label])
  const text = label ?? WORKING_WORDS[idx]
  return (
    <div className="thinking-indicator flex items-center gap-1.5 text-[11px] text-text-3 select-none mb-4">
      <span className="thinking-glyph">✱</span>
      {/* Fixed-width mono slot so 9s → 10s → 100s never nudges the word. */}
      <span className="tabular-nums font-mono inline-block min-w-[2.4ch] text-right">{elapsed}s</span>
      <span aria-hidden>·</span>
      {/* Keyed on the word so each change replays the fade-up + sweep. */}
      <span key={text} className="thinking-word italic">{text}…</span>
    </div>
  )
}

interface Props {
  messages: RenderedMessage[]
  working?: boolean
  // The concrete in-flight step ("Editing app.tsx"), or null while just thinking.
  activity?: string | null
  className?: string
}

export function MessageList({ messages, working, activity, className }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const lastIdRef = useRef<string | null>(null)

  // Every new message — the user's send or Claude's answer — lands the view at
  // the bottom (first fill included). In-place updates (tool results filling
  // in) only stick when already reading the tail, so scrolling back through
  // history isn't yanked away mid-read.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || messages.length === 0) return
    const last = messages[messages.length - 1]
    const newMessage = last.id !== lastIdRef.current
    lastIdRef.current = last.id
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (newMessage || isAtBottom) el.scrollTop = el.scrollHeight
  }, [messages, working])

  if (messages.length === 0) {
    return (
      <div className={(className ?? '') + ' flex items-center justify-center'}>
        <span className="text-[12px] text-text-3">No conversation yet — send a message below.</span>
      </div>
    )
  }

  return (
    <div
      ref={scrollerRef}
      className={(className ?? '') + ' px-4 py-4'}
      onCopy={(e) => {
        // Selections copy as plain text — no beige backgrounds or theme
        // colors landing in Notes/Word/Gmail.
        const sel = window.getSelection()?.toString()
        if (!sel) return
        e.preventDefault()
        e.clipboardData.setData('text/plain', sel)
      }}
    >
      <div className="max-w-[860px] mx-auto">
        {messages.map((m) => {
          if (m.role === 'system') {
            const text = m.blocks[0]?.kind === 'text' ? m.blocks[0].text : ''
            return (
              <div key={m.id} className="flex justify-center mb-4">
                <span className="text-[11px] text-text-3 italic select-none">✓ {text}</span>
              </div>
            )
          }
          return m.role === 'user'
            ? <UserMessage key={m.id} message={m} />
            : <AssistantMessage key={m.id} message={m} />
        })}
        {working && <WorkingIndicator label={activity} />}
      </div>
    </div>
  )
}
