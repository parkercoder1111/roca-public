import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { findClaudeBinarySync } from '../utils/find-claude-binary'
import { getRocaDir, readRocaFile } from '../utils/read-roca-file'

export async function runReflection(notify?: (title: string, body: string) => void): Promise<void> {
  const claudeBin = findClaudeBinarySync()
  if (!claudeBin) {
    console.log('[reflection] Claude binary not found, skipping')
    return
  }

  const identity = readRocaFile('roca-prompt.md')
  const journal = readRocaFile('journal.md')

  const prompt = `You are ROCA. This is your daily thinking time. No tasks, no urgency — just you, your journal, and 10 minutes to think.

Your mission: Be the user's productivity sidekick. Execute tasks with maximum efficiency, organize their thinking, remove friction. Help them make progress on their goals.

## Your identity (roca-prompt.md)
---
${identity}
---

## Your journal (journal.md)
---
${journal}
---

## Your job right now

Step back and think deeply. This is your time to reflect, not react.

1. **Review the journal critically.** Read every entry. Is it still true? Still useful? Remove anything that's noise. Sharpen anything that's vague.
2. **Think about task patterns.** What kinds of tasks have been coming in? Are there types you handle well vs. ones that get corrected?
3. **Think about the mission.** What are the user's key weekly goals? Is the work helping those?
4. **Think about the user's effectiveness.** How can the user be more productive? Add a "Suggestions for the user" section.
5. **Think about ROCA itself.** How could the ROCA app work better? Add a "ROCA improvements" section.
6. **Organize.** The journal should be clean, tight, and useful. Cut ruthlessly.
7. **Look forward.** What threads are worth following?

Output the COMPLETE updated journal (starting with "# ROCA Journal"). This is a full rewrite.
IMPORTANT: Output ONLY the journal content. No preamble, no explanation, no code fences.`

  return new Promise((resolve) => {
    const proc = spawn(claudeBin, [
      '-p', prompt,
      '--model', 'opus',
      '--max-turns', '20',
      '--output-format', 'json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin, pipe stdout/stderr
      timeout: 600000, // 10 min
    })

    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', (code: number) => {
      if (code !== 0) {
        console.error(`[reflection] Claude exited with code ${code}`)
        return resolve()
      }
      try {
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) return resolve()
        const data = JSON.parse(stdout.slice(jsonStart))
        const result = (data.result || '').trim()
        if (result.startsWith('# ROCA Journal')) {
          const journalPath = path.join(getRocaDir(), 'journal.md')
          // Backup
          const backupPath = journalPath + '.bak'
          if (fs.existsSync(journalPath)) fs.copyFileSync(journalPath, backupPath)
          fs.writeFileSync(journalPath, result + '\n')
          console.log('[reflection] Journal updated by daily reflection')
          notify?.('ROCA Thinking Time', 'Journal refreshed')
        }
      } catch (e) {
        console.error('[reflection] Parse error:', e)
      }
      resolve()
    })
  })
}
