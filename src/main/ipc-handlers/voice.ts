import { ipcMain, app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureVoiceSession, sendVoiceText, newVoiceConversation, recoverVoiceSession, interruptVoiceSession, getVoiceModel, setVoiceModel, VOICE_CONTINUITY_FILE } from '../voice-brain'
import { appendVoiceExchange } from '../voice-continuity'
import { applySttCorrections } from '../../shared/voice/stt-corrections'

// ── Local STT (whisper.cpp) ──
// Same binary + model Echo/Scribe use. base.en is fast (~0.3s) and loads quickly;
// override via env if you want a different model (e.g. small.en for better names).
const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli'
const WHISPER_MODEL = process.env.ROCA_WHISPER_MODEL || path.join(os.homedir(), 'scribe', 'models', 'ggml-base.en.bin')
// Bias whisper toward proper nouns that recur in voice mode (base.en otherwise
// mishears rare/coined terms). Set WHISPER_PROMPT to a comma-separated list of
// names/jargon specific to your usage to improve recognition.
const WHISPER_PROMPT = process.env.WHISPER_PROMPT || 'ROCA.'

function runWhisper(wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', wavPath, '-nt', '-l', 'en', '--prompt', WHISPER_PROMPT],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('error', reject) // e.g. binary missing
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err.slice(-400) || `whisper-cli exit ${code}`)))
  })
}

export function registerVoiceHandlers(): void {
  ipcMain.handle('voice:ensure-session', (e) => ensureVoiceSession(e.sender))
  ipcMain.handle('voice:send', (e, text: string) => sendVoiceText(e.sender, text))
  ipcMain.handle('voice:new-conversation', () => ({ sessionId: newVoiceConversation() }))
  ipcMain.handle('voice:interrupt', () => interruptVoiceSession())
  ipcMain.handle('voice:get-model', () => getVoiceModel())
  ipcMain.handle('voice:set-model', (_e, model: string) => setVoiceModel(model))
  ipcMain.handle('voice:recover', (e) => recoverVoiceSession(e.sender))
  ipcMain.handle('voice:record-exchange', (_e, userText: string, replyText: string) => {
    appendVoiceExchange(VOICE_CONTINUITY_FILE, userText, replyText, new Date())
    return { ok: true }
  })
  // Local STT: write the 16 kHz mono WAV the renderer decoded, run whisper.cpp, return
  // the text. Returns { ok: false } (not a throw) when whisper isn't installed or fails,
  // so the renderer can quietly fall back to cloud STT.
  ipcMain.handle('voice:transcribe-local', async (_e, wav: Uint8Array) => {
    if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
      return { ok: false, error: 'whisper.cpp binary or model not found' }
    }
    const tmp = path.join(os.tmpdir(), `roca-stt-${Date.now()}-${Math.round(process.hrtime()[1] % 1e6)}.wav`)
    try {
      fs.writeFileSync(tmp, Buffer.from(wav))
      const raw = await runWhisper(tmp)
      return { ok: true, text: applySttCorrections(raw.replace(/\s+/g, ' ').trim()) }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  })

  // Save dropped files to disk so the voice brain (a claude session) can read them.
  ipcMain.handle('voice:save-attachments', (_e, files: Array<{ name: string; buffer: Uint8Array }>) => {
    const dir = path.join(app.getPath('userData'), 'voice-attachments')
    fs.mkdirSync(dir, { recursive: true })
    const paths: string[] = []
    for (const f of files || []) {
      const safe = (f.name || 'file').replace(/[^\w.\- ]/g, '_')
      const p = path.join(dir, `${Date.now()}-${safe}`)
      try { fs.writeFileSync(p, Buffer.from(f.buffer)); paths.push(p) } catch { /* skip */ }
    }
    return { paths }
  })
}
