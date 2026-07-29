// src/renderer/components/optical-view/index.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useClaudeStream } from '../../lib/use-claude-stream'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
import { ContextMeter } from './context-meter'
import type { RenderedMessage, SessionStatus } from '../../lib/use-claude-stream'

interface Props {
  ptyId: string
  cwd: string
  taskId: number
}

// Human status — no process jargon. "exited" just means the chat needs the
// terminal's claude back; tell the user what to do, not what errno happened.
const STATUS_TEXT: Record<SessionStatus['state'], string> = {
  idle: '',
  starting: 'Connecting…',
  ready: 'Live',
  error: 'Connection trouble',
  exited: 'Session ended — restart Claude from the Terminal tab',
  remote: 'Running on the server — view it in the Terminal tab',
}

const DOT_COLOR: Record<SessionStatus['state'], string> = {
  idle:     'bg-text-3',
  starting: 'bg-purple-1 animate-pulse',
  ready:    'bg-green-1',
  error:    'bg-red-1',
  exited:   'bg-red-1',
  remote:   'bg-purple-1',
}

// The terminal session's permission mode, cycled with shift+tab in the TUI.
const PERMISSION_LABELS: Record<string, string> = {
  default: 'Ask permissions',
  normal: 'Ask permissions',
  acceptEdits: 'Accept edits',
  dontAsk: "Don't ask",
  auto: 'Auto',
  bypassPermissions: 'Bypass permissions',
  plan: 'Plan mode',
}

const MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

// Selectable permission modes. The TUI only *cycles* (shift+tab), so picking
// one presses shift+tab until the transcript reports the requested mode.
const PERMISSION_MODES = [
  { key: 'default', label: 'Ask permissions' },
  { key: 'acceptEdits', label: 'Accept edits' },
  { key: 'plan', label: 'Plan mode' },
  { key: 'auto', label: 'Auto' },
  { key: 'dontAsk', label: "Don't ask" },
  { key: 'bypassPermissions', label: 'Bypass permissions' },
]

/** The TUI logs "normal" for what the cycle calls "default" — same mode. */
function normalizeMode(mode?: string): string {
  return mode === 'normal' ? 'default' : mode ?? ''
}

const EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']

/** "claude-opus-4-8" → "Opus 4.8", "claude-fable-5" → "Fable 5". */
function modelLabel(model?: string): string {
  if (!model) return ''
  const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (!m) return model
  const name = m[1][0].toUpperCase() + m[1].slice(1)
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

/** True while claude is mid-turn: replying, running tools, or just sent-to. */
function isWorking(messages: RenderedMessage[]): boolean {
  // Local notices ("Model changed to …") don't end a turn — skip them.
  let last: RenderedMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'system') { last = messages[i]; break }
  }
  if (!last) return false
  if (last.streaming) return true
  if (last.role === 'user') {
    const text = last.blocks[0]?.kind === 'text' ? last.blocks[0].text : ''
    return !text.startsWith('[Request interrupted')
  }
  return last.blocks.some((b) => b.kind === 'tool_use' && !b.result)
}

// Present-tense verbs for the working line — what claude is doing right now.
const WORKING_VERB: Record<string, string> = {
  Read: 'Reading', Write: 'Writing', Edit: 'Editing', Bash: 'Running',
  Glob: 'Searching', Grep: 'Searching', WebFetch: 'Fetching', WebSearch: 'Searching the web',
  Skill: 'Using skill', Agent: 'Delegating', Task: 'Delegating', TodoWrite: 'Updating the to-do list',
}

/**
 * The concrete step claude is on right now — the first unresolved tool call in
 * the latest assistant turn ("Editing app.tsx", "Delegating: audit the API").
 * Returns null while it's only thinking, so the indicator falls back to the
 * rotating words instead of inventing activity.
 */
function currentActivity(messages: RenderedMessage[]): string | null {
  let last: RenderedMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'system') { last = messages[i]; break }
  }
  if (!last || last.role !== 'assistant') return null
  const pending = last.blocks.find((b) => b.kind === 'tool_use' && !b.result)
  if (!pending || pending.kind !== 'tool_use') return null
  const verb = WORKING_VERB[pending.name] ?? pending.name
  const raw = pending.input.description ?? pending.input.file_path ?? pending.input.pattern
    ?? pending.input.query ?? pending.input.skill ?? pending.input.command
  let subject = typeof raw === 'string' ? raw : ''
  if (pending.name === 'Read' || pending.name === 'Write' || pending.name === 'Edit') {
    subject = subject.split('/').pop() ?? subject
  }
  subject = subject.replace(/\s+/g, ' ').trim()
  if (subject.length > 48) subject = subject.slice(0, 47) + '…'
  return subject ? `${verb} ${subject}` : verb
}

// ── Footer building blocks ──────────────────────────────────────────────────

/** Footer text button with a popover that opens above and closes on outside click. */
function FooterMenu({ label, title, children }: { label: React.ReactNode; title?: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={title}
        className="text-[10px] text-text-3 hover:text-text-1 flex items-center gap-1"
      >
        {label}
        <svg className="w-2 h-2 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 z-50 min-w-[180px] rounded-lg bg-surface-1 hairline shadow-lg p-1 text-[11px]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuRow({ onClick, active, children }: { onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2.5 py-1.5 rounded-md flex items-center justify-between gap-2 hover:bg-surface-2 ${active ? 'text-text-1 font-medium' : 'text-text-2'}`}
    >
      {children}
      {active && <span className="text-green-1">✓</span>}
    </button>
  )
}

function StatusMenu({ status, onReconnect }: { status: SessionStatus; onReconnect: () => void }) {
  return (
    <FooterMenu
      title={status.sessionId ? `session ${status.sessionId.slice(0, 8)}` : undefined}
      label={
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${DOT_COLOR[status.state]}`} />
          {STATUS_TEXT[status.state] || 'Idle'}
        </span>
      }
    >
      {(close) => (
        <>
          <MenuRow onClick={() => { onReconnect(); close() }}>Reconnect to terminal session</MenuRow>
          {status.error && (
            <div className="px-2.5 py-1.5 text-red-1 whitespace-pre-wrap max-w-[300px]">{status.error}</div>
          )}
          {status.stderrTail.length > 0 && (
            <pre className="px-2.5 py-1.5 text-text-3 whitespace-pre-wrap max-h-[160px] overflow-y-auto font-mono text-[10px]">
              {status.stderrTail.join('\n')}
            </pre>
          )}
        </>
      )}
    </FooterMenu>
  )
}

// ── Plan usage (the numbers behind /usage) ─────────────────────────────────

interface UsageWindow { utilization?: number; resets_at?: string }
interface UsageData {
  five_hour?: UsageWindow | null
  seven_day?: UsageWindow | null
  seven_day_opus?: UsageWindow | null
  seven_day_sonnet?: UsageWindow | null
}

function resetsIn(iso?: string): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return 'resets soon'
  const h = Math.floor(ms / 3_600_000)
  if (h >= 24) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
  if (h >= 1) return `resets in ${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
  return `resets in ${Math.ceil(ms / 60_000)}m`
}

function UsageBar({ label, win }: { label: string; win: UsageWindow }) {
  const pct = Math.min(100, Math.max(0, win.utilization ?? 0))
  const fill = pct < 70 ? 'bg-green-1' : pct < 90 ? 'bg-purple-1' : 'bg-red-1'
  return (
    <div className="px-2.5 py-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-text-2">{label}</span>
        <span className="text-text-3 tabular-nums">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1 rounded-full bg-[color:var(--color-hairline)] overflow-hidden">
        <div className={`h-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-text-3 text-[9.5px] mt-0.5">{resetsIn(win.resets_at)}</div>
    </div>
  )
}

function UsageMenu() {
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    window.electronAPI.claudeStream.usage().then((r) => {
      if (r.ok) { setUsage(r.data as UsageData); setError(null) }
      else setError(r.error ?? 'unavailable')
    }).catch((e) => setError(String(e)))
  }
  return (
    <FooterMenu label={<span onMouseEnter={load} onClick={load}>Usage</span>} title="Plan usage">
      {() => (
        <div className="w-[230px]">
          {!usage && !error && <div className="px-2.5 py-2 text-text-3">Loading…</div>}
          {error && <div className="px-2.5 py-2 text-text-3">Usage unavailable ({error})</div>}
          {usage?.five_hour && <UsageBar label="Session (5-hour)" win={usage.five_hour} />}
          {usage?.seven_day && <UsageBar label="Week — all models" win={usage.seven_day} />}
          {usage?.seven_day_opus && <UsageBar label="Week — Opus" win={usage.seven_day_opus} />}
          {usage?.seven_day_sonnet && <UsageBar label="Week — Sonnet" win={usage.seven_day_sonnet} />}
        </div>
      )}
    </FooterMenu>
  )
}

// ── The view ────────────────────────────────────────────────────────────────

export function OpticalView({ ptyId, cwd, taskId }: Props) {
  const { messages, meta, send, status, reconnect, addNotice } = useClaudeStream(ptyId, cwd)
  const working = useMemo(() => isWorking(messages), [messages])
  const activity = useMemo(() => currentActivity(messages), [messages])

  // Session controls type slash commands / keys into the terminal's TUI, so
  // they only make sense when mirroring a live terminal claude.
  const interactive = !!status.mirrored
  const sendCommand = (cmd: string) => {
    // Straight to the session — bypasses the chat's optimistic echo so the
    // command doesn't linger as a phantom user bubble.
    window.electronAPI.claudeStream.send(ptyId, cmd)
  }
  // Drive the shift+tab cycle toward a chosen permission mode. Presses on a
  // fixed cadence — transcript confirmation can lag (or not come until the
  // next turn), so we never *wait* on it; we just stop the moment it agrees
  // or the press cap hits. The label shows the picked mode immediately.
  // Permission switching is confirmed against the terminal's own status line
  // (main process reads the screen after each shift+tab press) — the
  // transcript lags too much to drive this. The label pulses on the picked
  // mode until the screen confirms or reports the mode isn't available.
  const [targetMode, setTargetMode] = useState<string | null>(null)
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  const pickPermissionMode = async (key: string) => {
    setSwitchNotice(null)
    setTargetMode(key)
    try {
      const r = await window.electronAPI.claudeStream.setPermissionMode(ptyId, key)
      if (r.ok) {
        addNotice(`Permission mode changed to ${PERMISSION_LABELS[key] ?? key}`)
      } else {
        setSwitchNotice(`${PERMISSION_LABELS[key] ?? key} isn't available in this session`)
        setTimeout(() => setSwitchNotice(null), 4000)
      }
    } catch {
      setSwitchNotice('Could not switch mode')
      setTimeout(() => setSwitchNotice(null), 4000)
    } finally {
      setTargetMode(null)
    }
  }

  // Model/effort switches confirm slowly (model: next assistant reply) or
  // never (effort isn't logged) — show the picked value immediately.
  const [pendingModel, setPendingModel] = useState<{ id: string; label: string } | null>(null)
  useEffect(() => {
    if (pendingModel && meta.model?.startsWith(pendingModel.id)) setPendingModel(null)
  }, [meta.model, pendingModel])
  const [effortLevel, setEffortLevel] = useState<string | null>(null)

  const permissionLabel = meta.permissionMode
    ? PERMISSION_LABELS[meta.permissionMode] ?? meta.permissionMode
    : null

  return (
    <div
      className="flex flex-col h-full bg-surface-0 text-text-1"
      style={{ fontFamily: "Calibri, Seravek, 'Helvetica Neue', system-ui, sans-serif" }}
    >
      {status.state === 'remote' ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-[420px] text-center">
            <div className="text-text-1 text-sm font-medium mb-2">This conversation is running on the server</div>
            <div className="text-text-3 text-[12px] leading-relaxed">
              Its Claude session lives on the VM, so the optical view can't mirror it here.
              Switch to the <span className="text-text-1">Terminal tab</span> to see and continue this conversation.
            </div>
          </div>
        </div>
      ) : (
        <MessageList messages={messages} working={working} activity={activity} className="flex-1 overflow-y-auto" />
      )}
      <div className="shrink-0 px-4 pb-2 pt-1">
        <div className="max-w-[860px] mx-auto">
          {status.state !== 'remote' && <ChatInput taskId={taskId} ptyId={ptyId} onSend={send} />}
          <div className="flex items-center justify-between mt-1.5 px-1">
            <div className="flex items-center gap-4">
              <StatusMenu status={status} onReconnect={reconnect} />
              {permissionLabel && (
                interactive ? (
                  <FooterMenu
                    label={targetMode
                      ? <span className="animate-pulse">{PERMISSION_LABELS[targetMode] ?? targetMode}</span>
                      : permissionLabel}
                    title="Permission mode"
                  >
                    {(close) => (
                      <>
                        {PERMISSION_MODES.map((m) => (
                          <MenuRow
                            key={m.key}
                            active={normalizeMode(meta.permissionMode) === m.key}
                            onClick={() => { pickPermissionMode(m.key); close() }}
                          >
                            {m.label}
                          </MenuRow>
                        ))}
                      </>
                    )}
                  </FooterMenu>
                ) : (
                  <span className="text-[10px] text-text-3">{permissionLabel}</span>
                )
              )}
              <UsageMenu />
              {switchNotice && (
                <span className="text-[10px] text-red-1">{switchNotice}</span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <ContextMeter meta={meta} />
              {interactive ? (
                <>
                  <FooterMenu
                    label={effortLevel
                      ? `Effort: ${effortLevel === 'xhigh' ? 'Extra high' : effortLevel[0].toUpperCase() + effortLevel.slice(1)}`
                      : 'Effort'}
                    title="Reasoning effort (/effort)"
                  >
                    {(close) => (
                      <>
                        {EFFORT_LEVELS.map((level) => (
                          <MenuRow
                            key={level}
                            active={effortLevel === level}
                            onClick={() => {
                              sendCommand(`/effort ${level}`)
                              setEffortLevel(level)
                              addNotice(`Effort changed to ${level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1)}`)
                              close()
                            }}
                          >
                            {level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1)}
                          </MenuRow>
                        ))}
                      </>
                    )}
                  </FooterMenu>
                  <FooterMenu
                    label={pendingModel
                      ? <span className="animate-pulse">{pendingModel.label}</span>
                      : modelLabel(meta.model) || 'Model'}
                    title="Switch model (/model)"
                  >
                    {(close) => (
                      <>
                        {MODELS.map((m) => (
                          <MenuRow
                            key={m.id}
                            active={pendingModel ? pendingModel.id === m.id : meta.model?.startsWith(m.id)}
                            onClick={() => {
                              sendCommand(`/model ${m.id}`)
                              setPendingModel(m)
                              addNotice(`Model changed to ${m.label}`)
                              close()
                            }}
                          >
                            {m.label}
                          </MenuRow>
                        ))}
                      </>
                    )}
                  </FooterMenu>
                </>
              ) : (
                meta.model && <span className="text-[10px] text-text-3">{modelLabel(meta.model)}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
