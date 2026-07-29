import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSttProvider, getTtsProvider, VOICE_DEFAULTS } from './providers'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('provider selection', () => {
  it('returns elevenlabs + openai implementations', () => {
    expect(getTtsProvider('elevenlabs')).toBeTruthy()
    expect(getTtsProvider('openai')).toBeTruthy()
    expect(getSttProvider('elevenlabs')).toBeTruthy()
    expect(getSttProvider('openai')).toBeTruthy()
  })
})

describe('ElevenLabs TTS request', () => {
  it('POSTs to the flash endpoint with the api key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
    vi.stubGlobal('fetch', fetchMock)
    await getTtsProvider('elevenlabs').synthesize('hi', 'KEY')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain(`/v1/text-to-speech/${VOICE_DEFAULTS.elevenVoiceId}`)
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('KEY')
    expect(JSON.parse(init.body as string).model_id).toBe('eleven_flash_v2_5')
  })
})

describe('OpenAI TTS request', () => {
  it('POSTs to the openai speech endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
    vi.stubGlobal('fetch', fetchMock)
    await getTtsProvider('openai').synthesize('hi', 'KEY')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com/v1/audio/speech')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer KEY')
  })
})
