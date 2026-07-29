import { useEffect, useRef, useState } from 'react'
import { useVoiceConversation, type VoiceUiState } from '../lib/use-voice-conversation'

interface Props { active: boolean; onExit: () => void }

const ASSISTANT_NAME = 'ROCA' // display name — change here to rename

/** Inline voice panel — fills its container (lives inside the ⌘⇧A assistant overlay). */
export function VoicePanel({ active, onExit }: Props) {
  const v = useVoiceConversation(active)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [v.turns])

  const onDragEnter = (e: React.DragEvent) => { e.preventDefault(); dragDepth.current++; setDragOver(true) }
  const onDragOver = (e: React.DragEvent) => { e.preventDefault() }
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false) }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); dragDepth.current = 0; setDragOver(false)
    if (e.dataTransfer.files?.length) void v.attachFiles(e.dataTransfer.files)
  }

  return (
    <div
      className="relative flex flex-col h-full w-full bg-neutral-950 text-neutral-100"
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      {dragOver && (
        <div className="absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-indigo-400/70 bg-indigo-500/10 backdrop-blur-sm pointer-events-none">
          <div className="text-[13px] text-indigo-200">Drop a file — I’ll read it and we can talk about it</div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between px-5 h-11 shrink-0 border-b border-white/[0.06]">
        <button
          className="flex items-center gap-1.5 text-[12px] text-neutral-400 hover:text-neutral-100 transition-colors"
          onClick={onExit}
          title="Back to chat"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Chat
        </button>
        <span className="text-[12px] font-medium tracking-tight text-neutral-400">{ASSISTANT_NAME}</span>
        <div className="flex items-center gap-3">
          <button
            className={`transition-colors ${v.muted ? 'text-rose-400 hover:text-rose-300' : 'text-neutral-500 hover:text-neutral-200'}`}
            onClick={() => v.toggleMute()}
            title={v.muted ? 'Unmute mic' : 'Mute mic'}
            aria-label={v.muted ? 'Unmute' : 'Mute'}
          >
            {v.muted ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9l4 4m0-4l-4 4" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728" /></svg>
            )}
          </button>
          <button
            className="text-[11px] text-neutral-500 hover:text-neutral-200 transition-colors"
            onClick={() => void v.cycleModel()}
            title="Switch voice model (Sonnet 5 ↔ Opus 4.8)"
          >
            {v.model.label}
          </button>
          <button
            className="text-[11px] text-neutral-500 hover:text-neutral-200 transition-colors capitalize"
            onClick={() => v.cycleVoice()}
            title="Switch voice (British male voices)"
          >
            {v.voiceName}
          </button>
          <button
            className="text-[11px] tabular-nums text-neutral-500 hover:text-neutral-200 transition-colors"
            onClick={() => v.cycleSpeed()}
            title="Speaker speed"
          >
            {v.speed}×
          </button>
          <button className="text-[11px] text-neutral-500 hover:text-neutral-200 transition-colors" onClick={() => void v.newConversation()}>New</button>
        </div>
      </div>

      {/* Orb */}
      <div className="flex flex-col items-center justify-center gap-4 py-10 shrink-0">
        <div className="relative flex items-center justify-center">
          <div className={`absolute rounded-full blur-3xl opacity-50 ${orbGlow(v.state)}`} style={{ width: 170, height: 170 }} />
          <div className={`h-32 w-32 rounded-full transition-all duration-500 ${v.muted ? 'bg-gradient-to-br from-neutral-700 to-neutral-900 opacity-60' : orbClass(v.state)}`} />
        </div>
        <div className={`text-[12px] tracking-wide text-center px-6 ${v.muted ? 'text-rose-400/80' : 'text-neutral-400'}`}>
          {v.muted
            ? 'Muted — tap the mic to resume'
            : (v.state === 'thinking' && v.activity) ? v.activity
            : stateLabel(v.state)}
        </div>
        {/* Interrupt — hard-stops whatever ROCA is doing and returns to listening.
            The manual escape hatch for when the natural barge-in can't stop it. */}
        {(v.state === 'thinking' || v.state === 'processing' || v.state === 'speaking') ? (
          <button
            onClick={() => void v.interrupt()}
            className="px-4 py-1.5 rounded-full text-[12px] font-medium bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 border border-rose-500/30 transition-colors"
            title="Stop what ROCA is doing and start listening again"
          >
            ■ Interrupt
          </button>
        ) : (
          <div className="text-[10px] text-neutral-600">Tip: drag a file here to talk about it</div>
        )}
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 pb-6 flex flex-col gap-3 min-h-0">
        {v.turns.map((t, i) => (
          <div key={i} className="text-[13px] leading-relaxed">
            {t.role === 'system' ? (
              <span className="text-amber-400">{t.text}</span>
            ) : (
              <>
                <span className={t.role === 'user' ? 'text-neutral-500' : 'text-neutral-300'}>
                  {t.role === 'user' ? 'You' : ASSISTANT_NAME}
                </span>
                <div className={t.role === 'user' ? 'text-neutral-400' : 'text-neutral-100'}>{t.text}</div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function stateLabel(s: VoiceUiState): string {
  switch (s) {
    case 'listening': return 'Listening'
    case 'processing': return 'Transcribing'
    case 'thinking': return 'Thinking'
    case 'speaking': return 'Speaking'
    default: return 'Starting…'
  }
}
function orbClass(s: VoiceUiState): string {
  switch (s) {
    case 'listening': return 'bg-gradient-to-br from-indigo-400 to-indigo-600 animate-pulse scale-105'
    case 'processing': return 'bg-gradient-to-br from-sky-400 to-sky-600 animate-pulse'
    case 'thinking': return 'bg-gradient-to-br from-violet-400 to-purple-600 animate-pulse'
    case 'speaking': return 'bg-gradient-to-br from-emerald-400 to-teal-500'
    default: return 'bg-gradient-to-br from-neutral-600 to-neutral-800'
  }
}
function orbGlow(s: VoiceUiState): string {
  switch (s) {
    case 'listening': return 'bg-indigo-500'
    case 'processing': return 'bg-sky-500'
    case 'thinking': return 'bg-violet-500'
    case 'speaking': return 'bg-emerald-400 animate-pulse'
    default: return 'bg-neutral-700'
  }
}
