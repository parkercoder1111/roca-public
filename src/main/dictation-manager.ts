// ═══════════════════════════════════════════
//  DICTATION MANAGER — hosts Echo (fn-to-talk) inside ROCA
//
//  Echo is a small Python sidecar (~/flow) that captures the fn key system-wide,
//  records the mic, transcribes + polishes via OpenAI, and pastes at the cursor
//  in whatever app is focused. ROCA is its host, not its boundary: dictation
//  works everywhere; ROCA just launches it, keeps it alive, and learns from the
//  corrections the user makes.
//
//  Lifecycle mirrors PtyManager: spawn a child, stream its output, restart on
//  exit (throttled, with a crash-loop guard).
//
//  Sidecar contract — newline-delimited JSON on STDOUT:
//    {"type":"ready"}
//    {"type":"status","state":"idle|recording|working|sent"}
//    {"type":"correction","raw":..,"pasted":..,"corrected":..,"app":..,"ts":..}
//    {"type":"error","message":..}
//  Human logs come on STDERR and are appended to userData/echo.log.
// ═══════════════════════════════════════════
import { spawn, ChildProcess } from 'child_process'
import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  insertCorrection,
  countUnlearnedCorrections,
  getUnlearnedCorrections,
  markCorrectionsLearned,
  upsertDictionaryEntry,
  addStyleNote,
  getDictionary,
  getStyleNotes,
} from './database'
import { getRawKey } from './api-keys-config'

const RESTART_DELAY_MS = 3000
const MAX_RESTARTS_PER_HOUR = 10
const LEARN_THRESHOLD = 10 // distill after this many un-learned corrections
const POLISH_MODEL = 'gpt-4o-mini'

type DictationState = 'idle' | 'recording' | 'working' | 'sent'

export class DictationManager {
  private proc: ChildProcess | null = null
  private stdoutBuf = ''
  private restartTimes: number[] = []
  private stopped = false
  private learning = false
  private lastState: DictationState = 'idle'

  private readonly flowDir = process.env.ECHO_DIR || path.join(os.homedir(), 'flow')
  private get pythonPath() {
    return path.join(this.flowDir, '.venv', 'bin', 'python')
  }
  private get scriptPath() {
    return path.join(this.flowDir, 'headless.py')
  }
  private get logPath() {
    return path.join(app.getPath('userData'), 'echo.log')
  }
  private get learnedPath() {
    return path.join(app.getPath('userData'), 'echo-learned.json')
  }

  // ── lifecycle ──

  start(): void {
    if (process.env.ECHO_DISABLED === '1') {
      console.log('[Dictation] disabled via ECHO_DISABLED')
      return
    }
    if (!fs.existsSync(this.pythonPath) || !fs.existsSync(this.scriptPath)) {
      console.log(
        `[Dictation] sidecar not found (${this.scriptPath}); dictation off. ` +
          'Set ECHO_DIR to the flow directory to enable.'
      )
      return
    }
    this.stopped = false
    this.spawn()
  }

  stop(): void {
    this.stopped = true
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
  }

  getStatus(): DictationState {
    return this.lastState
  }

  private spawn(): void {
    console.log(`[Dictation] launching Echo sidecar: ${this.pythonPath} ${this.scriptPath}`)
    const proc = spawn(this.pythonPath, [this.scriptPath], {
      cwd: this.flowDir,
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
        /* best-effort logging */
      }
    })

    proc.on('exit', (code) => {
      console.log(`[Dictation] sidecar exited (code ${code})`)
      this.proc = null
      if (!this.stopped) this.scheduleRestart()
    })

    proc.on('error', (err) => {
      console.error('[Dictation] sidecar spawn error:', err)
    })
  }

  private scheduleRestart(): void {
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((t) => now - t < 3_600_000)
    if (this.restartTimes.length >= MAX_RESTARTS_PER_HOUR) {
      console.error(
        '[Dictation] sidecar crash-looping — giving up for this hour. ' +
          'Check echo.log + permissions (Input Monitoring, Microphone).'
      )
      return
    }
    this.restartTimes.push(now)
    setTimeout(() => {
      if (!this.stopped) this.spawn()
    }, RESTART_DELAY_MS)
  }

  // ── stdout → events ──

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
        // Not JSON (stray print) — log and move on.
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
        console.log('[Dictation] sidecar ready')
        break
      case 'status':
        this.lastState = (event.state as DictationState) || 'idle'
        this.broadcast('dictation:status', { state: this.lastState })
        break
      case 'correction':
        this.onCorrection(event)
        break
      case 'error':
        console.error('[Dictation] sidecar error:', event.message)
        break
      default:
        break
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  // ── corrections + learning ──

  private onCorrection(event: Record<string, unknown>): void {
    try {
      insertCorrection({
        app: (event.app as string) ?? null,
        raw_transcript: (event.raw as string) ?? '',
        pasted: (event.pasted as string) ?? '',
        corrected: (event.corrected as string) ?? '',
      })
      this.broadcast('dictation:correction', event)
    } catch (err) {
      console.error('[Dictation] failed to store correction:', err)
      return
    }
    void this.maybeLearn()
  }

  private async maybeLearn(): Promise<void> {
    if (this.learning) return
    let pending = 0
    try {
      pending = countUnlearnedCorrections()
    } catch {
      return
    }
    if (pending < LEARN_THRESHOLD) return
    this.learning = true
    try {
      await this.learn()
    } catch (err) {
      console.error('[Dictation] learn failed:', err)
    } finally {
      this.learning = false
    }
  }

  /**
   * Distill un-learned corrections into dictionary + style notes via the LLM,
   * then compile the artifact Echo's polish pass reads.
   */
  private async learn(): Promise<void> {
    const corrections = getUnlearnedCorrections(200)
    if (corrections.length === 0) return

    const apiKey = process.env.OPENAI_API_KEY || getRawKey('OPENAI_API_KEY')
    if (!apiKey) {
      console.error('[Dictation] no OPENAI_API_KEY — cannot distill corrections')
      return
    }

    const examples = corrections
      .map(
        (c, i) =>
          `#${i + 1} [app: ${c.app || 'unknown'}]\n` +
          `Echo pasted: ${c.pasted}\n` +
          `User edited to: ${c.corrected}`
      )
      .join('\n\n')

    const system =
      'You improve a dictation tool by learning from the edits a user makes to ' +
      'text it produced. You are given (pasted -> edited) pairs. Extract two things:\n' +
      '1. dictionary: recurring proper-noun / jargon spelling fixes, as {heard, canonical} ' +
      'pairs (e.g. {"heard":"widget wear","canonical":"WidgetWorks"}). Only include terms you are ' +
      'confident are the SAME word transcribed wrong, not ordinary rewording.\n' +
      '2. style_notes: durable stylistic preferences the edits reveal (e.g. "prefers contractions", ' +
      '"signs off as \'Best, Alex\'", "removes the filler word \'basically\'"). Short imperative notes.\n' +
      'Ignore one-off content changes. Respond with strict JSON: ' +
      '{"dictionary":[{"heard":..,"canonical":..}],"style_notes":[..]}'

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: POLISH_MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: examples },
        ],
      }),
    })
    if (!res.ok) {
      console.error('[Dictation] distill request failed:', res.status, await res.text())
      return
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const content = data.choices?.[0]?.message?.content || '{}'
    let parsed: { dictionary?: { heard: string; canonical: string }[]; style_notes?: string[] }
    try {
      parsed = JSON.parse(content)
    } catch {
      console.error('[Dictation] distill returned non-JSON:', content)
      return
    }

    for (const d of parsed.dictionary ?? []) {
      if (d?.heard && d?.canonical) upsertDictionaryEntry(d.heard.trim(), d.canonical.trim())
    }
    for (const note of parsed.style_notes ?? []) {
      if (note?.trim()) addStyleNote(note.trim())
    }

    markCorrectionsLearned(corrections.map((c) => c.id))
    this.compileArtifact()
    console.log(
      `[Dictation] learned from ${corrections.length} corrections ` +
        `(+${(parsed.dictionary ?? []).length} terms, +${(parsed.style_notes ?? []).length} style notes)`
    )
  }

  /**
   * Compile the DB's learned dictionary + style into echo-learned.json, which
   * Echo's polish pass reads on every dictation (auto-apply, no gate).
   */
  compileArtifact(): void {
    const dictionary: Record<string, string> = {}
    for (const e of getDictionary()) dictionary[e.heard] = e.canonical
    const style_notes = getStyleNotes().join('\n')
    try {
      fs.writeFileSync(
        this.learnedPath,
        JSON.stringify({ dictionary, style_notes }, null, 2)
      )
    } catch (err) {
      console.error('[Dictation] failed to write echo-learned.json:', err)
    }
  }
}
