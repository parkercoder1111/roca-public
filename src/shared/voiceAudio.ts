// Shared ElevenLabs voice utilities — used by both desktop and mobile VoiceMode

export const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
export const TTS_MODEL = 'eleven_turbo_v2_5'
export const SILENCE_THRESHOLD = 0.025
export const SILENCE_DURATION_MS = 3500
export const INTERRUPT_THRESHOLD = 0.06
export const MAX_RECORD_MS = 120000

export type VoiceState = 'idle' | 'listening' | 'processing' | 'thinking' | 'speaking'

let cachedApiKey: string | null = null

export function setCachedApiKey(key: string | null) {
  cachedApiKey = key
}

export async function getApiKey(fetcher: () => Promise<string | null>): Promise<string | null> {
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

// Detect user speech during TTS playback to allow interruption
export function startInterruptMonitor(onInterrupt: () => void): () => void {
  let stopped = false
  let raf = 0
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null

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
        if (rms > INTERRUPT_THRESHOLD) {
          speechFrames++
          if (speechFrames > 12) { onInterrupt(); return }
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
