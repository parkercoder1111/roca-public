// Web Speech API wrapper — speech-to-text + text-to-speech singleton
// OWNERSHIP: This singleton is designed to be owned by exactly one mounted
// component at a time. If VoiceMode remounts, callbacks from the prior mount
// may linger until the next onFinalResult / onInterimResult call overwrites them.

// Minimal typed interfaces for the Web Speech API (not in lib.dom.d.ts on all targets)
interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

export interface SpeechRecognitionInstance {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  abort(): void
  start(): void
  stop(): void
}

type ResultCallback = (text: string) => void
type InterimCallback = (text: string) => void
type ErrorCallback = (err: string) => void
type ListeningChangeCallback = (isListening: boolean) => void

// SpeechRecognition constructor — available in Chromium (Electron).
// Window type augmented in App.tsx to expose both standard and webkit variants.
const SpeechRecognitionAPI: (new () => SpeechRecognitionInstance) | undefined =
  window.SpeechRecognition || window.webkitSpeechRecognition

class SpeechRecognitionManager {
  // ── State ──────────────────────────────────────────────────────────────
  isListening = false
  isMuted = false

  private recognition: SpeechRecognitionInstance | null = null
  private synthesis = window.speechSynthesis

  private onFinalCb: ResultCallback | null = null
  private onInterimCb: InterimCallback | null = null
  private onErrorCb: ErrorCallback | null = null
  private onListeningChangeCb: ListeningChangeCallback | null = null

  private _restartOnEnd = false
  private _utterance: SpeechSynthesisUtterance | null = null
  private _cachedVoices: SpeechSynthesisVoice[] | null = null

  // ── Availability ───────────────────────────────────────────────────────
  get isAvailable(): boolean {
    return !!SpeechRecognitionAPI
  }

  // ── Callbacks ──────────────────────────────────────────────────────────
  onFinalResult(cb: ResultCallback) { this.onFinalCb = cb }
  onInterimResult(cb: InterimCallback) { this.onInterimCb = cb }
  onError(cb: ErrorCallback) { this.onErrorCb = cb }
  onListeningChange(cb: ListeningChangeCallback) { this.onListeningChangeCb = cb }

  // ── Speech-to-text ─────────────────────────────────────────────────────
  start() {
    if (!SpeechRecognitionAPI || this.isListening || this.isMuted) return
    this._buildRecognition()
    try {
      this.recognition!.start()
    } catch {
      // ignore "already started" errors
    }
  }

  stop() {
    this._restartOnEnd = false
    if (this.recognition) {
      try { this.recognition.stop() } catch {}
    }
    this.isListening = false
  }

  startContinuous() {
    this._restartOnEnd = true
    this.start()
  }

  stopContinuous() {
    this._restartOnEnd = false
    this.stop()
  }

  toggleMute() {
    this.isMuted = !this.isMuted
    if (this.isMuted && this.isListening) this.stop()
  }

  // ── Text-to-speech ─────────────────────────────────────────────────────
  // NOTE: This method uses the Web Speech API (SpeechSynthesis) — browser-native TTS.
  // This is NOT the Voice Mode Phase 1 TTS path.
  // For Voice Mode Phase 1 TTS, use speakText() from src/shared/voice-audio.ts (ElevenLabs).
  speak(text: string, onEnd?: () => void) {
    if (!text.trim()) return
    this.synthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    utterance.rate = 1.05
    utterance.pitch = 1.0

    // Cache voice list (stable within a session)
    if (!this._cachedVoices) {
      this._cachedVoices = this.synthesis.getVoices()
      if (this._cachedVoices.length === 0) {
        this.synthesis.addEventListener('voiceschanged', () => {
          this._cachedVoices = this.synthesis.getVoices()
        }, { once: true })
      }
    }
    const voices = this._cachedVoices
    const preferred = voices.find(v =>
      /en[-_]US/i.test(v.lang) &&
      /(natural|siri|samantha|karen|daniel|aria|guy|jenny|neural)/i.test(v.name)
    ) || voices.find(v => /en[-_]US/i.test(v.lang))
    if (preferred) utterance.voice = preferred

    if (onEnd) utterance.onend = onEnd
    this._utterance = utterance
    this.synthesis.speak(utterance)
  }

  stopSpeaking() {
    this.synthesis.cancel()
    this._utterance = null
  }

  isSpeaking(): boolean {
    return this.synthesis.speaking
  }

  // ── Private ────────────────────────────────────────────────────────────
  private _buildRecognition() {
    if (this.recognition) {
      try { this.recognition.abort() } catch {}
    }

    const rec = new SpeechRecognitionAPI!()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.maxAlternatives = 1

    rec.onstart = () => { this.isListening = true; this.onListeningChangeCb?.(true) }

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const alt = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          final += alt
        } else {
          interim += alt
        }
      }
      if (interim && this.onInterimCb) this.onInterimCb(interim)
      if (final && this.onFinalCb) this.onFinalCb(final)
    }

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        this.onErrorCb?.(event.error)
      }
      this.isListening = false
    }

    rec.onend = () => {
      this.isListening = false
      this.onListeningChangeCb?.(false)
      if (this._restartOnEnd && !this.isMuted) {
        // Small delay to avoid rapid restart loops on silence
        setTimeout(() => {
          if (this._restartOnEnd && !this.isMuted) {
            this._buildRecognition()
            try { this.recognition!.start() } catch {}
          }
        }, 100)
      }
    }

    this.recognition = rec
  }
}

// Singleton
export const speechRecognition = new SpeechRecognitionManager()
