// Web Speech API wrapper — speech-to-text + text-to-speech singleton
// OWNERSHIP: This singleton is designed to be owned by exactly one mounted
// component at a time. If VoiceMode remounts, callbacks from the prior mount
// may linger until the next onFinalResult / onInterimResult call overwrites them.

export interface SpeechRecognitionState {
  isListening: boolean
  isMuted: boolean
  isSpeaking: boolean
}

type ResultCallback = (text: string) => void
type InterimCallback = (text: string) => void
type ErrorCallback = (err: string) => void

// Use any-cast for the SpeechRecognition constructor — it's available in
// Chromium (Electron) but TypeScript's DOM lib types it as an interface
// without a globally-accessible constructor value.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpeechRecognitionAPI: (new () => any) | undefined =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

class SpeechRecognitionManager {
  // ── State ──────────────────────────────────────────────────────────────
  isListening = false
  isMuted = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognition: any | null = null
  private synthesis = window.speechSynthesis

  private onFinalCb: ResultCallback | null = null
  private onInterimCb: InterimCallback | null = null
  private onErrorCb: ErrorCallback | null = null

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

  // ── State snapshot ─────────────────────────────────────────────────────
  getState(): SpeechRecognitionState {
    return {
      isListening: this.isListening,
      isMuted: this.isMuted,
      isSpeaking: this.isSpeaking(),
    }
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

    rec.onstart = () => { this.isListening = true }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (event: any) => {
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (event: any) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        this.onErrorCb?.(event.error)
      }
      this.isListening = false
    }

    rec.onend = () => {
      this.isListening = false
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
const instance = new SpeechRecognitionManager()
export default instance
