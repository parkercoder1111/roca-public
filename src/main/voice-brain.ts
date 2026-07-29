import { app, WebContents } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { ClaudeStreamSession } from './claude-stream-session'
import { VoiceSessionManager } from './voice-session-manager'
import { readVoiceContinuity } from './voice-continuity'

const VOICE_PTY_ID = 'voice'
const VOICE_CWD = path.join(os.homedir(), '.claude')
const CONTINUITY_FILE = path.join(VOICE_CWD, 'state', 'voice-continuity.md')

// Model is switchable at runtime (toggle in the voice overlay → voice-model.txt).
// Sonnet 5 default: fast (~2s) for snappy spoken replies; Opus 4.8 for heavier
// reasoning (~4-5s). Lazy-loaded so app.getPath isn't called at module load.
const VOICE_MODELS: Record<string, string> = { 'claude-sonnet-5': 'Sonnet 5', 'claude-opus-4-8': 'Opus 4.8' }
const DEFAULT_VOICE_MODEL = 'claude-sonnet-5'
let voiceModel: string | null = null
function modelFile(): string { return path.join(app.getPath('userData'), 'voice-model.txt') }
function currentModel(): string {
  if (!voiceModel) {
    try { const v = readFileSync(modelFile(), 'utf8').trim(); voiceModel = VOICE_MODELS[v] ? v : DEFAULT_VOICE_MODEL } catch { voiceModel = DEFAULT_VOICE_MODEL }
  }
  return voiceModel
}
export function getVoiceModel(): { model: string; label: string; models: Record<string, string> } {
  const m = currentModel()
  return { model: m, label: VOICE_MODELS[m] || m, models: VOICE_MODELS }
}
/** Switch the voice model; respawns the session on it (conversation kept via resume). */
export function setVoiceModel(model: string): { ok: boolean; model: string; label: string } {
  if (!VOICE_MODELS[model]) { const m = currentModel(); return { ok: false, model: m, label: VOICE_MODELS[m] || m } }
  voiceModel = model
  try { writeFileSync(modelFile(), model) } catch { /* non-fatal */ }
  if (session) { session.stop(); session = null } // next turn respawns on the new model
  return { ok: true, model, label: VOICE_MODELS[model] }
}

// Voice-style rules — keep replies VERY short, spoken, and unformatted.
// This overrides the verbose Chief-of-Staff persona from the global CLAUDE.md.
const VOICE_SYSTEM_PROMPT = [
  'You are ROCA, in VOICE mode: the user speaks to you and hears your reply read aloud.',
  'Keep replies concise and conversational — say what matters, then stop. No fixed length limit, but do not ramble, pad, or over-explain; match length to what the question actually needs.',
  'Lead with the answer. No preamble, no recap of the question, no lists, no summaries, no sign-off.',
  'Never use markdown, bullet points, numbers, headers, code, or symbols like * # ` — it is all spoken aloud.',
  'Talk like a quick text back to a friend, not a written report or briefing.',
  'If the honest answer needs more, give the one-line headline and ask "want me to go deeper?" instead of dumping it.',
  'Do not read long numbers, URLs, or IDs aloud — round or summarize.',
  'Favor being useful and natural over being exhaustive.',
  'Even after reading a long document, transcript, email, or doing research, give the key takeaway conversationally rather than narrating everything you read — offer to go deeper if it matters.',
  // Capability: control the live ROCA app (does NOT change how brief the spoken reply is).
  'You can control the ROCA app on this Mac via its local RPC: POST http://127.0.0.1:19274/api/rpc with JSON body {"token": T, "method": M, "params": {...}}, where T is the "token" field read from the file ~/Library/Application Support/roca/remote-token.json.',
  'Methods (params shown): "tasks:list" {} and "tasks:get" {"taskId":N} to read tasks; "tasks:create" {"title":"...","priority":"medium","notes":"..."} returns {"id":N}; "task:boot" to open a task AND start its Claude session visibly in ROCA — pass {"taskId":N} for an existing task, or {"title":"...","notes":"...","folder_id":14} to create one and boot it in a SINGLE call (folder_id 14 = Development, which runs the session with permissions bypassed for hands-free coding); "terminal:read" {"taskId":N} to see what a task\'s session is doing; "terminal:send" {"taskId":N,"input":"<text>"} to type a message into that session (it auto-submits).',
  'CRITICAL: to "create a task and boot/start its session", make ONE "task:boot" call with the title — never call pty:start or try to type the claude command yourself. Always pass taskId (a number), not ptyId. To message a task that is already running, use "terminal:send".',
  'After acting, report back briefly and conversationally.',
].join(' ')

let manager: VoiceSessionManager | null = null
let session: ClaudeStreamSession | null = null
let firstTurnPending = false

function getManager(): VoiceSessionManager {
  if (!manager) {
    manager = new VoiceSessionManager(path.join(app.getPath('userData'), 'voice-session.json'))
  }
  return manager
}

/**
 * Ensure a live voice Claude session exists. Reuses the running process within a
 * launch; on first use (or relaunch) it starts fresh or resumes the persisted
 * conversation. cwd = ~/.claude so the user's global CLAUDE.md + MEMORY.md +
 * SessionStart hooks load automatically.
 */
export function ensureVoiceSession(owner: WebContents): { sessionId: string; isNew: boolean; warn: boolean } {
  const mgr = getManager()
  // Reuse the live session unless it has spent its turn budget — then rotate to a
  // fresh one so context can't bloat into the endless-"thinking" wedge.
  if (session && session.isAlive() && !mgr.shouldRotate()) {
    session.attachOwner(owner)
    return { sessionId: session.sessionId, isNew: false, warn: mgr.shouldWarnContext() }
  }
  if (session) { session.stop(); session = null }   // rotate (over budget) or dead → drop it
  if (mgr.shouldRotate()) mgr.newConversation()      // mint a fresh id; continuity carries recent context
  const { sessionId, isNew } = mgr.getOrCreate()
  firstTurnPending = isNew // continuity is prepended to the first turn of a fresh conversation
  session = new ClaudeStreamSession({
    ptyId: VOICE_PTY_ID,
    sessionId,
    cwd: VOICE_CWD,
    owner,
    resumeFrom: !isNew,
    onSessionId: (id) => mgr.setSessionId(id),
    model: currentModel(),
    appendSystemPrompt: VOICE_SYSTEM_PROMPT,
    permissionMode: 'bypassPermissions', // hands-free: never stall on a permission prompt
  })
  session.start()
  mgr.markStarted()
  return { sessionId, isNew, warn: mgr.shouldWarnContext() }
}

/** Send a spoken turn to the voice session. On the first turn of a fresh
 *  conversation, silently prepend the voice working-memory (Open Loops).
 *  Returns the turn ordinal the reply will arrive under so the renderer can
 *  discard a prior, barged-in turn's late events instead of speaking them. */
export function sendVoiceText(owner: WebContents, text: string): { ok: boolean; turnOrdinal: number } {
  ensureVoiceSession(owner)
  if (!session) return { ok: false, turnOrdinal: -1 }
  let toSend = text
  if (firstTurnPending) {
    const cont = readVoiceContinuity(CONTINUITY_FILE)
    if (cont.trim()) {
      toSend =
        '[Voice working memory — background context for resolving terse replies; do NOT read this aloud]\n' +
        cont +
        '\n\n---\n\n' +
        text
    }
    firstTurnPending = false
  }
  const turnOrdinal = session.sendUserText(toSend)
  getManager().recordMessage()
  return { ok: true, turnOrdinal }
}

export function newVoiceConversation(): string {
  if (session) {
    session.stop()
    session = null
  }
  firstTurnPending = true
  return getManager().newConversation()
}

/** Manual "Interrupt": kill whatever the voice session is doing right now and
 *  start a clean one. The natural barge-in only cancels the renderer's turn; this
 *  hard-stops the claude process itself (for when it's wedged or mid-runaway).
 *  Recent context is carried forward by the continuity prepend on the next turn. */
export function interruptVoiceSession(): { sessionId: string } {
  return { sessionId: newVoiceConversation() }
}

/** Assistant-mirrored resume-failure recovery: invalidate + start a fresh session. */
export function recoverVoiceSession(owner: WebContents): { sessionId: string } {
  getManager().invalidate()
  if (session) {
    session.stop()
    session = null
  }
  const { sessionId } = ensureVoiceSession(owner)
  return { sessionId }
}

export const VOICE_CONTINUITY_FILE = CONTINUITY_FILE
