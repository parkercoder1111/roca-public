import React, { useEffect, useState, useCallback } from 'react'
import type { ScribeRecording, ScribeSegment } from './types'

interface Props {
  id: number
  live: boolean
}

type View = 'enhanced' | 'transcript'

// Meeting detail: Enhanced notes (AI) ⇄ Transcript, plus an "Ask anything" bar.
export function ScribeDetail({ id, live }: Props) {
  const [rec, setRec] = useState<ScribeRecording | undefined>()
  const [segs, setSegs] = useState<ScribeSegment[]>([])
  const [view, setView] = useState<View | null>(null) // null = auto: transcript until notes exist, then enhanced
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const load = useCallback(async () => {
    const r = await window.electronAPI.scribe.get(id)
    setRec(r.recording as ScribeRecording | undefined)
    setSegs((r.segments as ScribeSegment[]) ?? [])
  }, [id])

  useEffect(() => {
    setAnswer(null)
    load()
  }, [id, load])

  useEffect(() => {
    if (!live) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [live, load])

  useEffect(
    () => window.electronAPI.scribe.onUpdated((p) => { if (p.recordingId === id) load() }),
    [id, load]
  )

  // Keep the editable title in sync when a different recording loads (not on
  // every poll — so it never clobbers what you're typing).
  useEffect(() => { if (rec?.id) setTitleDraft(rec.title) }, [rec?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveTitle = useCallback(() => {
    const t = titleDraft.trim()
    if (t && t !== rec?.title) window.electronAPI.scribe.rename(id, t)
  }, [titleDraft, rec?.title, id])

  // Auto view: show the transcript (always available) until notes land, then
  // quietly surface the enhanced notes. The user can still toggle explicitly.
  const effectiveView: View = view ?? (rec?.notes_md ? 'enhanced' : 'transcript')

  const runAsk = useCallback(
    async (q: string) => {
      if (!q.trim() || asking) return
      setAsking(true)
      setAnswer(null)
      const res = await window.electronAPI.scribe.ask(id, q)
      setAnswer('answer' in res ? res.answer : `Error: ${res.error}`)
      setAsking(false)
    },
    [id, asking]
  )

  const runFollowup = useCallback(async () => {
    if (asking) return
    setAsking(true)
    setAnswer(null)
    const res = await window.electronAPI.scribe.followupEmail(id)
    setAnswer('answer' in res ? res.answer : `Error: ${res.error}`)
    setAsking(false)
  }, [id, asking])

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-black/[0.06]">
        <input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setTitleDraft(rec?.title ?? ''); (e.target as HTMLInputElement).blur() }
          }}
          placeholder="Untitled meeting"
          title="Click to rename"
          className="flex-1 min-w-0 bg-transparent text-[16px] font-semibold text-text-1 tracking-[-0.02em] rounded px-1.5 -ml-1.5 py-0.5 border-0 focus:outline-none hover:bg-black/[0.03] focus:bg-black/[0.05] transition-colors"
        />
        {live && (
          <span className="flex items-center gap-1.5 mono text-[9px] text-text-3">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--color-oxblood)' }} />
            recording
          </span>
        )}
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-black/[0.05] text-[10px] font-semibold">
          {(['enhanced', 'transcript'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded-md transition-colors capitalize ${
                effectiveView === v ? 'bg-surface-0 text-text-1 shadow-sm' : 'text-text-3 hover:text-text-2'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="max-w-[680px]">
          {effectiveView === 'enhanced' ? (
            rec?.notes_md ? (
              <MarkdownLite md={rec.notes_md} />
            ) : (
              <div className="mono text-[10px] text-text-3">Notes will appear here once the meeting is processed.</div>
            )
          ) : (
            <TranscriptView cleaned={rec?.cleaned_transcript} segs={segs} live={live} />
          )}
        </div>
      </div>

      {/* Ask bar */}
      <div className="border-t border-black/[0.06] px-4 py-3 space-y-2">
        {answer && (
          <div className="max-w-[680px] bg-surface-1 hairline rounded-xl p-3.5 text-[12.5px] text-text-1 leading-relaxed whitespace-pre-wrap max-h-56 overflow-auto">
            {answer}
          </div>
        )}
        <div className="max-w-[680px] flex items-center gap-2 px-3.5 py-2.5 rounded-xl hairline transition-colors focus-within:border-purple-1/40">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runAsk(question) }}
            placeholder="Ask anything about this meeting…"
            className="flex-1 min-w-0 bg-transparent text-[12.5px] text-text-1 placeholder-text-3/55 focus:outline-none border-0"
          />
          <button
            onClick={() => runAsk(question)}
            disabled={asking}
            className="shrink-0 mono text-[10px] font-semibold text-purple-1 disabled:opacity-40 hover:opacity-70 transition-opacity"
          >
            {asking ? 'thinking…' : 'Ask'}
          </button>
          <span className="text-text-3/30">·</span>
          <button
            onClick={runFollowup}
            disabled={asking}
            className="shrink-0 text-[10px] text-text-3 hover:text-text-1 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            Follow-up email
          </button>
        </div>
      </div>
    </div>
  )
}

type Turn = { speaker: 'me' | 'them'; text: string }

// Parse the cleaned transcript into speaker turns. Returns [] when NOT a single
// label is present — that means cleanup stripped attribution, so the caller
// should fall back to the raw segments (which always carry the correct channel
// label) instead of guessing.
function parseCleaned(cleaned: string): Turn[] {
  const rows = cleaned.split('\n').map((l) => l.trim()).filter(Boolean)
  const parsed = rows.map((l) => {
    const m = l.match(/^(Me|Them):\s*(.*)$/i)
    return m
      ? { speaker: (m[1].toLowerCase() === 'me' ? 'me' : 'them') as 'me' | 'them', text: m[2] }
      : { speaker: null as 'me' | 'them' | null, text: l }
  })
  if (parsed.every((p) => p.speaker === null)) return [] // no labels at all → fall back to segs
  // Unlabeled continuation lines inherit the previous speaker — never default-paint.
  let last: 'me' | 'them' = parsed.find((p) => p.speaker)?.speaker ?? 'them'
  return parsed.map((p) => {
    if (p.speaker) last = p.speaker
    return { speaker: last, text: p.text }
  })
}

function TranscriptView({
  cleaned,
  segs,
  live,
}: {
  cleaned?: string | null
  segs: ScribeSegment[]
  live: boolean
}) {
  const fromCleaned = cleaned ? parseCleaned(cleaned) : []
  const lines: Turn[] = fromCleaned.length
    ? fromCleaned
    : segs
        .filter((s) => s.text?.trim() && !/^\[BLANK_AUDIO\]$/i.test(s.text.trim()))
        .map((s) => ({ speaker: (s.speaker === 'me' ? 'me' : 'them') as 'me' | 'them', text: s.text }))

  if (lines.length === 0) {
    return (
      <div className="mono text-[10px] text-text-3">
        {live ? 'Listening — transcript fills in every couple of minutes…' : 'No transcript.'}
      </div>
    )
  }

  // If it's genuinely one speaker throughout, drop the redundant gutter and just
  // read as prose — but drive that off the ACTUAL labels, not a cleanup guess.
  const oneSpeaker = lines.every((l) => l.speaker === lines[0].speaker)
  if (oneSpeaker) {
    return (
      <div className="space-y-2.5">
        {lines.map((l, i) => (
          <p key={i} className="text-[12.5px] text-text-1 leading-relaxed">{l.text}</p>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {lines.map((l, i) => (
        <div key={i} className="flex gap-2.5">
          <span
            className={`mono-caps text-[9px] pt-0.5 w-9 shrink-0 ${
              l.speaker === 'me' ? 'text-purple-1' : 'text-text-3'
            }`}
          >
            {l.speaker === 'me' ? 'Me' : 'Them'}
          </span>
          <span className="text-[12.5px] text-text-1 leading-relaxed">{l.text}</span>
        </div>
      ))}
    </div>
  )
}

// Minimal markdown renderer tuned to the Workshop Journal look: section headings
// become mono-caps eyebrows, bullets get an oxblood marker. (ROCA has no md dep.)
function MarkdownLite({ md }: { md: string }) {
  const out: React.ReactNode[] = []
  let firstText = true
  md.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd()
    if (!line.trim()) return
    if (line.startsWith('#')) {
      const text = line.replace(/^#+\s*/, '')
      out.push(
        <div key={i} className="mono-caps text-[10px] text-text-3 mt-5 mb-1.5 first:mt-0">
          {inline(text)}
        </div>
      )
      return
    }
    const b = line.match(/^(\s*)[-*]\s+(.*)$/)
    if (b) {
      out.push(
        <div
          key={i}
          className="flex gap-2 text-[12.5px] text-text-2 leading-relaxed"
          style={{ paddingLeft: b[1].length * 10 }}
        >
          <span className="text-purple-1 select-none leading-relaxed">•</span>
          <span className="flex-1">{inline(b[2])}</span>
        </div>
      )
      return
    }
    // First plain paragraph is the one-line summary — give it presence.
    const cls = firstText
      ? 'text-[14px] text-text-1 leading-relaxed mb-2'
      : 'text-[12.5px] text-text-2 leading-relaxed'
    firstText = false
    out.push(<p key={i} className={cls}>{inline(line)}</p>)
  })
  return <div>{out}</div>
}

// **bold** → semibold ink.
function inline(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={i} className="font-semibold text-text-1">{p.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{p}</span>
    )
  )
}
