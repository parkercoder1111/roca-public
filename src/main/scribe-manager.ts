// ═══════════════════════════════════════════
//  SCRIBE MANAGER — hosts the meeting note-taker in ROCA
//
//  Scribe is a Python sidecar (~/scribe) that captures mic + system audio (no bot
//  joins the call), transcribes locally with whisper.cpp, and emits me/them
//  transcript segments. Unlike Echo, capture is ON-DEMAND: startRecording() spawns
//  the sidecar, stopRecording() sends SIGTERM and it finalizes.
//
//  Sidecar contract — newline-delimited JSON on STDOUT:
//    {"type":"ready"}
//    {"type":"status","state":"recording|transcribing|idle"}
//    {"type":"segment","speaker":"me|them","text":..,"start_ms":..,"end_ms":..}
//    {"type":"done","recording_id":..}
//    {"type":"error","message":..}
//  Human logs come on STDERR and are appended to userData/scribe.log.
// ═══════════════════════════════════════════
import { spawn, ChildProcess } from 'child_process'
import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  createRecording,
  addSegment,
  finishRecording,
  getSegments,
  getRecording,
  updateRecordingNotes,
  updateRecordingStatus,
  renameRecording,
} from './database'
import { runClaude, cleanupPrompt, notesPrompt, askPrompt } from './scribe-claude'
import { writeMeetingMemory } from './scribe-memory'
import { showPill, hidePill } from './scribe-pill-window'
import { getUpcomingEvents, type CalEvent } from './scribe-calendar'

type ScribeState = 'idle' | 'recording' | 'transcribing' | 'error'

export class ScribeManager {
  private proc: ChildProcess | null = null
  private stdoutBuf = ''
  private recordingId: number | null = null
  private lastState: ScribeState = 'idle'
  private notifiedEvents = new Set<string>()

  private readonly dir = process.env.SCRIBE_DIR || path.join(os.homedir(), 'scribe')
  private get pythonPath() {
    return path.join(this.dir, '.venv', 'bin', 'python')
  }
  private get scriptPath() {
    return path.join(this.dir, 'scribe.py')
  }
  private get logPath() {
    return path.join(app.getPath('userData'), 'scribe.log')
  }

  // Nothing to do at app-start — recording is on-demand.
  start(): void {}

  // Called on app quit — make sure we never leave a sidecar running.
  stop(): void {
    this.stopRecording()
  }

  getStatus(): ScribeState {
    return this.lastState
  }

  startRecording(a: { title: string; calendarEventId?: string | null }): { id: number } | { error: string } {
    if (!fs.existsSync(this.pythonPath) || !fs.existsSync(this.scriptPath)) {
      return { error: `Scribe sidecar not found at ${this.scriptPath}` }
    }
    if (this.proc) this.stopRecording()

    this.recordingId = createRecording({ title: a.title, calendarEventId: a.calendarEventId })
    console.log(`[Scribe] recording ${this.recordingId} → ${this.pythonPath} ${this.scriptPath}`)

    const proc = spawn(this.pythonPath, [this.scriptPath], {
      cwd: this.dir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc = proc

    proc.stdout?.setEncoding('utf-8')
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk))

    proc.stderr?.setEncoding('utf-8')
    proc.stderr?.on('data', (chunk: string) => {
      try {
        fs.appendFileSync(this.logPath, chunk)
      } catch {
        /* best-effort */
      }
    })

    proc.on('exit', (code) => {
      console.log(`[Scribe] sidecar exited (code ${code})`)
      hidePill()
      // If it died without a clean 'done', mark the recording errored.
      if (this.recordingId != null && this.lastState !== 'idle') {
        try {
          finishRecording(this.recordingId, { status: 'error' })
        } catch {
          /* ignore */
        }
        this.broadcast('scribe:done', { recordingId: this.recordingId })
      }
      this.proc = null
    })

    proc.on('error', (err) => {
      console.error('[Scribe] sidecar spawn error:', err)
      this.lastState = 'error'
      this.broadcast('scribe:status', { state: 'error' })
      hidePill()
    })

    showPill()
    return { id: this.recordingId }
  }

  stopRecording(): void {
    // Vanish the pill instantly — the final transcription flush + notes run in
    // the background, so stopping always feels immediate.
    hidePill()
    if (this.proc) {
      this.proc.kill('SIGTERM')
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let idx: number
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      if (!line) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch {
        try {
          fs.appendFileSync(this.logPath, `[non-json stdout] ${line}\n`)
        } catch {
          /* ignore */
        }
        continue
      }
      this.dispatch(event)
    }
  }

  private dispatch(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'ready':
        console.log('[Scribe] sidecar ready')
        break
      case 'status':
        this.lastState = (event.state as ScribeState) || 'idle'
        this.broadcast('scribe:status', { state: this.lastState })
        break
      case 'segment':
        if (this.recordingId != null) {
          try {
            addSegment({
              recordingId: this.recordingId,
              speaker: (event.speaker as string) || 'them',
              text: (event.text as string) || '',
              startMs: (event.start_ms as number) ?? 0,
              endMs: (event.end_ms as number) ?? 0,
            })
          } catch (err) {
            console.error('[Scribe] failed to store segment:', err)
          }
          this.broadcast('scribe:segment', { recordingId: this.recordingId, ...event })
        }
        break
      case 'done': {
        const id = this.recordingId
        hidePill()
        if (id != null) {
          try {
            // Audio + transcription are done; notes come next (async).
            finishRecording(id, { status: 'transcribed' })
          } catch {
            /* ignore */
          }
          this.broadcast('scribe:done', { recordingId: id })
          void this.postProcess(id)
        }
        this.recordingId = null
        this.lastState = 'idle'
        break
      }
      case 'error':
        console.error('[Scribe] sidecar error:', event.message)
        break
      default:
        break
    }
  }

  // ── post-call AI pipeline (Haiku cleanup → Sonnet notes), all on the Max subscription ──

  private async postProcess(id: number): Promise<void> {
    const transcript = this.buildTranscript(id)
    if (!transcript.trim()) {
      updateRecordingStatus(id, 'done')
      this.broadcast('scribe:updated', { recordingId: id })
      return
    }
    try {
      updateRecordingStatus(id, 'cleaning')
      this.broadcast('scribe:updated', { recordingId: id })
      const cleaned = await runClaude('haiku', cleanupPrompt(transcript))
      updateRecordingNotes(id, { cleaned_transcript: cleaned })

      updateRecordingStatus(id, 'noting')
      this.broadcast('scribe:updated', { recordingId: id })
      const notes = await runClaude('sonnet', notesPrompt(cleaned))
      const summary = notes.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || ''
      updateRecordingNotes(id, { notes_md: notes, summary: summary.slice(0, 200) })

      // Flow into memory as a per-meeting note (rides any configured file-sync).
      try {
        const rec = getRecording(id)
        if (rec) {
          const memPath = writeMeetingMemory({
            id,
            title: rec.title,
            startedAt: rec.started_at,
            notesMd: notes,
            cleanedTranscript: cleaned,
          })
          updateRecordingNotes(id, { memory_path: memPath })
        }
      } catch (err) {
        console.error('[Scribe] memory write failed:', err)
      }

      updateRecordingStatus(id, 'done')
      console.log(`[Scribe] notes generated for recording ${id}`)
    } catch (err) {
      console.error('[Scribe] post-process failed:', err)
      // The raw transcript is still usable — don't leave the UI stuck.
      updateRecordingStatus(id, 'done')
    }
    this.broadcast('scribe:updated', { recordingId: id })
  }

  private buildTranscript(id: number): string {
    return getSegments(id)
      .map((s) => `${s.speaker === 'me' ? 'Me' : 'Them'}: ${s.text}`)
      .join('\n')
  }

  rename(id: number, title: string): { ok: boolean } {
    renameRecording(id, title)
    this.broadcast('scribe:updated', { recordingId: id })
    return { ok: true }
  }

  async ask(recordingId: number, question: string): Promise<{ answer: string } | { error: string }> {
    try {
      const rec = getRecording(recordingId)
      const transcript = rec?.cleaned_transcript || this.buildTranscript(recordingId)
      const answer = await runClaude('sonnet', askPrompt(rec?.notes_md || '', transcript, question))
      return { answer }
    } catch (err) {
      return { error: String(err) }
    }
  }

  // ── calendar: "Coming up" + auto "Start note taker" popup ──

  async getUpcoming(): Promise<CalEvent[]> {
    try {
      return await getUpcomingEvents()
    } catch (err) {
      console.error('[Scribe] calendar fetch failed:', err)
      return []
    }
  }

  // Called on a 60s timer. Fires a popup when a meeting is about to start and
  // we're not already recording (each event only fires once).
  async checkMeetingStart(): Promise<void> {
    if (this.proc) return
    let events: CalEvent[]
    try {
      events = await getUpcomingEvents(1)
    } catch {
      return
    }
    const now = Date.now()
    for (const e of events) {
      const delta = new Date(e.start).getTime() - now
      // starting within 90s (or up to 2 min late) and not yet prompted
      if (delta <= 90_000 && delta >= -120_000 && !this.notifiedEvents.has(e.id)) {
        this.notifiedEvents.add(e.id)
        this.broadcast('scribe:meeting-starting', e)
      }
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
}
