// ChatGPT-style voice conversation loop
// Record mic → ElevenLabs STT → send to Claude → ElevenLabs TTS → loop
import React, { useEffect, useState, useRef, useCallback } from 'react'
import {
  type VoiceState,
  SILENCE_THRESHOLD, SILENCE_DURATION_MS, MAX_RECORD_MS,
  playChime, stopAudio, speakText, transcribeAudio, startInterruptMonitor,
} from '@shared/voiceAudio'

interface Props {
  onTranscript: (text: string) => void
  textToSpeak?: string
  onTextToSpeakConsumed?: () => void
  taskId?: number | null
}

const apiKeyFetcher = () => window.electronAPI.getEnv('ELEVENLABS_API_KEY')

// ── Component ──
export default function VoiceMode({ onTranscript, textToSpeak, onTextToSpeakConsumed, taskId }: Props) {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef<VoiceState>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const listenAudioContextRef = useRef<AudioContext | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number>(0)
  const speechDetectedRef = useRef(false)
  const interruptCleanupRef = useRef<(() => void) | null>(null)
  const ttsAbortRef = useRef<AbortController | null>(null)
  const emptyRetryCountRef = useRef(0)
  const MAX_EMPTY_RETRIES = 5

  const onTranscriptRef = useRef(onTranscript)
  const onTextToSpeakConsumedRef = useRef(onTextToSpeakConsumed)
  onTranscriptRef.current = onTranscript
  onTextToSpeakConsumedRef.current = onTextToSpeakConsumed

  // Stable ref for startListening — updated every render so the TTS effect
  // always calls the latest version without including it in the dep array
  const startListeningRef = useRef<() => void>(() => {})

  stateRef.current = state

  // ── Voice diagnostics logger — captures every session event for review ──
  const logVoice = useCallback((event: string, extra?: { error?: string; spokenText?: string; transcript?: string }) => {
    try {
      const tab = localStorage.getItem('roca:activeTab') || 'unknown'
      window.electronAPI.voiceLogSession({
        event,
        state: stateRef.current,
        taskId: taskId ?? null,
        tab,
        ...extra,
      })
    } catch {}
  }, [taskId])

  const syncState = useCallback((next: VoiceState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const showError = useCallback((message: string) => {
    setError(message)
  }, [])

  const cleanup = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
    cancelAnimationFrame(rafRef.current)
    ttsAbortRef.current?.abort()
    ttsAbortRef.current = null
    if (recorderRef.current?.state === 'recording') {
      try { recorderRef.current.stop() } catch {}
    }
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    listenAudioContextRef.current?.close().catch(() => {})
    listenAudioContextRef.current = null
    recorderRef.current = null
    chunksRef.current = []
    speechDetectedRef.current = false
    interruptCleanupRef.current?.()
    interruptCleanupRef.current = null
  }, [])

  const stopRecordingAndTranscribe = useCallback(() => {
    if (stateRef.current !== 'listening') return
    syncState('processing')
    cancelAnimationFrame(rafRef.current)
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
    }
  }, [syncState])

  const startListening = useCallback(async () => {
    cleanup()
    onTextToSpeakConsumedRef.current?.() // clear any stale response
    setError(null)
    syncState('listening')
    logVoice('session-start')
    speechDetectedRef.current = false
    // Don't reset emptyRetryCountRef here — it tracks consecutive empty results
    // and is reset on successful transcription or manual restart via stop/start

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      if (stateRef.current !== 'listening') { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream

      const audioCtx = new AudioContext()
      listenAudioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const dataArray = new Float32Array(analyser.fftSize)

      const checkLevels = () => {
        if (stateRef.current !== 'listening') return
        analyser.getFloatTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i]
        const rms = Math.sqrt(sum / dataArray.length)

        if (rms > SILENCE_THRESHOLD) {
          speechDetectedRef.current = true
          if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null }
        } else if (speechDetectedRef.current && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            if (stateRef.current === 'listening') stopRecordingAndTranscribe()
          }, SILENCE_DURATION_MS)
        }
        rafRef.current = requestAnimationFrame(checkLevels)
      }
      rafRef.current = requestAnimationFrame(checkLevels)

      maxTimerRef.current = setTimeout(() => {
        if (stateRef.current === 'listening') stopRecordingAndTranscribe()
      }, MAX_RECORD_MS)

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' })
        stream.getTracks().forEach(t => t.stop())

        if (stateRef.current !== 'processing') return
        if (audioBlob.size < 1000) {
          emptyRetryCountRef.current++
          if (stateRef.current === 'processing' && emptyRetryCountRef.current < MAX_EMPTY_RETRIES) {
            startListeningRef.current()
          } else if (stateRef.current === 'processing') {
            showError('No audio detected. Click mic to try again.')
            logVoice('error', { error: `Empty audio after ${MAX_EMPTY_RETRIES} retries` })
            syncState('idle')
            cleanup()
          }
          return
        }

        try {
          const text = await transcribeAudio(audioBlob, apiKeyFetcher)
          if (!text.trim()) {
            emptyRetryCountRef.current++
            if (stateRef.current === 'processing' && emptyRetryCountRef.current < MAX_EMPTY_RETRIES) {
              startListeningRef.current()
            } else if (stateRef.current === 'processing') {
              showError('No speech detected. Click mic to try again.')
              logVoice('error', { error: `Empty transcript after ${MAX_EMPTY_RETRIES} retries` })
              syncState('idle')
              cleanup()
            }
            return
          }
          emptyRetryCountRef.current = 0 // successful transcription resets counter
          if (stateRef.current === 'processing') {
            onTranscriptRef.current(text.trim())
            syncState('thinking')
            logVoice('transcript', { transcript: text.trim() })
            playChime() // 🔔 chime when entering thinking mode
          }
        } catch (err) {
          console.error('[Voice] STT failed:', err)
          showError('Transcription failed. Try again.')
          logVoice('error', { error: 'STT failed: ' + String(err) })
          if (stateRef.current === 'processing') startListeningRef.current()
        }
      }
      recorderRef.current = recorder
      recorder.start(250)
    } catch (err) {
      console.error('[Voice] Mic access failed:', err)
      showError('Microphone access is required.')
      logVoice('error', { error: 'Mic access failed: ' + String(err) })
      syncState('idle')
    }
  }, [cleanup, logVoice, showError, stopRecordingAndTranscribe, syncState])

  // Keep startListeningRef current so TTS effect always calls latest version
  startListeningRef.current = startListening

  const stop = useCallback(() => {
    logVoice('session-end')
    syncState('idle')
    emptyRetryCountRef.current = 0
    stopAudio()
    cleanup()
    onTextToSpeakConsumedRef.current?.() // clear stale response so next session doesn't replay it
  }, [cleanup, logVoice, syncState])

  // When Claude responds → speak via ElevenLabs TTS + monitor for interruption
  useEffect(() => {
    if (state !== 'thinking' || !textToSpeak?.trim()) return

    syncState('speaking')
    logVoice('speaking', { spokenText: textToSpeak.substring(0, 200) })
    setError(null)
    const abortController = new AbortController()
    ttsAbortRef.current = abortController

    // Start interrupt monitor — if user speaks during TTS, cut back to listening
    interruptCleanupRef.current = startInterruptMonitor(() => {
      console.log('[Voice] Interrupted by user')
      logVoice('interrupted')
      stopAudio()
      onTextToSpeakConsumedRef.current?.()
      startListeningRef.current()
    })

    speakText(textToSpeak, apiKeyFetcher, abortController.signal)
      .then(() => {
        console.log('[Voice] TTS done')
        interruptCleanupRef.current?.()
        interruptCleanupRef.current = null
        ttsAbortRef.current = null
        onTextToSpeakConsumedRef.current?.()
        if (stateRef.current === 'speaking') startListeningRef.current()
      })
      .catch((err) => {
        if (abortController.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
        console.error('[Voice] TTS failed:', err)
        logVoice('error', { error: 'TTS failed: ' + String(err) })
        interruptCleanupRef.current?.()
        interruptCleanupRef.current = null
        ttsAbortRef.current = null
        showError('Speech playback failed.')
        onTextToSpeakConsumedRef.current?.()
        if (stateRef.current === 'speaking') startListeningRef.current()
      })
  }, [logVoice, showError, state, syncState, textToSpeak])

  // Reset voice mode when switching tasks
  useEffect(() => {
    if (stateRef.current !== 'idle') {
      logVoice('task-switch-reset')
      syncState('idle')
      stopAudio()
      cleanup()
      onTextToSpeakConsumedRef.current?.()
    }
  }, [taskId, cleanup, logVoice, syncState])

  useEffect(() => () => { cleanup() }, [cleanup])

  // ── Render ──
  // Keyframes are defined in styles.css (voice-breathe, voice-spin, voice-morph, voice-ring, voice-glow)

  if (state === 'idle') {
    return (
      <div className="flex flex-col items-center gap-2">
        <div role="alert" aria-live="assertive" aria-atomic="true">
          {error && (
            <div className="max-w-[220px] rounded-full bg-amber-400/10 text-amber-400 border border-amber-400/20 px-3 py-1.5 text-[11px] font-medium shadow-sm text-center">
              {error}
            </div>
          )}
        </div>
        <button
          onClick={() => { emptyRetryCountRef.current = 0; startListening() }}
          className="relative shrink-0 p-3.5 rounded-full cursor-pointer transition-all hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-1/50 focus-visible:ring-offset-2"
          style={{
            background: 'linear-gradient(135deg, var(--color-purple-2), rgba(123,47,160,0.06))',
            boxShadow: '0 2px 16px var(--color-purple-2), 0 0 0 1px rgba(123,47,160,0.1)',
            animation: 'voice-glow 3s ease-in-out infinite',
          }}
          aria-label={error ? 'Click to try again' : 'Start voice conversation'}
          title={error ? `${error} — Click to try again` : 'Start voice conversation'}
        >
          <div aria-hidden="true" className="absolute inset-[-3px] rounded-full border border-purple-400/20" style={{ animation: 'voice-ring 2.5s ease-in-out infinite' }} />
          <MicIcon />
        </button>
      </div>
    )
  }

  const orbColor = state === 'listening' ? 'var(--voice-color-listening)' :
                   state === 'processing' ? 'var(--voice-color-processing)' :
                   state === 'thinking' ? 'var(--color-purple-1)' :
                   'var(--voice-color-speaking)'

  const orbGlow = state === 'listening' ? 'color-mix(in srgb, var(--voice-color-listening) 50%, transparent)' :
                  state === 'processing' ? 'color-mix(in srgb, var(--voice-color-processing) 50%, transparent)' :
                  state === 'thinking' ? 'color-mix(in srgb, var(--color-purple-1) 50%, transparent)' :
                  'color-mix(in srgb, var(--voice-color-speaking) 50%, transparent)'

  const orbBg = state === 'listening' ? 'color-mix(in srgb, var(--voice-color-listening) 10%, transparent)' :
                state === 'processing' ? 'color-mix(in srgb, var(--voice-color-processing) 10%, transparent)' :
                state === 'thinking' ? 'color-mix(in srgb, var(--color-purple-1) 10%, transparent)' :
                'color-mix(in srgb, var(--voice-color-speaking) 10%, transparent)'

  const orbAnim = state === 'listening' ? 'voice-breathe 1.2s ease-in-out infinite' :
                  state === 'processing' ? 'voice-spin 1.5s linear infinite' :
                  state === 'thinking' ? 'voice-breathe 2s ease-in-out infinite' :
                  'voice-breathe 0.8s ease-in-out infinite'

  const innerAnim = state === 'processing' ? 'voice-morph 1.5s ease-in-out infinite' :
                    state === 'thinking' ? 'voice-morph 2.5s ease-in-out infinite' : 'none'

  const label = state === 'listening' ? 'Listening' :
                state === 'processing' ? 'Processing' :
                state === 'thinking' ? 'Thinking' :
                'Speaking'

  return (
    <div
      aria-label={`Voice mode: ${label}`}
      className="flex items-center gap-3 rounded-full pl-2 pr-3 py-1.5 select-none modal-enter"
      style={{
        background: 'var(--color-surface-0)',
        backdropFilter: 'blur(16px)',
        boxShadow: `0 4px 24px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.06), 0 0 20px ${orbGlow.replace('0.5', '0.15')}`,
      }}
    >
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
        style={{ background: orbBg, animation: orbAnim }}
      >
        <div
          className="w-5 h-5 rounded-full"
          style={{
            background: orbColor,
            boxShadow: `0 0 12px ${orbGlow}`,
            animation: innerAnim,
          }}
        />
      </div>
      <span role="status" aria-live="polite" className="text-[11px] font-semibold text-text-2 tracking-wide">{label}</span>
      <button
        onClick={stop}
        aria-label="End voice conversation"
        className="ml-0.5 px-3 py-1 rounded-full text-[10px] font-bold text-text-3 hover:text-text-2 hover:bg-black/[0.06] transition-colors cursor-pointer"
      >
        End
      </button>
    </div>
  )
}

function MicIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--color-purple-1)' }}>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
    </svg>
  )
}
