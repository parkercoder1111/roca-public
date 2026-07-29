import { execFile } from 'child_process'
import { findClaudeBinarySync } from '../utils/find-claude-binary'

/**
 * Generate a concise session summary by running Claude headless.
 * Returns the summary text, or null on failure.
 */
export async function generateSessionSummary(transcript: string, taskTitle: string): Promise<string | null> {
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  // Truncate to keep the prompt reasonable
  const truncated = transcript.slice(-30000)

  const prompt = `You are summarizing a Claude Code terminal session for future context.

TASK: ${taskTitle}

TERMINAL TRANSCRIPT (most recent portion):
${truncated}

Produce a concise summary (3-8 bullet points) of:
1. What was discussed/requested
2. What actions were taken (files changed, commands run, API calls made)
3. What was accomplished or left unfinished
4. Any decisions or preferences the user expressed

Be factual and specific. Use past tense. Output ONLY the bullet points, no preamble.`

  try {
    const claudeBin = findClaudeBinarySync()
    if (!claudeBin) throw new Error('Claude CLI not found')
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    env.PATH = `/usr/local/bin:${env.PATH || '/usr/bin:/bin'}`

    const { stdout } = await execFileAsync(claudeBin, ['--print', '-p', prompt], {
      timeout: 60000,
      env,
    })
    return stdout.trim() || null
  } catch (e) {
    console.error('[session-summary] Failed to generate summary:', e)
    return null
  }
}
