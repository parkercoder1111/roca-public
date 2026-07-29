/**
 * Claude headless runner — extracted from delegate.ts to keep that file manageable.
 * Provides runClaudeHeadless() for spawning Claude CLI in JSON output mode.
 */

import { app } from 'electron'
import path from 'path'
import { spawn } from 'child_process'

// ── Claude headless config — aligned with Slack Bot workflow pattern ─────────
export const CLAUDE_MODEL = 'sonnet'
export const CLAUDE_MAX_TURNS_ANALYSIS = 20
export const CLAUDE_MAX_TURNS_EXECUTE = 50
export const CLAUDE_TIMEOUT_ANALYSIS = 300_000   // 5 min (ms)
export const CLAUDE_TIMEOUT_EXECUTE = 1_200_000  // 20 min (ms)

// ── Result type ───────────────────────────────────────────────────────────────
export interface ClaudeRunResult {
  plan: string
  cost: number
  turns: number
  error: string | null
  sessionId: string | null
}

// ── Default cwd helper ────────────────────────────────────────────────────────
function defaultCwd(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath)
    : path.join(__dirname, '../..')
}

/**
 * Run Claude CLI headless with the given prompt and options.
 * Uses child_process.spawn to avoid blocking the main thread.
 * Returns parsed result from JSON output.
 */
export function runClaudeHeadless(opts: {
  claudeBin: string
  prompt: string
  model?: string
  maxTurns?: number
  timeout?: number
  allowedTools?: string
  sessionId?: string
  resumeSessionId?: string
  cwd?: string
}): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const {
      claudeBin, prompt,
      model = CLAUDE_MODEL,
      maxTurns = CLAUDE_MAX_TURNS_ANALYSIS,
      timeout = CLAUDE_TIMEOUT_ANALYSIS,
      allowedTools = 'Read,Glob,Grep,Bash,WebSearch,WebFetch',
      sessionId,
      resumeSessionId,
      cwd = defaultCwd(),
    } = opts

    const args = [
      '-p', prompt,
      '--model', model,
      '--max-turns', String(maxTurns),
      '--output-format', 'json',
    ]

    if (allowedTools) {
      args.push('--allowedTools', allowedTools)
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
    } else if (sessionId) {
      args.push('--session-id', sessionId)
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    delete env.CLAUDECODE // Allow nested invocation (Slack Bot pattern)
    // Ensure Claude and node are on PATH
    env.PATH = `/usr/local/bin:/opt/homebrew/bin:${env.PATH || '/usr/bin:/bin'}`

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const proc = spawn(claudeBin, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      // Give it a second to clean up, then force kill
      setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
      }, 2000)
    }, timeout)

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timer)

      if (timedOut) {
        resolve({
          plan: '',
          cost: 0,
          turns: 0,
          error: `Timed out after ${Math.round(timeout / 1000)}s`,
          sessionId: sessionId ?? null,
        })
        return
      }

      if (code !== 0) {
        const errTail = stderr.slice(-500)
        resolve({
          plan: '',
          cost: 0,
          turns: 0,
          error: `Claude exit ${code}: ${errTail}`,
          sessionId: null,
        })
        return
      }

      const output = stdout.trim()
      const jsonStart = output.indexOf('{')
      if (jsonStart === -1) {
        // Plain text output — use as plan
        resolve({
          plan: output.slice(0, 8000) || 'No response.',
          cost: 0,
          turns: 0,
          error: null,
          sessionId: sessionId ?? null,
        })
        return
      }

      try {
        const data = JSON.parse(output.slice(jsonStart))
        resolve({
          plan: data.result ?? '',
          cost: data.total_cost_usd ?? 0,
          turns: data.num_turns ?? 0,
          error: null,
          sessionId: data.session_id ?? sessionId ?? null,
        })
      } catch {
        // JSON parse failed — return raw text
        resolve({
          plan: output.slice(0, 8000),
          cost: 0,
          turns: 0,
          error: 'JSON parse error',
          sessionId: sessionId ?? null,
        })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        plan: '',
        cost: 0,
        turns: 0,
        error: `Spawn error: ${err.message}`,
        sessionId: null,
      })
    })
  })
}
