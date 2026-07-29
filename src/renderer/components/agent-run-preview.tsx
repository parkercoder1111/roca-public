// src/renderer/components/agent-run-preview.tsx
//
// The click-into view for one sub-agent: its own transcript, rendered with the
// same optical message list the main chat uses. The sub-agent's lines are
// sidechain entries; within its own view they ARE the conversation, so we strip
// the sidechain markers before handing them to the shared reducer (which would
// otherwise skip them).
import React, { useEffect, useState } from 'react'
import type { AgentRun } from '@shared/types'
import type { StreamJsonEvent } from '@shared/stream-json-events'
import { reduceEvent, type RenderedMessage } from '../lib/use-claude-stream'
import { MessageList } from './optical-view/message-list'

function buildMessages(events: StreamJsonEvent[]): RenderedMessage[] {
  return events
    .map((e) => ({ ...e, isSidechain: false, parent_tool_use_id: undefined } as StreamJsonEvent))
    .reduce(reduceEvent, [] as RenderedMessage[])
}

function elapsed(run: AgentRun): string {
  const end = run.endedAt ?? Date.now()
  const s = Math.max(0, Math.round((end - run.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function AgentRunPreview({ run, getEvents, onBack }: {
  run: AgentRun
  getEvents: (runId: string) => Promise<StreamJsonEvent[]>
  onBack: () => void
}) {
  const [messages, setMessages] = useState<RenderedMessage[]>([])

  // Poll the run's transcript while it's live; one-shot once it's finished.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    const load = () => getEvents(run.id)
      .then((evs) => { if (!cancelled) setMessages(buildMessages(evs)) })
      .catch(() => {})
    load()
    if (run.status === 'running') timer = setInterval(load, 1000)
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [run.id, run.status, getEvents])

  const running = run.status === 'running'
  const dot = running ? 'bg-red-1 animate-pulse' : run.status === 'error' ? 'bg-red-1' : 'bg-green-1'
  const statusText = running ? `Running · ${elapsed(run)}` : run.status === 'error' ? 'Failed' : `Done · ${elapsed(run)}`

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-black/[0.06]">
        <button
          onClick={onBack}
          aria-label="Back to files"
          className="p-1 rounded-md text-text-3 hover:text-text-1 hover:bg-black/[0.06] transition-colors cursor-pointer shrink-0"
          title="Back"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-1 truncate leading-tight">{run.title}</div>
          <div className="text-[9px] text-text-3 mt-0.5">
            {run.subagentType ? `${run.subagentType} · ` : ''}{statusText}{run.steps ? ` · ${run.steps} steps` : ''}
          </div>
        </div>
      </div>
      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-[11px] text-text-3 italic">
            {running ? 'Spinning up…' : 'No activity recorded.'}
          </span>
        </div>
      ) : (
        <MessageList messages={messages} working={running} className="flex-1 overflow-y-auto" />
      )}
    </div>
  )
}
