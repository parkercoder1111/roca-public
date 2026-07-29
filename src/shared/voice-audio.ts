// Shared ElevenLabs voice utilities — used by both desktop and mobile VoiceMode

const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
const TTS_MODEL = 'eleven_turbo_v2_5'
// End-of-speech detection. SILENCE_THRESHOLD is the "still talking" floor: any
// mic energy above it keeps the turn open. Kept low so soft speech and the quiet
// gaps between words don't get misread as silence and cut you off mid-sentence.
export const SILENCE_THRESHOLD = 0.015
// How long the mic must stay below SILENCE_THRESHOLD before we decide you're done.
// 3s leaves room for a normal mid-sentence pause without clipping you; lower it if
// the wait feels laggy, raise it if it ends your turn while you're still thinking.
export const SILENCE_DURATION_MS = 3000
// Barge-in detection while Ora is speaking. Set well above the residual echo of
// Ora's own voice leaking back through the speakers (imperfect AEC in Electron) —
// a person interrupting is louder and more sustained than that echo.
const INTERRUPT_THRESHOLD = 0.14
// Barge-in must persist this many frames (~0.5s at 60fps), not a brief echo blip.
const INTERRUPT_SUSTAIN_FRAMES = 28
// Ignore the first stretch after Ora starts: that's the TTS onset transient plus
// the mic's AEC filter converging — prime time for a false self-interrupt.
const INTERRUPT_GRACE_MS = 700
export const MAX_RECORD_MS = 120000

export type VoiceState = 'idle' | 'listening' | 'processing' | 'thinking' | 'speaking'

let cachedApiKey: string | null = null

async function getApiKey(fetcher: () => Promise<string | null>): Promise<string | null> {
  if (cachedApiKey) return cachedApiKey
  cachedApiKey = await fetcher()
  return cachedApiKey
}

// Two-tone thinking chime: C5 -> E5
export function playChime() {
  try {
    const ctx = new AudioContext()
    const notes = [523, 659]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = freq
      osc.type = 'sine'
      const t = ctx.currentTime + i * 0.12
      gain.gain.setValueAtTime(0.12, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
      osc.start(t)
      osc.stop(t + 0.25)
    })
    setTimeout(() => { ctx.close().catch(() => {}) }, 450)
  } catch {}
}

let activeAudio: HTMLAudioElement | null = null

export function stopAudio() {
  if (activeAudio) {
    activeAudio.onended = null
    activeAudio.onerror = null
    activeAudio.pause()
    activeAudio.src = ''
    activeAudio = null
  }
}

// ── Playback speed (shared: desktop + mobile) ──
// The speed button cycles through these; label is `${n}×`. 1× is the default.
export const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2]
const SPEED_STORAGE_KEY = 'roca-voice-speed'

function loadInitialSpeed(): number {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SPEED_STORAGE_KEY) : null
    const n = raw ? parseFloat(raw) : NaN
    return SPEED_OPTIONS.includes(n) ? n : 1
  } catch { return 1 }
}

let playbackSpeed = loadInitialSpeed()

export function getPlaybackSpeed(): number { return playbackSpeed }

/** Set + persist the speaker speed, and apply it live to any audio already playing. */
export function setPlaybackSpeed(v: number): void {
  if (!SPEED_OPTIONS.includes(v)) return
  playbackSpeed = v
  try { localStorage.setItem(SPEED_STORAGE_KEY, String(v)) } catch { /* ignore */ }
  if (activeAudio) applyPlaybackSpeed(activeAudio)
}

/** Advance to the next speed in the cycle; returns the new speed. */
export function cyclePlaybackSpeed(): number {
  const i = SPEED_OPTIONS.indexOf(playbackSpeed)
  const next = SPEED_OPTIONS[(i + 1) % SPEED_OPTIONS.length]
  setPlaybackSpeed(next)
  return next
}

/** Apply the current speed to an audio element, keeping the voice's pitch natural. */
export function applyPlaybackSpeed(audio: HTMLAudioElement): void {
  audio.playbackRate = playbackSpeed
  // preservesPitch defaults true in modern engines, but set it explicitly (+ the
  // WebKit/iOS-WebView prefix) so higher speeds don't chipmunk the voice.
  audio.preservesPitch = true
  ;(audio as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
}

export async function speakText(text: string, apiKeyFetcher: () => Promise<string | null>, signal?: AbortSignal): Promise<void> {
  stopAudio()
  const apiKey = await getApiKey(apiKeyFetcher)
  if (!apiKey) throw new Error('No API key')
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    signal,
  })
  if (!res.ok) throw new Error(`TTS ${res.status}`)
  const blob = await res.blob()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const audio = new Audio(url)
    activeAudio = audio
    applyPlaybackSpeed(audio)
    if (signal) {
      signal.addEventListener('abort', () => {
        if (activeAudio === audio) stopAudio()
        URL.revokeObjectURL(url)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    }
    audio.onended = () => { URL.revokeObjectURL(url); activeAudio = null; resolve() }
    audio.onerror = () => { URL.revokeObjectURL(url); activeAudio = null; reject() }
    audio.play().catch(reject)
  })
}

export async function transcribeAudio(blob: Blob, apiKeyFetcher: () => Promise<string | null>): Promise<string> {
  const apiKey = await getApiKey(apiKeyFetcher)
  if (!apiKey) throw new Error('No API key')
  const form = new FormData()
  form.append('file', blob, 'audio.webm')
  form.append('model_id', 'scribe_v1')
  form.append('language_code', 'eng')
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  })
  if (!res.ok) throw new Error(`STT ${res.status}`)
  const data = await res.json()
  return data.text || ''
}

// Detect a real user barge-in during TTS playback — WITHOUT tripping on Ora's own
// voice echoing back through the speakers. Three guards work together: a grace
// period at the start (skip the TTS onset + AEC warm-up), a threshold set above
// the echo floor, and a sustained-frames requirement so a brief blip is ignored.
// Peak levels are logged (throttled) so the threshold can be tuned to a real room.
export function startInterruptMonitor(onInterrupt: () => void): () => void {
  let stopped = false
  let raf = 0
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  const startedAt = performance.now()
  let peak = 0
  let lastLog = startedAt

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then(s => {
      if (stopped) { s.getTracks().forEach(t => t.stop()); return }
      stream = s
      ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(s)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      let speechFrames = 0

      const check = () => {
        if (stopped) return
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.sqrt(sum / data.length)
        if (rms > peak) peak = rms
        const now = performance.now()
        if (now - lastLog > 1500) {
          console.debug(`[voice] barge-in monitor: peak rms=${peak.toFixed(3)} (fires above ${INTERRUPT_THRESHOLD})`)
          peak = 0; lastLog = now
        }
        // Grace period: the first moments are Ora's own audio onset leaking in
        // before AEC settles — never treat that as a barge-in.
        if (now - startedAt < INTERRUPT_GRACE_MS) { raf = requestAnimationFrame(check); return }
        if (rms > INTERRUPT_THRESHOLD) {
          speechFrames++
          if (speechFrames > INTERRUPT_SUSTAIN_FRAMES) {
            console.debug(`[voice] barge-in detected: rms=${rms.toFixed(3)} sustained ${speechFrames} frames`)
            onInterrupt(); return
          }
        } else {
          speechFrames = 0
        }
        raf = requestAnimationFrame(check)
      }
      raf = requestAnimationFrame(check)
    })
    .catch(() => {})

  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    stream?.getTracks().forEach(t => t.stop())
    ctx?.close().catch(() => {})
  }
}
