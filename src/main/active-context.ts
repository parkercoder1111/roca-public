import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * Persists what the user is currently looking at inside ROCA to disk so the
 * ROCA Assistant (Claude Code running in a PTY) can read it on demand.
 *
 * File: {userData}/active-context.json — typically
 *       ~/Library/Application Support/ROCA/active-context.json
 */
export interface ActiveContext {
  updatedAt: string
  tab: 'email' | 'week' | 'notes' | 'filepath' | 'slack' | 'scribe' | null
  email?: {
    threadId: string
    subject: string
    from: string
    to: string
    messageCount: number
    // Plain-text excerpt of the most recent message (capped)
    latestMessageText: string
  }
  file?: {
    path: string
  }
  slack?: {
    channelId: string
    channelName?: string
    threadTs?: string
  }
}

let cachedPath: string | null = null

function contextPath(): string {
  if (!cachedPath) {
    cachedPath = path.join(app.getPath('userData'), 'active-context.json')
  }
  return cachedPath
}

/**
 * Absolute path to the active-context file — exposed so the Assistant's
 * system prompt can tell Claude exactly where to look.
 */
export function getActiveContextFilePath(): string {
  return contextPath()
}

/**
 * Removes the active-context file — used by Safe reload to break crash loops
 * caused by a bad entry in active-context.json. Missing file is not an error.
 */
export function clearActiveContext(): void {
  try {
    fs.rmSync(contextPath(), { force: true })
  } catch (e) {
    console.error('[active-context] clear failed:', e)
  }
}

export function writeActiveContext(ctx: Partial<ActiveContext>): void {
  const payload: ActiveContext = {
    updatedAt: new Date().toISOString(),
    tab: ctx.tab ?? null,
    ...(ctx.email ? { email: ctx.email } : {}),
    ...(ctx.file ? { file: ctx.file } : {}),
    ...(ctx.slack ? { slack: ctx.slack } : {}),
  }
  try {
    fs.writeFileSync(contextPath(), JSON.stringify(payload, null, 2))
  } catch (e) {
    console.error('[active-context] write failed:', e)
  }
}
