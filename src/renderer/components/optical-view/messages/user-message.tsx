// src/renderer/components/optical-view/messages/user-message.tsx
import React from 'react'
import type { RenderedMessage } from '../../../lib/use-claude-stream'
import { MessageMeta } from './message-meta'

export function UserMessage({ message }: { message: RenderedMessage }) {
  const text = message.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('\n')
  return (
    <div className="flex flex-col items-end mb-4 group">
      <div className="max-w-[80%] rounded-xl bg-surface-2 text-text-1 px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap select-text">
        {text}
      </div>
      <MessageMeta text={text} timestamp={message.timestamp} align="right" />
    </div>
  )
}
