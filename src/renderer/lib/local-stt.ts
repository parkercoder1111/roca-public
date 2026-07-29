// Local speech-to-text for desktop voice mode: decode the recorded mic blob to
// 16 kHz mono WAV in the renderer, then hand it to whisper.cpp in the main process
// (renderer can't spawn a native binary). Fast (~0.3s on base.en), offline, free —
// the same whisper.cpp path Echo/Scribe already use. Throws on any failure so the
// caller can fall back to cloud STT.

import { encodeWavPcm16 } from '@shared/voice/wav'

const TARGET_RATE = 16000 // what whisper.cpp expects

/** Decode a recorded audio Blob to 16 kHz mono 16-bit PCM WAV bytes. */
export async function blobTo16kMonoWav(blob: Blob): Promise<Uint8Array> {
  const arrayBuf = await blob.arrayBuffer()

  // Decode however it was recorded (webm/opus, usually 48 kHz). A throwaway context
  // is fine — we only need the PCM samples, then we resample below.
  const decodeCtx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf)
  } finally {
    decodeCtx.close().catch(() => {})
  }

  // Resample to 16 kHz mono via an offline render (connecting any channel count to a
  // 1-channel destination downmixes to mono).
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()

  return encodeWavPcm16(rendered.getChannelData(0), TARGET_RATE)
}

/** Transcribe a recorded blob locally via whisper.cpp. Throws if decode fails or
 *  whisper isn't available/errors — callers should fall back to cloud STT. */
export async function transcribeLocalWhisper(blob: Blob): Promise<string> {
  const wav = await blobTo16kMonoWav(blob)
  const res = await window.electronAPI.voice.transcribeLocal(wav)
  if (!res?.ok) throw new Error(res?.error || 'local whisper unavailable')
  return (res.text || '').trim()
}
