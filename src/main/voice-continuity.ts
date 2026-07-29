import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// Keep only this many recent exchanges. The file is prepended to a fresh
// session's first turn, so it must stay small — left unbounded it grew to 67KB.
const DEFAULT_MAX_LINES = 60

/** Read the voice assistant's own working-memory file. Empty string if missing.
 *  This is a DEDICATED file — separate from Assistant's continuity. */
export function readVoiceContinuity(filePath: string): string {
  if (!existsSync(filePath)) return ''
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** Append one compact line: "- <ISO> You: <user> → ROCA: <reply>"
 *  (same shape as Assistant append_continuity, but its own file). The file is
 *  capped to a rolling window of the most recent `maxLines` exchanges so it can
 *  never grow unbounded. Fully defensive. */
export function appendVoiceExchange(filePath: string, userText: string, replyText: string, at: Date, maxLines: number = DEFAULT_MAX_LINES): void {
  try {
    const u = userText.replace(/\s+/g, ' ').trim().slice(0, 180)
    const r = replyText.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!u && !r) return
    const stamp = at.toISOString().slice(0, 16).replace('T', ' ') + 'Z'
    const line = `- ${stamp} You: ${u} → ROCA: ${r}`
    let lines = existsSync(filePath) ? readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim()) : []
    lines.push(line)
    if (lines.length > maxLines) lines = lines.slice(-maxLines)
    writeFileSync(filePath, lines.join('\n') + '\n')
  } catch {
    /* non-fatal */
  }
}
