// src/renderer/components/optical-view/chat-input/index.tsx
import React, { useEffect, useRef, useState } from 'react'
import { ROCA_COMMANDS } from '../../../lib/slash-commands'
import { uploadFiles } from '../../../upload-files'
import { SlashAutocomplete } from './slash-autocomplete'
import { UploadDropzone } from './upload-dropzone'

interface Props {
  taskId: number
  ptyId: string
  onSend: (text: string) => void
  className?: string
}

interface ScheduledItem {
  id: string
  text: string
  sendAtMs: number
}

const SCHEDULE_PRESETS: Array<{ label: string; atMs: () => number }> = [
  { label: 'In 30 minutes', atMs: () => Date.now() + 30 * 60_000 },
  { label: 'In 1 hour', atMs: () => Date.now() + 60 * 60_000 },
  { label: 'In 3 hours', atMs: () => Date.now() + 3 * 60 * 60_000 },
  {
    label: 'Tomorrow 9am',
    atMs: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      return d.getTime()
    },
  },
]

function formatWhen(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`
}

/** Clock button + popover: schedule the drafted message for later delivery. */
function ScheduleButton({ ptyId, draft, onScheduled }: { ptyId: string; draft: string; onScheduled: () => void }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<ScheduledItem[]>([])
  const ref = useRef<HTMLDivElement>(null)

  const refresh = () => {
    window.electronAPI.claudeStream.scheduleList(ptyId)
      .then((r) => { if (r.ok) setPending(r.items as ScheduledItem[]) })
      .catch(() => {})
  }

  useEffect(() => {
    if (!open) return
    refresh()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = async (atMs: number) => {
    if (!draft.trim()) return
    const r = await window.electronAPI.claudeStream.scheduleCreate(ptyId, draft.trim(), atMs)
    if (r.ok) {
      onScheduled()
      refresh()
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 p-1.5 rounded-md text-text-3 hover:text-text-1 hover:bg-surface-2"
        title="Schedule this message"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" strokeWidth={1.5} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 7v5l3 2" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 z-50 w-[240px] rounded-lg bg-surface-1 hairline shadow-lg p-1 text-[11px]">
          {draft.trim() ? (
            <>
              <div className="px-2.5 py-1.5 text-text-3">Send this message…</div>
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => { schedule(p.atMs()); setOpen(false) }}
                  className="w-full text-left px-2.5 py-1.5 rounded-md text-text-2 hover:bg-surface-2"
                >
                  {p.label}
                </button>
              ))}
              <div className="px-2.5 py-1.5">
                <input
                  type="datetime-local"
                  className="w-full bg-surface-0 hairline rounded px-1.5 py-1 text-[11px] text-text-2"
                  onChange={(e) => {
                    const ms = new Date(e.target.value).getTime()
                    if (Number.isFinite(ms) && ms > Date.now()) { schedule(ms); setOpen(false) }
                  }}
                />
              </div>
            </>
          ) : (
            <div className="px-2.5 py-1.5 text-text-3">Type a message first, then schedule it here.</div>
          )}
          {pending.length > 0 && (
            <>
              <div className="px-2.5 pt-2 pb-1 text-text-3 hairline-t mt-1">Scheduled</div>
              {pending.map((item) => (
                <div key={item.id} className="px-2.5 py-1 flex items-center gap-2 group">
                  <span className="text-text-3 shrink-0 tabular-nums">{formatWhen(item.sendAtMs)}</span>
                  <span className="truncate text-text-2 flex-1" title={item.text}>{item.text}</span>
                  <button
                    onClick={() => window.electronAPI.claudeStream.scheduleCancel(item.id).then(refresh)}
                    className="opacity-0 group-hover:opacity-100 text-red-1 shrink-0"
                    title="Cancel"
                  >✗</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface Attachment {
  path: string
  name: string
}

function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|heic)$/i.test(p)
}

export function ChatInput({ taskId, ptyId, onSend, className }: Props) {
  const [value, setValue] = useState('')
  // Pasted/dropped files ride along as chips, not raw paths in the text.
  // Their paths are appended to the message at send time.
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)

  const addAttachments = (paths: string[]) => {
    setAttachments((prev) => [
      ...prev,
      ...paths
        .filter((p) => !prev.some((a) => a.path === p))
        .map((p) => ({ path: p, name: p.split('/').pop() || p })),
    ])
  }

  // Flatten ROCA_COMMANDS once. The record's value type guarantees a
  // description string, but we still default-coalesce in case a future
  // entry forgets the field.
  const ALL_COMMANDS = React.useMemo(
    () => Object.entries(ROCA_COMMANDS).map(([command, def]) => ({
      command,
      description: def.description ?? '',
    })),
    []
  )

  const [acIndex, setAcIndex] = useState(0)
  const acOptions = React.useMemo(() => {
    if (!value.startsWith('/')) return []
    const q = value.slice(1).split(/\s/)[0].toLowerCase()
    return ALL_COMMANDS
      .filter((c) => c.command.toLowerCase().startsWith(q))
      .slice(0, 8)
  }, [value, ALL_COMMANDS])

  // The full outgoing message: typed text plus any attachment paths.
  const composed = [value.trim(), ...attachments.map((a) => a.path)].filter(Boolean).join('\n')

  const submit = () => {
    if (!composed) return
    onSend(composed)
    setValue('')
    setAttachments([])
    if (ref.current) ref.current.style.height = 'auto'
  }

  return (
    <div className={(className ?? '') + ' relative'}>
        <SlashAutocomplete
          options={acOptions}
          selectedIndex={acIndex}
          onSelect={(o) => { setValue(o.command + ' '); setAcIndex(0) }}
        />
        <UploadDropzone
          taskId={taskId}
          onUploaded={addAttachments}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
              {attachments.map((a) => (
                <span key={a.path} className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-surface-1 hairline text-[11px] text-text-2" title={a.path}>
                  {isImagePath(a.path) ? (
                    <svg className="w-3 h-3 text-text-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <rect x="3" y="5" width="18" height="14" rx="2" strokeWidth={1.5} />
                      <circle cx="8.5" cy="10" r="1.5" strokeWidth={1.5} />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 16l-5-5-4 4-2-2-7 6" />
                    </svg>
                  ) : (
                    <svg className="w-3 h-3 text-text-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  )}
                  <span className="max-w-[160px] truncate">{a.name}</span>
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                    className="p-0.5 rounded text-text-3 hover:text-red-1"
                    title="Remove"
                  >
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 px-3 py-2 rounded-xl bg-surface-1 hairline">
            <textarea
              ref={ref}
              rows={1}
              value={value}
              placeholder="Type / for commands"
              className="no-focus-ring flex-1 bg-transparent resize-none outline-none text-[13px] leading-relaxed py-1 max-h-[200px]"
              onChange={(e) => {
                setValue(e.target.value)
                setAcIndex(0)
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 200) + 'px'
              }}
              onPaste={async (e) => {
                const files = Array.from(e.clipboardData.files)
                const hasFileItem = files.length > 0 ||
                  Array.from(e.clipboardData.items).some((i) => i.kind === 'file')
                if (!hasFileItem) return // plain text paste — let the browser handle it
                e.preventDefault()
                let paths: string[] = []
                if (files.length > 0) {
                  const results = await uploadFiles(taskId, files)
                  paths = results
                    .map((r: { path?: string }) => r.path)
                    .filter((p): p is string => !!p)
                }
                if (paths.length === 0) {
                  // Screenshots/copied images don't always surface as web File
                  // objects — read the macOS clipboard directly (same path the
                  // terminal view uses).
                  const r = await window.electronAPI.pasteImage().catch(() => null)
                  if (r?.ok && r.path) paths = [r.path]
                }
                if (paths.length) addAttachments(paths)
              }}
              onKeyDown={(e) => {
                if (acOptions.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex((i) => Math.min(i + 1, acOptions.length - 1)); return }
                  if (e.key === 'ArrowUp')   { e.preventDefault(); setAcIndex((i) => Math.max(i - 1, 0)); return }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault()
                    const opt = acOptions[acIndex]
                    setValue(opt.command + ' ')
                    setAcIndex(0)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <ScheduleButton ptyId={ptyId} draft={composed} onScheduled={() => { setValue(''); setAttachments([]) }} />
            <button
              onClick={submit}
              disabled={!composed}
              className="shrink-0 p-1.5 rounded-full bg-purple-1 text-paper-cream disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
              title="Send (Enter)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </UploadDropzone>
    </div>
  )
}
