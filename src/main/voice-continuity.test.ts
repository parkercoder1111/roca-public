import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readVoiceContinuity, appendVoiceExchange } from './voice-continuity'

let file: string
beforeEach(() => {
  file = path.join(mkdtempSync(path.join(tmpdir(), 'vc-')), 'voice-continuity.md')
})

describe('voice-continuity', () => {
  it('returns empty string when the file does not exist', () => {
    expect(readVoiceContinuity(file)).toBe('')
  })

  it('appends a compact one-line record and reads it back', () => {
    appendVoiceExchange(file, 'when does the project ship', 'early August', new Date('2026-07-06T12:00:00Z'))
    const txt = readVoiceContinuity(file)
    expect(txt).toContain('2026-07-06')
    expect(txt).toContain('when does the project ship')
    expect(txt).toContain('early August')
  })

  it('truncates very long text', () => {
    appendVoiceExchange(file, 'x'.repeat(500), 'y'.repeat(500), new Date())
    const line = readVoiceContinuity(file).trim()
    expect(line.length).toBeLessThan(500)
  })

  it('caps the file to a rolling window of the most recent exchanges', () => {
    for (let i = 0; i < 80; i++) {
      appendVoiceExchange(file, `q${i}`, `a${i}`, new Date('2026-07-06T12:00:00Z'), 20)
    }
    const lines = readVoiceContinuity(file).trim().split('\n')
    expect(lines).toHaveLength(20)                     // never grows past the cap
    expect(lines[0]).toContain('q60')                  // oldest kept
    expect(lines[lines.length - 1]).toContain('q79')   // newest
    expect(readVoiceContinuity(file)).not.toContain('You: q0 ') // early exchanges dropped
  })
})
