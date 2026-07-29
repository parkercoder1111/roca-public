import { describe, it, expect } from 'vitest'
import { tabPtyId } from './pty-id'

describe('tabPtyId', () => {
  it('appends the active tab suffix — a real tab has its own pane', () => {
    // Regression: fork/mirror "current" built `task-<id>` with no suffix, so it
    // looked up a pty that was never spawned and failed with
    // "No live session for that pane." Every tab (incl. "Tab 1") carries a
    // base36 id, so the live pane is always `task-<id>-<tabId>`.
    expect(tabPtyId('task-42', 'mrjqvs8i')).toBe('task-42-mrjqvs8i')
    expect(tabPtyId('task-assistant', 'abc123')).toBe('task-assistant-abc123')
  })

  it('maps the legacy empty tab id to the bare base pane', () => {
    expect(tabPtyId('task-42', '')).toBe('task-42')
    expect(tabPtyId('task-assistant', '')).toBe('task-assistant')
  })

  it('honors a mirror tab\'s own pty — mirror tabs attach to the source, no pane of their own', () => {
    expect(tabPtyId('task-42', 'mirrortab', 'task-9-xyz')).toBe('task-9-xyz')
    expect(tabPtyId('task-42', '', 'task-9-xyz')).toBe('task-9-xyz')
  })
})
