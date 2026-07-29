import { useCallback, useEffect, useRef, useState } from 'react'
import { SILENCE_THRESHOLD, SILENCE_DURATION_MS, MAX_RECORD_MS, startInterruptMonitor, getPlaybackSpeed, cyclePlaybackSpeed, applyPlaybackSpeed } from '@shared/voice-audio'
import { splitIntoSentences } from '@shared/voice/sentence-chunker'
import { cleanForSpeech } from '@shared/voice/clean-speech'
import { getSttProvider, getTtsProvider, VOICE_DEFAULTS, OPENAI_VOICES, setOpenaiVoice } from '@shared/voice/providers'
import { transcribeLocalWhisper } from './local-stt'

export type VoiceUiState = 'idle' | 'listening' | 'processing' | 'thinking' | 'speaking'
export interface VoiceTurn { role: 'user' | 'assistant' | 'system'; text: string }

const PROVIDER = VOICE_DEFAULTS.provider
const KEY_ENV = PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY'
// Noise rejection: require a clear, sustained voice onset (not a brief chirp/footstep).
const SPEECH_ONSET = 0.05          // louder than SILENCE_THRESHOLD → needs real voice
const MIN_SPEECH_FRAMES = 10       // ~160ms of continuous above-onset audio before we count it as speech

/** DIAGNOSTIC (temporary): trace every boundary in the speak-the-reply path to
 *  outputs/voice-diagnostics/tts-trace.jsonl so the intermittent "audio starts
 *  mid-paragraph" drop can be pinned to a specific sentence + cause. Fire-and-forget. */
const tp = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s)
function ttsTrace(event: string, data: Record<string, unknown> = {}): void {
  try { void window.electronAPI.voice.ttsTrace({ event, ...data }) } catch { /* ignore */ }
  // eslint-disable-next-line no-console
  console.debug(`[voice-tts] ${event}`, data)
}

/** True if a transcript is almost certainly noise, not a spoken request. */
function isNoiseTranscript(t: string): boolean {
  const s = t.trim()
  if (s.length < 2) return true
  if (/^[\[\(].*[\]\)]$/.test(s)) return true           // "[silence]", "(wind)"
  if (/^[^a-z0-9]+$/i.test(s)) return true               // only punctuation/symbols
  return false
}

/** Friendly, spoken-length label for a tool the model is using — shown live under
 *  "thinking" so you can see what Ora is actually doing (like the terminal). */
function toolLabel(name?: string, input?: Record<string, unknown>): string {
  const base = (p?: unknown) => (typeof p === 'string' ? p.split('/').pop() : '') || ''
  switch (name) {
    case 'Read': return `Reading ${base(input?.file_path) || 'a file'}`
    case 'Write': return `Writing ${base(input?.file_path) || 'a file'}`
    case 'Edit': case 'MultiEdit': return `Editing ${base(input?.file_path) || 'a file'}`
    case 'Bash': {
      const c = String(input?.command || '').trim()
      if (/127\.0\.0\.1:19274|remote-token|:19274/.test(c)) return 'Checking ROCA'
      return c ? `Running: ${c.slice(0, 40)}` : 'Running a command'
    }
    case 'WebSearch': return input?.query ? `Searching: ${String(input.query).slice(0, 40)}` : 'Searching the web'
    case 'WebFetch': return 'Reading a page'
    case 'Grep': case 'Glob': return 'Searching files'
    default: return name ? `${name}…` : 'Working…'
  }
}

/** Hands-free voice loop: open → listen → transcribe → Claude → speak → listen again.
 *  Barge-in cleanly cancels the current turn (no double-voice). A soft "working"
 *  loop plays while Claude is thinking/using tools so you know it's busy. */
export function useVoiceConversation(active: boolean) {
  const [state, setState] = useState<VoiceUiState>('idle')
  const [turns, setTurns] = useState<VoiceTurn[]>([])
  const [activity, setActivity] = useState('') // live "what it's doing" during thinking
  const [muted, setMuted] = useState(false)
  const [model, setModel] = useState<{ model: string; label: string }>({ model: 'claude-sonnet-5', label: 'Sonnet 5' })
  const [voiceName, setVoiceNameState] = useState<string>(() => {
    const v = (typeof localStorage !== 'undefined' && localStorage.getItem('roca-voice-name')) || OPENAI_VOICES[0]
    return OPENAI_VOICES.includes(v) ? v : OPENAI_VOICES[0]
  })
  const [speed, setSpeed] = useState<number>(() => getPlaybackSpeed())
  const mutedRef = useRef(false)
  const stateRef = useRef<VoiceUiState>('idle')
  const activeRef = useRef(active)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { activeRef.current = active }, [active])
  const setUiState = useCallback((s: VoiceUiState) => { stateRef.current = s; setState(s) }, [])

  // Monotonic turn id: bumping it invalidates any in-flight response/audio from
  // the previous turn (the core barge-in fix — no two voices at once).
  const turnGen = useRef(0)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const rafRef = useRef<number | null>(null)
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speechDetected = useRef(false)
  const speechFrames = useRef(0)

  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const ttsAbortRef = useRef<AbortController | null>(null)
  const ttsAbortGenRef = useRef(-1)
  const ttsQueue = useRef<string[]>([])
  // Sentences whose audio is synthesizing/ready but not yet played, in order — the
  // prefetch buffer that keeps playback gap-free.
  const audioBuf = useRef<Array<{ text: string; p: Promise<ArrayBuffer> }>>([])
  const ttsPlaying = useRef(false)
  const responseComplete = useRef(false)
  const offEventRef = useRef<(() => void) | null>(null)
  const offExitRef = useRef<(() => void) | null>(null)
  const interruptCleanupRef = useRef<(() => void) | null>(null)
  const startListeningRef = useRef<() => void>(() => {})

  // ── "working" sound loop (WebAudio, no assets) ──
  const fxCtxRef = useRef<AudioContext | null>(null)
  const workingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const fxCtx = useCallback((): AudioContext => {
    if (!fxCtxRef.current) fxCtxRef.current = new AudioContext()
    return fxCtxRef.current
  }, [])
  const beep = useCallback((freq: number, at: number, dur = 0.12, gain = 0.14) => {
    const ctx = fxCtx()
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'; o.frequency.value = freq
    o.connect(g); g.connect(ctx.destination)
    const t = ctx.currentTime + at
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.start(t); o.stop(t + dur + 0.02)
  }, [fxCtx])
  const workingMotif = useCallback(() => { beep(523, 0); beep(587, 0.14); beep(784, 0.30, 0.18) }, [beep]) // da-da-dun
  const startWorkingLoop = useCallback(() => {
    if (workingTimer.current) return
    workingMotif()
    workingTimer.current = setInterval(() => { if (stateRef.current === 'thinking') workingMotif() }, 2200)
  }, [workingMotif])
  const stopWorkingLoop = useCallback(() => {
    if (workingTimer.current) { clearInterval(workingTimer.current); workingTimer.current = null }
  }, [])

  const getKey = useCallback(async () => (await window.electronAPI.getEnv(KEY_ENV)) || '', [])

  const cleanupCapture = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (silenceTimer.current) clearTimeout(silenceTimer.current)
    if (maxTimer.current) clearTimeout(maxTimer.current)
    rafRef.current = null; silenceTimer.current = null; maxTimer.current = null
    try { recorderRef.current?.stop() } catch { /* ignore */ }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }, [])

  const stopInterruptMonitor = useCallback(() => {
    interruptCleanupRef.current?.()
    interruptCleanupRef.current = null
  }, [])

  /** Hard-stop everything about the CURRENT turn: audio, queue, in-flight TTS,
   *  and the response event stream. Bumping turnGen makes late arrivals no-ops. */
  const cancelCurrentTurn = useCallback(() => {
    ttsTrace('cancel-turn', { fromGen: turnGen.current, qlen: ttsQueue.current.length, playing: ttsPlaying.current })
    turnGen.current++
    ttsQueue.current = []
    audioBuf.current = []
    ttsPlaying.current = false
    ttsAbortRef.current?.abort()
    ttsAbortRef.current = null
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.src = ''; audioElRef.current = null }
    offEventRef.current?.(); offEventRef.current = null
    offExitRef.current?.(); offExitRef.current = null
    stopWorkingLoop()
    setActivity('')
  }, [stopWorkingLoop])

  // ── TTS pipeline with prefetch ──
  // Synthesis is the slow part (a network round-trip per sentence). Playing one
  // sentence and only THEN synthesizing the next leaves an audible gap between
  // sentences. Instead we synthesize up to MAX_PREFETCH sentences AHEAD while the
  // current one plays, so the next clip is ready the instant the current one ends.
  const MAX_PREFETCH = 3

  // One AbortController per turn (created lazily), so a barge-in cancels every
  // in-flight synthesis for the turn at once; the next turn gets a fresh one.
  const ttsSignal = useCallback((gen: number): AbortSignal => {
    if (ttsAbortGenRef.current !== gen || !ttsAbortRef.current) {
      ttsAbortRef.current = new AbortController()
      ttsAbortGenRef.current = gen
    }
    return ttsAbortRef.current.signal
  }, [])

  const synthJob = useCallback((text: string, gen: number): Promise<ArrayBuffer> => {
    const signal = ttsSignal(gen)
    const p = (async () => {
      const key = await getKey()
      return getTtsProvider(PROVIDER).synthesize(text, key, signal)
    })()
    // The value is consumed where the job is awaited; this extra handler only keeps
    // a job dropped on barge-in from surfacing as an unhandledrejection.
    p.catch(() => { /* handled at await site */ })
    return p
  }, [getKey, ttsSignal])

  // Pull queued sentences into the synthesis buffer, keeping up to MAX_PREFETCH
  // syntheses running ahead of playback.
  const pumpSynth = useCallback((gen: number) => {
    if (gen !== turnGen.current) return
    while (audioBuf.current.length < MAX_PREFETCH && ttsQueue.current.length) {
      const text = ttsQueue.current.shift() as string
      audioBuf.current.push({ text, p: synthJob(text, gen) })
    }
  }, [synthJob])

  const playNext = useCallback(async (gen: number) => {
    if (gen !== turnGen.current) { ttsTrace('playNext-stale', { gen, turnGen: turnGen.current }); return }
    if (ttsPlaying.current) { ttsTrace('playNext-busy', { gen, qlen: ttsQueue.current.length }); return }
    pumpSynth(gen) // move any queued text into the (pre)synthesis buffer
    const job = audioBuf.current.shift()
    if (!job) {
      ttsTrace('playNext-drained', { gen, complete: responseComplete.current, state: stateRef.current })
      if (responseComplete.current && stateRef.current === 'speaking') startListeningRef.current()
      return
    }
    ttsTrace('play-shift', { gen, text: tp(job.text), bufAfter: audioBuf.current.length, qlen: ttsQueue.current.length })
    ttsPlaying.current = true
    if (stateRef.current !== 'speaking') {
      stopWorkingLoop()
      setUiState('speaking')
      stopInterruptMonitor()
      ttsTrace('monitor-start', { gen })
      interruptCleanupRef.current = startInterruptMonitor(() => {
        // Barge-in: kill the current turn entirely, then listen fresh.
        ttsTrace('barge-in-fired', { gen })
        cancelCurrentTurn()
        stopInterruptMonitor()
        startListeningRef.current()
      })
    }
    pumpSynth(gen) // removing the head freed a slot — top the prefetch back up
    try {
      const t0 = performance.now()
      const buf = await job.p
      ttsTrace('synth-ok', { gen, text: tp(job.text), bytes: buf.byteLength, ms: Math.round(performance.now() - t0) })
      if (gen !== turnGen.current) { ttsTrace('play-stale-after-synth', { gen, turnGen: turnGen.current, text: tp(job.text) }); return } // interrupted while synthesizing
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))
      const el = new Audio(url); audioElRef.current = el
      applyPlaybackSpeed(el)
      await el.play()
      ttsTrace('play-start', { gen, text: tp(job.text), dur: el.duration })
      const how = await new Promise<string>((res) => { el.onended = () => res('ended'); el.onerror = () => res('error') })
      ttsTrace('play-done', { gen, text: tp(job.text), how })
      URL.revokeObjectURL(url)
    } catch (e) {
      // Previously swallowed silently — that hid exactly this bug. Trace the real cause.
      ttsTrace('play-exception', { gen, text: tp(job.text), err: String((e as Error)?.message ?? e), name: (e as Error)?.name })
    }
    ttsPlaying.current = false
    if (gen !== turnGen.current || !activeRef.current) return
    if (audioBuf.current.length || ttsQueue.current.length) { void playNext(gen) }
    else if (responseComplete.current && stateRef.current === 'speaking') {
      stopInterruptMonitor(); startListeningRef.current()
    }
  }, [setUiState, stopInterruptMonitor, stopWorkingLoop, cancelCurrentTurn, pumpSynth])

  const enqueueTts = useCallback((s: string, gen: number) => {
    if (gen !== turnGen.current) { ttsTrace('enqueue-stale', { gen, turnGen: turnGen.current, text: tp(s) }); return }
    const clean = cleanForSpeech(s)
    if (clean) {
      ttsQueue.current.push(clean)
      ttsTrace('enqueue', { gen, text: tp(clean), qlen: ttsQueue.current.length, playing: ttsPlaying.current })
      pumpSynth(gen)   // begin synthesizing now, even while a prior sentence is still playing
      void playNext(gen)
    } else {
      ttsTrace('enqueue-empty-after-clean', { gen, raw: tp(s) })
    }
  }, [pumpSynth, playNext])

  const runTurn = useCallback(async (brainText: string, displayText?: string) => {
    const shown = displayText ?? brainText
    const gen = ++turnGen.current
    ttsTrace('turn-start', { gen, brainLen: brainText.length })
    setTurns((t) => [...t, { role: 'user', text: shown }, { role: 'assistant', text: '' }])
    setUiState('thinking')
    startWorkingLoop()
    responseComplete.current = false
    await window.electronAPI.voice.ensureSession()

    let assistantRaw = ''
    let ttsBuffer = ''
    let recovered = false
    // The reply's turn ordinal, learned when our send resolves. The voice Claude
    // process is shared and persistent: a barge-in cancels this renderer turn but
    // NOT Claude's generation, so a prior turn's late assistant/result events can
    // still arrive on this listener. They carry a smaller ordinal — dropping them
    // stops us speaking a previous turn's reply (or ending this turn early).
    let myOrdinal = -1

    offEventRef.current?.()
    const off = window.electronAPI.voice.onEvent((raw) => {
      if (gen !== turnGen.current) return // stale turn (interrupted) — ignore
      const ev = raw as { type?: string; __turnOrdinal?: number; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } }
      // Only honor events for THIS turn. Until our ordinal is known (send in
      // flight), defer — our own reply always arrives after the send resolves.
      if (typeof ev.__turnOrdinal === 'number' && (myOrdinal < 0 || ev.__turnOrdinal !== myOrdinal)) {
        if (ev.type === 'assistant' || ev.type === 'result') {
          ttsTrace('ordinal-drop', { gen, evType: ev.type, evOrdinal: ev.__turnOrdinal, myOrdinal })
        }
        return
      }
      if (ev?.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use') {
            setActivity(toolLabel(block.name, block.input)) // show what it's doing
          } else if (block.type === 'text' && block.text) {
            setActivity('') // Ora is answering now — stop showing tool activity
            assistantRaw += block.text
            ttsBuffer += block.text
            const { sentences, remainder } = splitIntoSentences(ttsBuffer)
            ttsBuffer = remainder
            ttsTrace('assistant-text', { gen, blockLen: block.text.length, sentences: sentences.length, remainderLen: remainder.length })
            sentences.forEach((s) => enqueueTts(s, gen))
            const display = cleanForSpeech(assistantRaw)
            setTurns((t) => { const c = [...t]; c[c.length - 1] = { role: 'assistant', text: display }; return c })
          }
        }
      }
      if (ev?.type === 'result') {
        ttsTrace('result', { gen, flushLen: ttsBuffer.trim().length, qlen: ttsQueue.current.length, playing: ttsPlaying.current })
        if (ttsBuffer.trim()) { enqueueTts(ttsBuffer.trim(), gen); ttsBuffer = '' }
        off(); offEventRef.current = null
        setActivity('')
        responseComplete.current = true
        void window.electronAPI.voice.recordExchange(shown, cleanForSpeech(assistantRaw))
        if (!ttsPlaying.current && ttsQueue.current.length === 0 && audioBuf.current.length === 0) { stopWorkingLoop(); startListeningRef.current() }
      }
    })
    offEventRef.current = off

    const offExit = window.electronAPI.voice.onExit(async (code) => {
      offExit(); offExitRef.current = null
      if (gen !== turnGen.current) return
      if (code && code !== 0 && !assistantRaw.trim() && !recovered) {
        recovered = true
        await window.electronAPI.voice.recover()
        // Fresh session resets ordinals — re-learn ours from the resend.
        const r = await window.electronAPI.voice.send(brainText)
        myOrdinal = r?.turnOrdinal ?? myOrdinal
      }
    })
    offExitRef.current = offExit

    const sent = await window.electronAPI.voice.send(brainText)
    myOrdinal = sent?.turnOrdinal ?? -1
    ttsTrace('send-resolved', { gen, myOrdinal })
  }, [enqueueTts, setUiState, startWorkingLoop, stopWorkingLoop])

  const stopRecordingAndTranscribe = useCallback(async () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (silenceTimer.current) clearTimeout(silenceTimer.current)
    if (maxTimer.current) clearTimeout(maxTimer.current)
    const rec = recorderRef.current
    if (!rec) return
    setUiState('processing')
    await new Promise<void>((res) => { rec.onstop = () => res(); try { rec.stop() } catch { res() } })
    streamRef.current?.getTracks().forEach((t) => t.stop())
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    if (!activeRef.current) return
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
    if (!speechDetected.current || blob.size < 1200) { startListeningRef.current(); return }
    try {
      // Local whisper.cpp first (fast, offline, free). Fall back to cloud STT only if
      // it's unavailable or errors — which also needs the API key.
      let text = ''
      try {
        const t0 = performance.now()
        text = await transcribeLocalWhisper(blob)
        ttsTrace('stt-local', { ms: Math.round(performance.now() - t0), text: tp(text) })
      } catch (localErr) {
        ttsTrace('stt-local-fallback', { err: String((localErr as Error)?.message ?? localErr) })
        const key = await getKey()
        if (!key) { setTurns((t) => [...t, { role: 'system', text: `Voice needs local whisper or an ${KEY_ENV}. Neither is available — add a key in Settings.` }]); setUiState('idle'); return }
        text = (await getSttProvider(PROVIDER).transcribe(blob, key)).trim()
      }
      if (text && !isNoiseTranscript(text)) await runTurn(text)
      else startListeningRef.current()   // empty or noise → quietly keep listening
    } catch {
      startListeningRef.current()
    }
  }, [getKey, runTurn, setUiState])

  const startListening = useCallback(async () => {
    if (!activeRef.current) return
    if (mutedRef.current) { cleanupCapture(); stopInterruptMonitor(); setUiState('idle'); return } // muted → mic off
    cancelCurrentTurn()          // ensure nothing from a prior turn is still going
    cleanupCapture(); stopInterruptMonitor()
    speechDetected.current = false
    speechFrames.current = 0
    setUiState('listening')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      setTurns((t) => [...t, { role: 'system', text: 'Microphone access is required.' }]); setUiState('idle'); return
    }
    if (!activeRef.current || stateRef.current !== 'listening') { stream.getTracks().forEach((t) => t.stop()); return }
    streamRef.current = stream
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    let lastLevelLog = performance.now()
    const check = () => {
      if (stateRef.current !== 'listening') return
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      const now = performance.now()
      if (now - lastLevelLog > 1500) {
        console.debug(`[voice] listening: rms=${rms.toFixed(3)} (onset ${SPEECH_ONSET}, silence floor ${SILENCE_THRESHOLD})`)
        lastLevelLog = now
      }
      // Onset: only a sustained, clearly-loud run counts as you starting to talk —
      // the high onset bar rejects a chirp/footstep.
      if (rms > SPEECH_ONSET) {
        speechFrames.current++
        if (speechFrames.current >= MIN_SPEECH_FRAMES) speechDetected.current = true
      } else if (rms < SILENCE_THRESHOLD) {
        speechFrames.current = 0   // reset the onset run on true quiet
      }
      // End-of-turn: keep listening as long as there's ANY voice-level energy (the
      // low SILENCE_THRESHOLD, NOT the high onset bar) so soft speech and the gaps
      // between words don't cut you off. Only sustained quiet arms the end timer.
      if (rms > SILENCE_THRESHOLD) {
        if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null }
      } else if (speechDetected.current && !silenceTimer.current) {
        silenceTimer.current = setTimeout(() => { if (stateRef.current === 'listening') void stopRecordingAndTranscribe() }, SILENCE_DURATION_MS)
      }
      rafRef.current = requestAnimationFrame(check)
    }
    rafRef.current = requestAnimationFrame(check)
    maxTimer.current = setTimeout(() => {
      if (stateRef.current !== 'listening') return
      if (speechDetected.current) void stopRecordingAndTranscribe()
      else startListeningRef.current()
    }, MAX_RECORD_MS)
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    chunksRef.current = []
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorderRef.current = rec
    rec.start(250)
  }, [cancelCurrentTurn, cleanupCapture, stopInterruptMonitor, setUiState, stopRecordingAndTranscribe])

  startListeningRef.current = startListening

  const stop = useCallback(() => {
    cancelCurrentTurn()
    cleanupCapture(); stopInterruptMonitor(); stopWorkingLoop()
    setUiState('idle')
  }, [cancelCurrentTurn, cleanupCapture, stopInterruptMonitor, stopWorkingLoop, setUiState])

  const newConversation = useCallback(async () => {
    stop()
    await window.electronAPI.voice.newConversation()
    setTurns([])
    if (activeRef.current && !mutedRef.current) startListeningRef.current()
  }, [stop])

  // Manual "Interrupt": hard-stop the current turn locally AND kill the voice
  // claude process (via voice.interrupt), then drop straight back to listening.
  // The escape hatch for when the natural barge-in can't stop a wedged/runaway
  // turn. Keeps the on-screen transcript; recent context carries via continuity.
  const interrupt = useCallback(async () => {
    cancelCurrentTurn()
    cleanupCapture()
    stopInterruptMonitor()
    try { await window.electronAPI.voice.interrupt() } catch { /* ignore */ }
    if (!activeRef.current) { setUiState('idle'); return }
    if (mutedRef.current) { setUiState('idle'); return }
    startListeningRef.current()
  }, [cancelCurrentTurn, cleanupCapture, stopInterruptMonitor, setUiState])

  // Drag & drop files onto voice mode → save them, then Ora reads them and we chat.
  const attachFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (!files.length) return
    cancelCurrentTurn(); cleanupCapture(); stopInterruptMonitor()
    setUiState('thinking'); setActivity('Opening ' + (files.length === 1 ? files[0].name : files.length + ' files'))
    let payload: Array<{ name: string; type: string; buffer: Uint8Array }>
    try {
      payload = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', buffer: new Uint8Array(await f.arrayBuffer()) })))
    } catch { setTurns((t) => [...t, { role: 'system', text: 'Could not read that file.' }]); setActivity(''); if (activeRef.current && !mutedRef.current) startListeningRef.current(); return }
    let paths: string[] = []
    try { paths = (await window.electronAPI.voice.saveAttachments(payload))?.paths || [] } catch { /* handled below */ }
    if (!paths.length) { setTurns((t) => [...t, { role: 'system', text: 'Could not attach that file.' }]); setActivity(''); if (activeRef.current && !mutedRef.current) startListeningRef.current(); return }
    const display = '📎 ' + files.map((f) => f.name).join(', ')
    const brain =
      `The user just dropped ${paths.length === 1 ? 'a file' : 'these files'} into voice mode: ` +
      files.map((f, i) => `"${f.name}" at ${paths[i]}`).join('; ') + '. ' +
      `Read ${paths.length === 1 ? 'it' : 'them'} now — for .xlsx/.xls use bash with python3 + openpyxl, for images/PDFs/text use the Read tool. ` +
      'Then tell me in ONE short sentence what it is and ask what I want to know. Keep it spoken and brief.'
    await runTurn(brain, display)
  }, [cancelCurrentTurn, cleanupCapture, stopInterruptMonitor, setUiState, runTurn])

  // Model toggle: cycle Sonnet 5 ↔ Opus 4.8. Switching respawns the voice session
  // on the new model in the main process (conversation kept via resume).
  const MODEL_ORDER = ['claude-sonnet-5', 'claude-opus-4-8']
  useEffect(() => { window.electronAPI.voice.getModel().then((m) => setModel({ model: m.model, label: m.label })).catch(() => {}) }, [])
  const cycleModel = useCallback(async () => {
    const next = MODEL_ORDER[(MODEL_ORDER.indexOf(model.model) + 1) % MODEL_ORDER.length]
    try { const r = await window.electronAPI.voice.setModel(next); if (r.ok) setModel({ model: r.model, label: r.label }) } catch { /* ignore */ }
  }, [model.model])

  // Voice picker: cycle British male voices. Applied to the TTS provider immediately
  // and persisted in localStorage. Renderer-only (voice isn't used in the main process).
  useEffect(() => { setOpenaiVoice(voiceName) }, [voiceName])
  const cycleVoice = useCallback(() => {
    setVoiceNameState((cur) => {
      const next = OPENAI_VOICES[(OPENAI_VOICES.indexOf(cur) + 1) % OPENAI_VOICES.length]
      try { localStorage.setItem('roca-voice-name', next) } catch { /* ignore */ }
      setOpenaiVoice(next)
      return next
    })
  }, [])

  // Speed toggle: cycle the speaker's playback speed (0.75×–2×). Persisted in the
  // shared voice store; applied live to whatever is currently speaking so you hear
  // the change immediately without waiting for the next sentence.
  const cycleSpeed = useCallback(() => {
    const next = cyclePlaybackSpeed()
    if (audioElRef.current) applyPlaybackSpeed(audioElRef.current)
    setSpeed(next)
  }, [])

  // Mute = stop listening (mic off) for noisy rooms; Ora keeps its session and can still speak.
  const toggleMute = useCallback(() => {
    const m = !mutedRef.current
    mutedRef.current = m
    setMuted(m)
    if (m) { cleanupCapture(); stopInterruptMonitor(); if (stateRef.current === 'listening') setUiState('idle') }
    else if (activeRef.current) startListeningRef.current()
  }, [cleanupCapture, stopInterruptMonitor, setUiState])

  useEffect(() => {
    if (active) startListeningRef.current()
    else stop()
  }, [active, stop])

  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => () => { stopRef.current() }, [])

  return { state, turns, activity, muted, toggleMute, model, cycleModel, voiceName, cycleVoice, speed, cycleSpeed, newConversation, interrupt, attachFiles, stop }
}
