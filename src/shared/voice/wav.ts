// Minimal WAV writer — encodes mono Float32 PCM as a 16-bit PCM WAV byte array.
// Used to hand recorded voice audio to local whisper.cpp, which wants 16 kHz mono
// 16-bit WAV. Pure (no DOM/Node deps) so it's unit-testable.

/** Encode mono Float32 samples ([-1, 1]) as a little-endian 16-bit PCM WAV. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length
  const dataBytes = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }

  // RIFF header
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // file size - 8
  writeStr(8, 'WAVE')
  // fmt chunk
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)            // fmt chunk size (PCM)
  view.setUint16(20, 1, true)             // audio format = PCM
  view.setUint16(22, 1, true)             // channels = mono
  view.setUint32(24, sampleRate, true)    // sample rate
  view.setUint32(28, sampleRate * 2, true) // byte rate = rate * blockAlign
  view.setUint16(32, 2, true)             // block align = channels * bytesPerSample
  view.setUint16(34, 16, true)            // bits per sample
  // data chunk
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)

  let off = 44
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    off += 2
  }
  return new Uint8Array(buffer)
}
