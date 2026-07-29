export type VoiceProviderName = 'elevenlabs' | 'openai'

export interface SttProvider {
  transcribe(blob: Blob, apiKey: string): Promise<string>
}
export interface TtsProvider {
  synthesize(text: string, apiKey: string, signal?: AbortSignal): Promise<ArrayBuffer>
}

/** Voice layer defaults. Flip `provider` to swap the whole voice stack. */
export const VOICE_DEFAULTS = {
  provider: 'openai' as VoiceProviderName,
  elevenVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
  elevenTtsModel: 'eleven_flash_v2_5',
  elevenSttModel: 'scribe_v1',
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiVoice: 'onyx',
  openaiSttModel: 'gpt-4o-mini-transcribe',
}

// British male voices (all steerable via the instructions below). Picker cycles these.
export const OPENAI_VOICES = ['onyx', 'ash', 'ballad', 'echo', 'verse', 'sage']
const OPENAI_TTS_INSTRUCTIONS = 'Speak like a British man with a natural, warm British English accent. Conversational, clear, and friendly.'
// Mutable current voice — the picker updates it via setOpenaiVoice().
let openaiVoice = VOICE_DEFAULTS.openaiVoice
export function setOpenaiVoice(v: string): void { if (OPENAI_VOICES.includes(v)) openaiVoice = v }
export function getOpenaiVoice(): string { return openaiVoice }

const elevenTts: TtsProvider = {
  async synthesize(text, apiKey, signal) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_DEFAULTS.elevenVoiceId}`, {
      method: 'POST',
      signal,
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: VOICE_DEFAULTS.elevenTtsModel,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    })
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}`)
    return res.arrayBuffer()
  },
}

const elevenStt: SttProvider = {
  async transcribe(blob, apiKey) {
    const form = new FormData()
    form.append('file', blob, 'audio.webm')
    form.append('model_id', VOICE_DEFAULTS.elevenSttModel)
    form.append('language_code', 'eng')
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    })
    if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}`)
    const data = await res.json()
    return (data.text ?? '').trim()
  },
}

const openaiTts: TtsProvider = {
  async synthesize(text, apiKey, signal) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VOICE_DEFAULTS.openaiTtsModel,
        voice: openaiVoice,
        input: text,
        instructions: OPENAI_TTS_INSTRUCTIONS,
        response_format: 'mp3',
      }),
    })
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}`)
    return res.arrayBuffer()
  },
}

const openaiStt: SttProvider = {
  async transcribe(blob, apiKey) {
    const form = new FormData()
    form.append('file', blob, 'audio.webm')
    form.append('model', VOICE_DEFAULTS.openaiSttModel)
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!res.ok) throw new Error(`OpenAI STT ${res.status}`)
    const data = await res.json()
    return (data.text ?? '').trim()
  },
}

export function getTtsProvider(name: VoiceProviderName): TtsProvider {
  return name === 'openai' ? openaiTts : elevenTts
}
export function getSttProvider(name: VoiceProviderName): SttProvider {
  return name === 'openai' ? openaiStt : elevenStt
}
