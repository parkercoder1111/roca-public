// src/renderer/lib/use-claude-stream.ts
import { useEffect, useState, useCallback, useRef } from 'react'
import type { StreamJsonEvent } from '@shared/stream-json-events'

export interface RenderedMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  blocks: Array<
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown>; result?: ToolResultBlock }
  >
  streaming?: boolean
  usage?: { input: number; output: number; cacheRead?: number }
  timestamp?: number // epoch ms, from the transcript line (or send time for local echoes)
}

export interface ToolResultBlock {
  text: string
  isError: boolean
}

export interface SessionMeta {
  sessionId?: string
  model?: string
  cwd?: string
  totalTokens?: number
  permissionMode?: string
}

export type SessionState = 'idle' | 'starting' | 'ready' | 'error' | 'exited' | 'remote'

export interface SessionStatus {
  state: SessionState
  sessionId?: string
  cwd?: string
  exitCode?: number | null
  error?: string
  stderrTail: string[] // last N stderr lines for inline display
  eventsSeen: number
  // True when this view mirrors the terminal's live claude (vs a headless
  // fork). Mirrored sessions accept TUI controls: /model, /effort, shift+tab.
  mirrored?: boolean
}

const STDERR_TAIL_LIMIT = 12

export function useClaudeStream(ptyId: string, cwd: string) {
  const [messages, setMessages] = useState<RenderedMessage[]>([])
  const [meta, setMeta] = useState<SessionMeta>({})
  const [status, setStatus] = useState<SessionStatus>({ state: 'idle', stderrTail: [], eventsSeen: 0 })
  // The session id we're currently rendering. A later status carrying a
  // different id means we've been rebound to another conversation — clear
  // before its full replay so the two don't stack.
  const renderedSessionRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI.claudeStream

    // New (ptyId, cwd) binding — drop the prior session's transcript so a
    // rebind never shows the old conversation while fresh history replays on
    // top of it.
    setMessages([])
    setMeta({})
    renderedSessionRef.current = undefined
    setStatus({ state: 'starting', stderrTail: [], eventsSeen: 0 })

    api.start(ptyId, cwd).catch((err) => {
      if (cancelled) return
      setStatus((s) => ({ ...s, state: 'error', error: `start failed: ${String(err)}` }))
    })

    const offEvent = api.onEvent(ptyId, (e) => {
      if (cancelled) return
      // eslint-disable-next-line no-console
      console.debug('[claude-stream] event:', e)
      setStatus((s) => ({
        ...s,
        state: s.state === 'starting' ? 'ready' : s.state,
        eventsSeen: s.eventsSeen + 1,
      }))
      setMessages((prev) => reduceEvent(prev, e))
      setMeta((prev) => reduceMeta(prev, e))
    })

    // History replays and mirror drains arrive as one array → one render.
    const offBatch = api.onEventBatch?.(ptyId, (events) => {
      if (cancelled || events.length === 0) return
      setStatus((s) => ({
        ...s,
        state: s.state === 'starting' ? 'ready' : s.state,
        eventsSeen: s.eventsSeen + events.length,
      }))
      setMessages((prev) => events.reduce(reduceEvent, prev))
      setMeta((prev) => events.reduce(reduceMeta, prev))
    }) ?? (() => {})

    const offStatus = api.onStatus?.(ptyId, (st) => {
      if (cancelled) return
      // eslint-disable-next-line no-console
      console.debug('[claude-stream] status:', st)
      // A status with a different session id means the terminal restarted
      // claude or the mirror re-resolved onto another conversation. Clear so
      // the incoming full replay starts clean instead of stacking on the old
      // transcript. (The fork path emits its id once at start and reports the
      // post-fork uuid as an event, not a status, so this never mis-fires.)
      if (st.sessionId && renderedSessionRef.current && st.sessionId !== renderedSessionRef.current) {
        setMessages([])
        setMeta({})
      }
      if (st.sessionId) renderedSessionRef.current = st.sessionId
      setStatus((s) => ({ ...s, ...st, state: (st.state as SessionState) || s.state }))
    }) ?? (() => {})

    const offError = api.onError?.(ptyId, (err) => {
      if (cancelled) return
      console.error('[claude-stream] error:', err)
      setStatus((s) => ({ ...s, state: 'error', error: err }))
    }) ?? (() => {})

    const offStderr = api.onStderr?.(ptyId, (text) => {
      if (cancelled) return
      console.warn('[claude-stream] stderr:', text)
      const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean)
      if (!lines.length) return
      setStatus((s) => ({
        ...s,
        stderrTail: [...s.stderrTail, ...lines].slice(-STDERR_TAIL_LIMIT),
      }))
    }) ?? (() => {})

    const offExit = api.onExit(ptyId, (code) => {
      if (cancelled) return
      console.warn('[claude-stream] exit:', code)
      setStatus((s) => ({ ...s, state: 'exited', exitCode: code }))
    })

    return () => {
      cancelled = true
      offEvent()
      offBatch()
      offStatus()
      offError()
      offStderr()
      offExit()
    }
  }, [ptyId, cwd])

  // Tear down and rebuild the stream (e.g. claude restarted in the terminal).
  const reconnect = useCallback(() => {
    setMessages([])
    setMeta({})
    setStatus({ state: 'starting', stderrTail: [], eventsSeen: 0 })
    const api = window.electronAPI.claudeStream
    api.stop(ptyId)
      .catch(() => {})
      .then(() => api.start(ptyId, cwd))
      .catch((err) => {
        setStatus((s) => ({ ...s, state: 'error', error: `reconnect failed: ${String(err)}` }))
      })
  }, [ptyId, cwd])

  // Local system notice in the chat ("Model changed to …") — display
  // only, never sent to claude.
  const addNotice = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `notice-${Date.now()}`, role: 'system', blocks: [{ kind: 'text', text }], timestamp: Date.now() },
    ])
  }, [])

  const send = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', blocks: [{ kind: 'text', text }], timestamp: Date.now() },
    ])
    // eslint-disable-next-line no-console
    console.debug('[claude-stream] send:', text)
    window.electronAPI.claudeStream.send(ptyId, text).then((r) => {
      if (!r.ok) {
        setStatus((s) => ({ ...s, state: 'error', error: 'send failed: no active session' }))
      }
    }).catch((err) => {
      setStatus((s) => ({ ...s, state: 'error', error: `send error: ${String(err)}` }))
    })
  }, [ptyId])

  return { messages, meta, send, status, reconnect, addNotice }
}

export function reduceMeta(prev: SessionMeta, e: StreamJsonEvent): SessionMeta {
  if (e.type === 'system' && e.subtype === 'init') {
    return { ...prev, sessionId: e.session_id, model: e.model, cwd: e.cwd }
  }
  if (e.type === 'permission-mode') {
    return { ...prev, permissionMode: e.permissionMode }
  }
  if (e.type === 'assistant') {
    // Mirrored transcripts never emit a system:init, so pick the model (and
    // token usage) off the assistant messages themselves.
    return {
      ...prev,
      model: e.message.model ?? prev.model,
      totalTokens: e.message.usage
        ? e.message.usage.input_tokens + (e.message.usage.cache_read_input_tokens ?? 0) + e.message.usage.output_tokens
        : prev.totalTokens,
    }
  }
  if (e.type === 'result' && e.usage) {
    return {
      ...prev,
      totalTokens: e.usage.input_tokens + (e.usage.cache_read_input_tokens ?? 0) + e.usage.output_tokens,
    }
  }
  return prev
}

// Harness-injected user lines that aren't things the user typed: slash-command
// envelopes, hook stdout, caveat banners. Matched against the cleaned text.
const META_LINE_RE = /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)/

/** Strip system-reminder blocks the harness injects into user messages. */
function cleanUserText(raw: string): string {
  return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/**
 * Compare a local optimistic echo against its transcript counterpart. The TUI
 * rewrites pasted file paths into "[Image #N]" markers, so the two texts
 * differ literally while being the same message — normalize both shapes away.
 */
function normalizeForEcho(s: string): string {
  return s
    .replace(/\[Image #\d+\]\s*/g, '')
    .split('\n')
    .filter((line) => !/^\/\S+$/.test(line.trim()))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Stable-enough id for transcript user lines that lack a uuid. */
function textHash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Single in-flight assistant message assembled from partial stream deltas;
// replaced by the complete assistant event when the turn finishes.
const STREAMING_ID = '__streaming__'

export function reduceEvent(prev: RenderedMessage[], e: StreamJsonEvent): RenderedMessage[] {
  if (e.type === 'assistant') {
    // Subagent traffic (sidechain transcripts / parented tool streams) would
    // interleave confusingly with the main conversation — skip it.
    if (e.isSidechain || e.parent_tool_use_id) return prev
    const msg: RenderedMessage = {
      id: e.message.id ?? e.uuid ?? `assistant-${prev.length}`,
      role: 'assistant',
      blocks: e.message.content
        .map((c) => {
          if (c.type === 'text') return { kind: 'text' as const, text: c.text }
          if (c.type === 'thinking') return { kind: 'thinking' as const, text: c.thinking }
          return { kind: 'tool_use' as const, toolUseId: c.id, name: c.name, input: c.input }
        })
        // Transcripts store redacted thinking as empty strings — nothing to show.
        .filter((b) => b.kind !== 'thinking' || b.text.trim().length > 0),
      streaming: false,
      usage: e.message.usage
        ? { input: e.message.usage.input_tokens, output: e.message.usage.output_tokens, cacheRead: e.message.usage.cache_read_input_tokens }
        : undefined,
      timestamp: e.timestamp ? Date.parse(e.timestamp) : undefined,
    }
    const withoutPending = prev.filter((m) => m.id !== STREAMING_ID)
    // Claude appends one transcript line per content block, all sharing the
    // message id — merge rather than replace so earlier blocks survive.
    const idx = withoutPending.findIndex((m) => m.id === msg.id)
    if (idx >= 0) {
      const next = withoutPending.slice()
      const seen = new Set(next[idx].blocks.map((b) => JSON.stringify(b)))
      const merged = [...next[idx].blocks, ...msg.blocks.filter((b) => !seen.has(JSON.stringify(b)))]
      next[idx] = { ...msg, blocks: merged, timestamp: next[idx].timestamp ?? msg.timestamp }
      return next
    }
    return [...withoutPending, msg]
  }

  if (e.type === 'stream_event') {
    const se = e.event
    const deltaText = se.type === 'content_block_delta' ? (se.delta?.text ?? se.delta?.thinking) : undefined
    if (!deltaText) return prev
    const kind = se.delta?.type === 'thinking_delta' ? ('thinking' as const) : ('text' as const)
    const idx = prev.findIndex((m) => m.id === STREAMING_ID)
    if (idx < 0) {
      return [...prev, { id: STREAMING_ID, role: 'assistant', blocks: [{ kind, text: deltaText }], streaming: true }]
    }
    const next = prev.slice()
    const msg = next[idx]
    const last = msg.blocks[msg.blocks.length - 1]
    const blocks = last && last.kind === kind
      ? [...msg.blocks.slice(0, -1), { kind, text: (last as { text: string }).text + deltaText }]
      : [...msg.blocks, { kind, text: deltaText }]
    next[idx] = { ...msg, blocks }
    return next
  }

  if (e.type === 'user') {
    if (e.isSidechain) return prev
    const toolResults = Array.isArray(e.message.content)
      ? (e.message.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>)
          .filter((b) => b.type === 'tool_result')
      : []
    if (toolResults.length > 0) {
      const next = prev.slice()
      for (const tr of toolResults) {
        for (let i = next.length - 1; i >= 0; i--) {
          const msg = next[i]
          const blockIdx = msg.blocks.findIndex((b) => b.kind === 'tool_use' && b.toolUseId === tr.tool_use_id)
          if (blockIdx >= 0) {
            const block = msg.blocks[blockIdx]
            if (block.kind === 'tool_use') {
              const text = typeof tr.content === 'string'
                ? tr.content
                : Array.isArray(tr.content)
                  ? (tr.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
                  : ''
              const updated = { ...block, result: { text, isError: !!tr.is_error } }
              const newBlocks = msg.blocks.slice()
              newBlocks[blockIdx] = updated
              next[i] = { ...msg, blocks: newBlocks }
            }
            break
          }
        }
      }
      return next
    }

    // A real user turn (typed in the terminal or replayed from the
    // transcript). Filter out harness-injected meta lines, then render.
    if (e.isMeta) return prev
    const raw = typeof e.message.content === 'string'
      ? e.message.content
      : e.message.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n')
    const text = cleanUserText(raw)
    if (!text || META_LINE_RE.test(text)) return prev
    if (text.startsWith('Base directory for this skill:')) return prev // Skill-tool expansion
    // Dedupe against the most recent user turn — not just the last message,
    // because assistant activity can land between the optimistic local echo
    // and its transcript counterpart (sends during an active turn). The
    // local echo carries raw attachment paths where the transcript has
    // "[Image #N]" markers, so both shapes are normalized before comparing.
    for (let i = prev.length - 1; i >= 0; i--) {
      const m = prev[i]
      if (m.role !== 'user') continue
      const mText = m.blocks[0]?.kind === 'text' ? m.blocks[0].text.trim() : ''
      if (mText === text || (m.id.startsWith('local-') && normalizeForEcho(mText) === normalizeForEcho(text))) {
        // Same message — adopt the transcript's identity onto the echo.
        const next = prev.slice()
        const id = e.uuid && !prev.some((p) => p.id === e.uuid) ? e.uuid : m.id
        next[i] = { ...m, id, timestamp: m.timestamp ?? (e.timestamp ? Date.parse(e.timestamp) : undefined) }
        return next
      }
      break // only the most recent user turn is a dedupe candidate
    }
    const id = e.uuid ?? `user-${prev.length}-${textHash(text)}`
    if (prev.some((m) => m.id === id)) return prev
    return [...prev, {
      id,
      role: 'user',
      blocks: [{ kind: 'text', text }],
      timestamp: e.timestamp ? Date.parse(e.timestamp) : undefined,
    }]
  }

  return prev
}
