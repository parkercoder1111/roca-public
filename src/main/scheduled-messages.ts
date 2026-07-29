// src/main/scheduled-messages.ts
//
// "Send this message later" for the optical chat view. Schedules persist to
// disk so an app restart re-arms them. Delivery goes through the same path a
// live chat send does: the claude-stream session if one is open, else typed
// straight into the task's PTY.
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { sendClaudeUserText } from './claude-stream-manager'
import type { PtyManager } from './pty-manager'

export interface ScheduledMessage {
  id: string
  ptyId: string
  text: string
  sendAtMs: number
}

const timers = new Map<string, NodeJS.Timeout>()
let items: ScheduledMessage[] = []
let storePath = ''
let ptyManager: PtyManager | null = null

function persist(): void {
  try {
    fs.writeFileSync(storePath, JSON.stringify(items, null, 2))
  } catch (err) {
    console.error('[ScheduledMessages] persist failed:', err)
  }
}

function fire(item: ScheduledMessage): void {
  timers.delete(item.id)
  items = items.filter((i) => i.id !== item.id)
  persist()
  if (sendClaudeUserText(item.ptyId, item.text)) {
    console.log(`[ScheduledMessages] sent via claude-stream: ${item.id}`)
    return
  }
  if (ptyManager?.has(item.ptyId)) {
    ptyManager.write(item.ptyId, item.text + '\r')
    console.log(`[ScheduledMessages] sent via pty: ${item.id}`)
    return
  }
  console.warn(`[ScheduledMessages] dropped ${item.id} — no live session or pty for ${item.ptyId}`)
}

function arm(item: ScheduledMessage): void {
  const delay = Math.max(0, item.sendAtMs - Date.now())
  // setTimeout overflows past ~24.8 days; far-future items re-arm on restart.
  timers.set(item.id, setTimeout(() => fire(item), Math.min(delay, 2 ** 31 - 1)))
}

export function initScheduledMessages(pm: PtyManager): void {
  ptyManager = pm
  storePath = path.join(app.getPath('userData'), 'scheduled-messages.json')
  try {
    items = JSON.parse(fs.readFileSync(storePath, 'utf8'))
  } catch {
    items = []
  }
  for (const item of items) arm(item)
  if (items.length) console.log(`[ScheduledMessages] re-armed ${items.length} pending`)
}

export function createScheduledMessage(ptyId: string, text: string, sendAtMs: number): ScheduledMessage {
  const item: ScheduledMessage = { id: randomUUID(), ptyId, text, sendAtMs }
  items.push(item)
  persist()
  arm(item)
  return item
}

export function listScheduledMessages(ptyId: string): ScheduledMessage[] {
  return items.filter((i) => i.ptyId === ptyId).sort((a, b) => a.sendAtMs - b.sendAtMs)
}

export function cancelScheduledMessage(id: string): boolean {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  const before = items.length
  items = items.filter((i) => i.id !== id)
  persist()
  return items.length < before
}
