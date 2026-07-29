import type { ScribeRecording, CalEvent } from './types'

interface Props {
  recordings: ScribeRecording[]
  upcoming: CalEvent[]
  selectedId: number | null
  onSelect: (id: number) => void
  status: string
  onStart: () => void
  onStop: () => void
  onStartEvent: (e: CalEvent) => void
}

function eventTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function startedLabel(iso: string): string {
  try {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

// A small status dot instead of a word — reads faster and looks sharper.
function StatusDot({ status }: { status: string }) {
  const live = status === 'recording' || status === 'transcribing'
  const working = status === 'transcribed' || status === 'cleaning' || status === 'noting'
  const color = live
    ? 'var(--color-oxblood)'
    : working
      ? 'var(--voice-color-processing)'
      : status === 'error'
        ? 'var(--color-red-1)'
        : 'var(--color-green-1)'
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${live ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    />
  )
}

// Only surface a word for live/failed — the processing states stay quiet so
// finished recordings just sit there and notes appear when they're ready.
function statusWord(status: string): string {
  if (status === 'recording' || status === 'transcribing') return 'recording'
  if (status === 'error') return 'failed'
  return ''
}

export function ScribeList({
  recordings,
  upcoming,
  selectedId,
  onSelect,
  status,
  onStart,
  onStop,
  onStartEvent,
}: Props) {
  const recording = status === 'recording' || status === 'transcribing'

  return (
    <div className="w-[248px] shrink-0 flex flex-col min-h-0 border-r border-black/[0.06] bg-surface-1/40">
      {/* Record control */}
      <div className="p-2">
        {recording ? (
          <button
            onClick={onStop}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] font-semibold text-white transition-colors"
            style={{ background: 'var(--color-oxblood)' }}
          >
            <span className="animate-pulse w-2 h-2 rounded-full bg-white/90" />
            {status === 'transcribing' ? 'Stop · transcribing…' : 'Stop recording'}
          </button>
        ) : (
          <button
            onClick={onStart}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg hairline text-[11px] font-semibold text-purple-1 hover:bg-purple-2/60 transition-colors"
          >
            <span className="w-2 h-2 rounded-full" style={{ background: 'var(--color-oxblood)' }} />
            Record a meeting
          </button>
        )}
      </div>

      {/* Coming up */}
      {upcoming.length > 0 && (
        <div className="pb-1">
          <div className="px-3 pt-1 pb-1 mono-caps text-[9px] text-text-3">Coming up</div>
          {upcoming.slice(0, 4).map((e) => (
            <div key={e.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-black/[0.03]">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-text-1 truncate leading-tight">{e.title}</div>
                <div className="mono text-[9px] tabular text-text-3">{eventTime(e.start)}</div>
              </div>
              {!recording && (
                <button
                  onClick={() => onStartEvent(e)}
                  className="shrink-0 text-[9px] font-semibold text-purple-1 opacity-0 group-hover:opacity-100 hover:underline transition-opacity"
                >
                  Start
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Recordings */}
      <div className="px-3 pt-2 pb-1 mono-caps text-[9px] text-text-3">Recordings</div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
        {recordings.length === 0 ? (
          <p className="px-2 py-6 text-center mono text-[10px] text-text-3/60">No recordings yet</p>
        ) : (
          recordings.map((r) => {
            const active = selectedId === r.id
            return (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                className={`w-full text-left px-2.5 py-2 mb-0.5 rounded-lg transition-colors ${
                  active ? 'bg-surface-0 shadow-sm' : 'hover:bg-black/[0.03]'
                }`}
              >
                <div className="text-[11px] font-semibold text-text-1 truncate leading-tight">{r.title}</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <StatusDot status={r.status} />
                  <span className="mono text-[9px] tabular text-text-3">{startedLabel(r.started_at)}</span>
                  {statusWord(r.status) && (
                    <span className="text-[9px] text-text-3/70 truncate">· {statusWord(r.status)}</span>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
