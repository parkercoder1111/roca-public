// Pure voice command parser — no React, no side effects, fully unit-testable.

export type VoiceCommand =
  | { type: 'navigate-task'; query: string }
  | { type: 'complete-task' }
  | { type: 'new-task' }
  | { type: 'start-agent'; name: string }
  | { type: 'stop-agent'; name: string }
  | { type: 'pass-through'; text: string }

export function parseVoiceCommand(transcript: string): VoiceCommand {
  const t = transcript.trim().toLowerCase()

  // ── Navigate task ──────────────────────────────────────────────────────────
  // "open task 5", "go to task 5", "task 5", "task something something"
  const navMatch = t.match(/^(?:open\s+task|go\s+to\s+task|task)\s+(.+)$/)
  if (navMatch) {
    return { type: 'navigate-task', query: navMatch[1].trim() }
  }

  // ── Complete task ──────────────────────────────────────────────────────────
  if (/^(?:mark\s+(?:as\s+)?done|complete\s+task|mark\s+done|check\s+off)$/.test(t)) {
    return { type: 'complete-task' }
  }

  // ── New task ───────────────────────────────────────────────────────────────
  if (/^(?:new\s+task|create\s+task|add\s+task)$/.test(t)) {
    return { type: 'new-task' }
  }

  // ── Start agent ────────────────────────────────────────────────────────────
  const startMatch = t.match(/^(?:start|run)\s+agent\s+(.+)$/)
  if (startMatch) {
    return { type: 'start-agent', name: startMatch[1].trim() }
  }

  // ── Stop agent ─────────────────────────────────────────────────────────────
  const stopMatch = t.match(/^(?:stop|pause)\s+agent\s+(.+)$/)
  if (stopMatch) {
    return { type: 'stop-agent', name: stopMatch[1].trim() }
  }

  // ── Pass-through ───────────────────────────────────────────────────────────
  return { type: 'pass-through', text: transcript.trim() }
}
