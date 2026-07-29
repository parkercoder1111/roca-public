import { describe, it, expect } from 'vitest'
import { taskIdFromParams, pickPtyIdForTask } from './pty-id'

describe('taskIdFromParams', () => {
  it('takes an explicit taskId (string or number)', () => {
    expect(taskIdFromParams({ taskId: '1855' })).toBe('1855')
    expect(taskIdFromParams({ taskId: 1855 })).toBe('1855')
  })
  it('derives the task id from a bare ptyId', () => {
    expect(taskIdFromParams({ ptyId: 'task-1855' })).toBe('1855')
  })
  it('derives the task id from a suffixed ptyId (the real UI pty name)', () => {
    expect(taskIdFromParams({ ptyId: 'task-1855-mrjqvs8i' })).toBe('1855')
  })
  it('prefers taskId over ptyId when both are present', () => {
    expect(taskIdFromParams({ taskId: '42', ptyId: 'task-1855-abc' })).toBe('42')
  })
  it('handles the assistant pty', () => {
    expect(taskIdFromParams({ ptyId: 'task-assistant-mq8jhdb9' })).toBe('assistant-mq8jhdb9')
  })
  it('returns null when nothing usable is present', () => {
    expect(taskIdFromParams({})).toBeNull()
    expect(taskIdFromParams(null)).toBeNull()
    expect(taskIdFromParams({ taskId: '   ' })).toBeNull()
  })
})

describe('pickPtyIdForTask', () => {
  it('returns null when the task has no live pty', () => {
    expect(pickPtyIdForTask('1855', [{ id: 'task-1856-a', spawnedAt: 1 }])).toBeNull()
  })
  it('prefers an exact task-<id> match', () => {
    const ptys = [
      { id: 'task-1855', spawnedAt: 1 },
      { id: 'task-1855-newer', spawnedAt: 99 },
    ]
    expect(pickPtyIdForTask('1855', ptys)).toBe('task-1855')
  })
  it('resolves a suffixed tab when no exact pty exists', () => {
    expect(pickPtyIdForTask('1855', [{ id: 'task-1855-mrjqvs8i', spawnedAt: 5 }]))
      .toBe('task-1855-mrjqvs8i')
  })
  it('picks the most-recently-spawned tab among several', () => {
    const ptys = [
      { id: 'task-1855-old', spawnedAt: 10 },
      { id: 'task-1855-new', spawnedAt: 50 },
      { id: 'task-1855-mid', spawnedAt: 30 },
    ]
    expect(pickPtyIdForTask('1855', ptys)).toBe('task-1855-new')
  })
  it('does not cross-match a different task whose id shares a prefix', () => {
    // task 185 must not match task 1855's ptys
    expect(pickPtyIdForTask('185', [{ id: 'task-1855-x', spawnedAt: 1 }])).toBeNull()
  })
})
