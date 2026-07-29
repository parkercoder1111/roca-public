import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface VoiceSessionRecord {
  sessionId: string
  /** True once a claude process has actually spawned for this id (i.e. a
   *  transcript exists to resume). Drives new (`--session-id`) vs resume
   *  (`--resume ... --fork-session`). A freshly-minted id is NOT started. */
  started: boolean
  created: string
  lastActive: string
  messageCount: number
}

const DEFAULT_WARN_AFTER = 20
// Rotate to a fresh session after this many turns. Resuming an ever-growing
// transcript is what wedged voice mode (context bloat → slow/no reply → endless
// "thinking"). Recent context survives via the continuity prepend on turn 1.
const DEFAULT_ROTATE_AFTER = 20
// Never resume a conversation that's been idle longer than this — a multi-day-old
// transcript is huge and stale. Start fresh instead. (2 hours.)
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000

/**
 * Mirrors Assistant Slack's SessionManager (agents/assistant-slack/assistant.py):
 * one persisted record represents the single ongoing voice conversation.
 * `getOrCreate` returns `isNew` so the brain knows whether to start fresh or
 * resume. This is its OWN brain — nothing here touches Assistant's store.
 */
export class VoiceSessionManager {
  private record: VoiceSessionRecord | null = null
  private readonly warnAfter: number
  private readonly rotateAfter: number
  private readonly staleMs: number

  constructor(private readonly filePath: string, opts?: { warnAfter?: number; rotateAfter?: number; staleMs?: number }) {
    this.warnAfter = opts?.warnAfter ?? DEFAULT_WARN_AFTER
    this.rotateAfter = opts?.rotateAfter ?? DEFAULT_ROTATE_AFTER
    this.staleMs = opts?.staleMs ?? DEFAULT_STALE_MS
    this.load()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      this.record = JSON.parse(readFileSync(this.filePath, 'utf8')) as VoiceSessionRecord
    } catch {
      this.record = null
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.record, null, 2))
    } catch {
      /* non-fatal — voice still works, just won't persist this write */
    }
  }

  private now(): string {
    return new Date().toISOString()
  }

  private mint(): VoiceSessionRecord {
    return { sessionId: randomUUID(), started: false, created: this.now(), lastActive: this.now(), messageCount: 0 }
  }

  /** Assistant get_or_create. isNew=true means "start a fresh claude session";
   *  isNew=false means "resume the existing transcript". A session that's over
   *  the turn budget or has gone stale is auto-replaced with a fresh one rather
   *  than resumed — resuming a bloated transcript is what wedged voice mode. */
  getOrCreate(): { sessionId: string; isNew: boolean } {
    if (!this.record || this.isStale() || this.overTurnBudget()) {
      this.record = this.mint()
      this.save()
      return { sessionId: this.record.sessionId, isNew: true }
    }
    this.record.lastActive = this.now()
    this.save()
    return { sessionId: this.record.sessionId, isNew: !this.record.started }
  }

  private isStale(): boolean {
    if (!this.record) return false
    const age = Date.now() - Date.parse(this.record.lastActive)
    return Number.isFinite(age) && age > this.staleMs
  }

  private overTurnBudget(): boolean {
    return !!this.record && this.record.messageCount >= this.rotateAfter
  }

  /** True when the LIVE session has spent its turn budget and should be rotated
   *  to a fresh one before the next turn (checked by the voice brain each turn). */
  shouldRotate(): boolean {
    return this.overTurnBudget()
  }

  /** Call after a claude process has spawned for the current id. */
  markStarted(): void {
    if (!this.record) return
    this.record.started = true
    this.record.lastActive = this.now()
    this.save()
  }

  /** Update to the uuid claude actually runs under (resume + --fork-session
   *  forks to a new id, reported via onSessionId) so the next launch resumes it. */
  setSessionId(id: string): void {
    if (!this.record) return
    this.record.sessionId = id
    this.record.started = true
    this.save()
  }

  recordMessage(): void {
    if (!this.record) return
    this.record.messageCount += 1
    this.record.started = true
    this.record.lastActive = this.now()
    this.save()
  }

  /** Drop the current record (resume-failure recovery). */
  invalidate(): void {
    this.record = null
    this.save()
  }

  /** Reset to a fresh, not-yet-started conversation; returns the new id. */
  newConversation(): string {
    this.record = this.mint()
    this.save()
    return this.record.sessionId
  }

  shouldWarnContext(): boolean {
    return !!this.record && this.record.messageCount >= this.warnAfter
  }

  current(): VoiceSessionRecord | null {
    return this.record
  }
}
