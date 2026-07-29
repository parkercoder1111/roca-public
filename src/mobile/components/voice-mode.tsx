// Mobile voice conversation loop — adapted from desktop VoiceMode
// Record mic → ElevenLabs STT → send to PTY → detect response → ElevenLabs TTS → loop
import React, { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api'
import {
  type VoiceState,
  SILENCE_THRESHOLD, SILENCE_DURATION_MS, MAX_RECORD_MS,
  playChime, stopAudio, speakText, transcribeAudio, startInterruptMonitor,
  getPlaybackSpeed, cyclePlaybackSpeed,
} from '../../shared/voice-audio'

interface Props {
  onTranscript: (text: string) => void
  textToSpeak?: string
  onTextToSpeakConsumed?: () => void
}

const apiKeyFetcher = () => api.getEnv('ELEVENLABS_API_KEY')

// ── Component ──
export function MobileVoiceMode({ onTranscript, textToSpeak, onTextToSpeakConsumed }: Props) {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [speed, setSpeed] = useState<number>(() => getPlaybackSpeed())
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

  stateRef.current = state

  const syncState = useCallback((next: VoiceState) => {
    stateRef.current = next
    setState(next)
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
    onTextToSpeakConsumedRef.current?.()
    setError(null)
    syncState('listening')
    speechDetectedRef.current = false

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
      let lastLevelLog = performance.now()

      const checkLevels = () => {
        if (stateRef.current !== 'listening') return
        analyser.getFloatTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i]
        const rms = Math.sqrt(sum / dataArray.length)
        const nowMs = performance.now()
        if (nowMs - lastLevelLog > 1500) {
          console.debug(`[voice] listening: rms=${rms.toFixed(3)} (silence floor ${SILENCE_THRESHOLD}, ends after ${SILENCE_DURATION_MS}ms quiet)`)
          lastLevelLog = nowMs
        }
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
            startListening()
          } else if (stateRef.current === 'processing') {
            setError('No audio detected. Tap mic to try again.')
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
              startListening()
            } else if (stateRef.current === 'processing') {
              setError('No speech detected. Tap mic to try again.')
              syncState('idle')
              cleanup()
            }
            return
          }
          emptyRetryCountRef.current = 0
          if (stateRef.current === 'processing') {
            onTranscriptRef.current(text.trim())
            syncState('thinking')
            playChime()
          }
        } catch (err) {
          console.error('[Voice] STT failed:', err)
          setError('Transcription failed')
          if (stateRef.current === 'processing') startListening()
        }
      }
      recorderRef.current = recorder
      recorder.start(250)
    } catch (err) {
      console.error('[Voice] Mic access failed:', err)
      setError('Mic access required')
      syncState('idle')
    }
  }, [cleanup, stopRecordingAndTranscribe, syncState])

  const stop = useCallback(() => {
    syncState('idle')
    stopAudio()
    cleanup()
    onTextToSpeakConsumedRef.current?.()
  }, [cleanup, syncState])

  // Cycle the speaker's playback speed (0.75×–2×). The shared store applies the new
  // rate live to any audio already playing, so it takes effect immediately.
  const cycleSpeed = useCallback(() => { setSpeed(cyclePlaybackSpeed()) }, [])

  // When Claude responds → speak via TTS + monitor for interruption
  useEffect(() => {
    if (state !== 'thinking' || !textToSpeak?.trim()) return

    syncState('speaking')
    setError(null)
    const abortController = new AbortController()
    ttsAbortRef.current = abortController

    interruptCleanupRef.current = startInterruptMonitor(() => {
      stopAudio()
      onTextToSpeakConsumedRef.current?.()
      startListening()
    })

    speakText(textToSpeak, apiKeyFetcher, abortController.signal)
      .then(() => {
        interruptCleanupRef.current?.()
        interruptCleanupRef.current = null
        ttsAbortRef.current = null
        onTextToSpeakConsumedRef.current?.()
        if (stateRef.current === 'speaking') startListening()
      })
      .catch((err) => {
        if (abortController.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
        console.error('[Voice] TTS failed:', err)
        interruptCleanupRef.current?.()
        interruptCleanupRef.current = null
        ttsAbortRef.current = null
        setError('Playback failed')
        onTextToSpeakConsumedRef.current?.()
        if (stateRef.current === 'speaking') startListening()
      })
  }, [startListening, state, syncState, textToSpeak])

  useEffect(() => () => { cleanup() }, [cleanup])

  // ── Render ──
  if (state === 'idle') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <div role="alert" aria-live="assertive" aria-atomic="true">
          {error && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 200 }}>
              {error}
            </div>
          )}
        </div>
        <button
          onClick={() => { emptyRetryCountRef.current = 0; startListening() }}
          className="mv-voice-btn mv-voice-idle"
          title={error ? `${error} — Tap to try again` : 'Start voice'}
          aria-label={error ? 'Tap to try again' : 'Start voice'}
        >
          <div className="mv-voice-ring" />
          <MicIcon />
        </button>
        <SpeedButton speed={speed} onCycle={cycleSpeed} />
      </div>
    )
  }

  const pulseClass = state === 'listening' ? 'mv-voice-listening' :
                     state === 'processing' || state === 'thinking' ? 'mv-voice-thinking' :
                     'mv-voice-speaking'

  const label = state === 'listening' ? 'Listening' :
                state === 'processing' ? 'Processing' :
                state === 'thinking' ? 'Thinking' :
                'Speaking'

  return (
    <div className={`mv-voice-active ${pulseClass}`}>
      <div className="mv-voice-orb">
        <div className="mv-voice-orb-inner" />
      </div>
      <span role="status" aria-live="polite" className="mv-voice-label">{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SpeedButton speed={speed} onCycle={cycleSpeed} />
        <button onClick={stop} aria-label="End voice conversation" className="mv-voice-end">End</button>
      </div>
    </div>
  )
}

function SpeedButton({ speed, onCycle }: { speed: number; onCycle: () => void }) {
  return (
    <button
      onClick={onCycle}
      title="Speaker speed"
      aria-label={`Speaker speed ${speed}×`}
      style={{
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--text-secondary)',
        background: 'transparent',
        border: '1px solid var(--border, rgba(255,255,255,0.15))',
        borderRadius: 999,
        padding: '4px 10px',
        cursor: 'pointer',
      }}
    >
      {speed}×
    </button>
  )
}

function MicIcon() {
  return (
    <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
    </svg>
  )
}
