// src/renderer/components/optical-view/messages/tool-call-card.tsx
//
// Tool calls render as a single muted line — verb + human subject + status —
// the way the Claude desktop app shows "Ran skill/…". Raw commands, full
// paths, and outputs live behind a click, not in the user's face.
import React, { useState } from 'react'

export interface ToolCallCardProps {
  toolUseId: string
  name: string
  input: Record<string, unknown>
  result?: { text: string; isError: boolean }
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

/** Human one-liner for the collapsed row: a verb and what it acted on. */
function describe(name: string, input: Record<string, unknown>): { verb: string; subject: string } {
  const filePath = typeof input.file_path === 'string' ? input.file_path : ''
  switch (name) {
    case 'Read':  return { verb: 'Read', subject: basename(filePath) }
    case 'Write': return { verb: 'Wrote', subject: basename(filePath) }
    case 'Edit':  return { verb: 'Edited', subject: basename(filePath) }
    case 'Bash':  return { verb: 'Ran', subject: String(input.description ?? input.command ?? '') }
    case 'Glob':  return { verb: 'Globbed', subject: String(input.pattern ?? '') }
    case 'Grep':  return { verb: 'Searched', subject: String(input.pattern ?? '') }
    case 'WebFetch': {
      try { return { verb: 'Fetched', subject: new URL(String(input.url ?? '')).hostname } }
      catch { return { verb: 'Fetched', subject: String(input.url ?? '') } }
    }
    case 'WebSearch': return { verb: 'Searched web', subject: String(input.query ?? '') }
    case 'Skill': return { verb: 'Used skill', subject: String(input.skill ?? '') }
    case 'Agent':
    case 'Task':  return { verb: 'Delegated', subject: String(input.description ?? '') }
    case 'TodoWrite': return { verb: 'Updated', subject: 'todo list' }
    default: return { verb: name, subject: String(input.description ?? input.file_path ?? input.pattern ?? '') }
  }
}

function diffPreview(input: Record<string, unknown>): React.ReactNode {
  const oldStr = String(input.old_string ?? '')
  const newStr = String(input.new_string ?? '')
  if (!oldStr && !newStr) return null
  return (
    <div className="space-y-1 mt-1">
      {oldStr && <pre className="bg-[color-mix(in_srgb,var(--color-red-1)_10%,transparent)] text-red-1 p-2 rounded overflow-x-auto">{oldStr.split('\n').map((l) => '- ' + l).join('\n')}</pre>}
      {newStr && <pre className="bg-[color-mix(in_srgb,var(--color-green-1)_10%,transparent)] text-green-1 p-2 rounded overflow-x-auto">{newStr.split('\n').map((l) => '+ ' + l).join('\n')}</pre>}
    </div>
  )
}

const RESULT_PREVIEW_LINES = 30

export function ToolCallCard({ name, input, result }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const { verb, subject } = describe(name, input)
  const pending = !result
  const fullPath = typeof input.file_path === 'string' ? input.file_path : undefined

  const resultLines = result?.text ? result.text.split('\n') : []
  const truncated = resultLines.length > RESULT_PREVIEW_LINES
  const resultPreview = truncated
    ? resultLines.slice(0, RESULT_PREVIEW_LINES).join('\n') + `\n… +${resultLines.length - RESULT_PREVIEW_LINES} more lines`
    : result?.text ?? ''

  return (
    <div className="my-0.5 text-[11px] select-text">
      <button
        className="inline-flex max-w-full items-center gap-1.5 px-1.5 py-0.5 rounded text-left text-text-3 hover:bg-surface-1 hover:text-text-2"
        onClick={() => setOpen((v) => !v)}
        title={fullPath ?? (typeof input.command === 'string' ? input.command : undefined)}
      >
        <span className="shrink-0 w-3 text-center">
          {pending
            ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-1 animate-pulse" />
            : result.isError
              ? <span className="text-red-1">✗</span>
              : <span className="text-green-1">✓</span>}
        </span>
        <span className="truncate">
          <span className="font-medium">{verb}</span>
          {subject && <span> {subject}</span>}
        </span>
        <span className="shrink-0 opacity-50">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ml-4 mt-1 mb-1.5 p-2 rounded-md bg-surface-1 font-mono text-[10.5px] text-text-2 overflow-x-auto">
          {name === 'Bash' && typeof input.command === 'string' && (
            <pre className="whitespace-pre-wrap mb-1"><span className="text-text-3">$ </span>{input.command}</pre>
          )}
          {fullPath && <div className="text-text-3 mb-1">{fullPath}</div>}
          {name === 'Edit' && diffPreview(input)}
          {name === 'Write' && typeof input.content === 'string' && (
            <pre className="whitespace-pre-wrap max-h-[200px] overflow-y-auto">{input.content}</pre>
          )}
          {!['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep'].includes(name) && (
            <pre className="whitespace-pre-wrap max-h-[160px] overflow-y-auto">{JSON.stringify(input, null, 2)}</pre>
          )}
          {result && (
            <pre className={`whitespace-pre-wrap max-h-[260px] overflow-y-auto mt-1 ${result.isError ? 'text-red-1' : ''}`}>{resultPreview}</pre>
          )}
        </div>
      )}
    </div>
  )
}
