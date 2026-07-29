import { describe, it, expect } from 'vitest'
import { encodeWavPcm16 } from './wav'

// Read a little-endian value out of the header for assertions.
const u32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const str = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.slice(o, o + n))
const i16 = (b: Uint8Array, o: number) => { const v = b[o] | (b[o + 1] << 8); return v >= 0x8000 ? v - 0x10000 : v }

describe('encodeWavPcm16', () => {
  it('writes a valid 16 kHz mono PCM header', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 0, 0, 0]), 16000)
    expect(str(wav, 0, 4)).toBe('RIFF')
    expect(str(wav, 8, 4)).toBe('WAVE')
    expect(str(wav, 12, 4)).toBe('fmt ')
    expect(u16(wav, 20)).toBe(1)          // PCM
    expect(u16(wav, 22)).toBe(1)          // mono
    expect(u32(wav, 24)).toBe(16000)      // sample rate
    expect(u16(wav, 34)).toBe(16)         // bits per sample
    expect(str(wav, 36, 4)).toBe('data')
    expect(u32(wav, 40)).toBe(8)          // 4 samples * 2 bytes
    expect(wav.length).toBe(44 + 8)
  })

  it('encodes samples as little-endian 16-bit and clamps out-of-range values', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2]), 16000)
    expect(i16(wav, 44)).toBe(0)
    expect(i16(wav, 46)).toBe(32767)      // +1 → max
    expect(i16(wav, 48)).toBe(-32768)     // -1 → min
    expect(i16(wav, 50)).toBe(32767)      // +2 clamps to +1
    expect(i16(wav, 52)).toBe(-32768)     // -2 clamps to -1
  })
})
