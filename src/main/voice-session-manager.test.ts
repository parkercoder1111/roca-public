import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { VoiceSessionManager } from './voice-session-manager'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'voice-'))
  file = path.join(dir, 'voice-session.json')
})

describe('VoiceSessionManager', () => {
  it('first getOrCreate is new; after markStarted the same id resumes', () => {
    const m = new VoiceSessionManager(file)
    const a = m.getOrCreate()
    expect(a.isNew).toBe(true)
    m.markStarted()
    const b = m.getOrCreate()
    expect(b.isNew).toBe(false)
    expect(b.sessionId).toBe(a.sessionId)
  })

  it('persists a started session across instances (resumes ongoing conversation)', () => {
    const m1 = new VoiceSessionManager(file)
    const first = m1.getOrCreate()
    m1.markStarted()
    const second = new VoiceSessionManager(file).getOrCreate()
    expect(second.isNew).toBe(false)
    expect(second.sessionId).toBe(first.sessionId)
    expect(existsSync(file)).toBe(true)
  })

  it('newConversation makes a different, not-yet-started id (isNew=true)', () => {
    const m = new VoiceSessionManager(file)
    const first = m.getOrCreate().sessionId
    m.markStarted()
    const fresh = m.newConversation()
    expect(fresh).not.toBe(first)
    expect(m.getOrCreate()).toEqual({ sessionId: fresh, isNew: true })
  })

  it('invalidate forces the next getOrCreate to be new with a different id', () => {
    const m = new VoiceSessionManager(file)
    const first = m.getOrCreate().sessionId
    m.markStarted()
    m.invalidate()
    const next = m.getOrCreate()
    expect(next.isNew).toBe(true)
    expect(next.sessionId).not.toBe(first)
  })

  it('setSessionId adopts the forked uuid and keeps it resumable', () => {
    const m = new VoiceSessionManager(file)
    m.getOrCreate()
    m.markStarted()
    m.setSessionId('forked-123')
    expect(m.getOrCreate()).toEqual({ sessionId: 'forked-123', isNew: false })
  })

  it('warns after the configured message count', () => {
    const m = new VoiceSessionManager(file, { warnAfter: 2 })
    m.getOrCreate()
    expect(m.shouldWarnContext()).toBe(false)
    m.recordMessage(); m.recordMessage()
    expect(m.shouldWarnContext()).toBe(true)
  })

  // ── Auto-rotation: a long-running or stale conversation is replaced with a
  //    fresh session instead of resumed forever (the context bloat that wedged
  //    voice mode into an endless "thinking" loop). ──

  it('shouldRotate flips once the turn budget is reached', () => {
    const m = new VoiceSessionManager(file, { rotateAfter: 3 })
    m.getOrCreate(); m.markStarted()
    m.recordMessage(); m.recordMessage()
    expect(m.shouldRotate()).toBe(false)
    m.recordMessage()
    expect(m.shouldRotate()).toBe(true)
  })

  it('getOrCreate starts a fresh session once over the turn budget (no endless resume)', () => {
    const m = new VoiceSessionManager(file, { rotateAfter: 2 })
    const first = m.getOrCreate().sessionId
    m.markStarted()
    m.recordMessage(); m.recordMessage()          // hit the budget
    const next = m.getOrCreate()
    expect(next.isNew).toBe(true)
    expect(next.sessionId).not.toBe(first)
    expect(m.shouldRotate()).toBe(false)          // fresh record resets the count
  })

  it('getOrCreate starts fresh when the persisted session is stale', () => {
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() // 5h ago
    writeFileSync(file, JSON.stringify({ sessionId: 'stale-1', started: true, created: old, lastActive: old, messageCount: 3 }))
    const m = new VoiceSessionManager(file, { staleMs: 60 * 60 * 1000 }) // 1h staleness
    const next = m.getOrCreate()
    expect(next.isNew).toBe(true)
    expect(next.sessionId).not.toBe('stale-1')
  })

  it('getOrCreate still resumes a recent, in-budget session', () => {
    const m = new VoiceSessionManager(file, { rotateAfter: 20, staleMs: 60 * 60 * 1000 })
    const first = m.getOrCreate().sessionId
    m.markStarted()
    m.recordMessage()
    const next = m.getOrCreate()
    expect(next.isNew).toBe(false)
    expect(next.sessionId).toBe(first)
  })
})
