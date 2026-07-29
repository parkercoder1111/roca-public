import { spawn } from 'child_process'
import { getDb } from '../database'
import { findClaudeBinarySync } from '../utils/find-claude-binary'
import { readRocaFile } from '../utils/read-roca-file'

export async function runProactive(
  mode: 'morning' | 'afternoon',
  notify?: (title: string, body: string) => void,
): Promise<void> {
  const claudeBin = findClaudeBinarySync()
  if (!claudeBin) return

  const proactivePrompt = readRocaFile('proactive-prompt.md')
  const priorities = readRocaFile('priorities.md')

  // Gather active tasks
  const db = getDb()
  const activeTasks = db.prepare(
    `SELECT id, title, status, priority, due_date, company_name, deal_name, source, week, created_at, notes
     FROM tasks WHERE status IN ('needs_input','draft_ready','open','waiting','blocked','in_progress')
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
     due_date`
  ).all()

  const completedToday = db.prepare(
    `SELECT id, title, company_name, completed_at FROM tasks
     WHERE status = 'done' AND completed_at >= date('now') AND merged_into_task_id IS NULL
     ORDER BY completed_at DESC`
  ).all()

  const prompt = `${proactivePrompt}

---

## Current Mode: ${mode}
**Time**: ${new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}

## Active ROCA Tasks
\`\`\`json
${JSON.stringify(activeTasks, null, 2)}
\`\`\`

## Completed Today
\`\`\`json
${JSON.stringify(completedToday, null, 2)}
\`\`\`

## Current Priorities
${priorities}

---

Now generate the briefing for the ${mode} mode. Output ONLY the message text.`

  return new Promise((resolve) => {
    const proc = spawn(claudeBin, [
      '-p', prompt,
      '--model', 'sonnet',
      '--max-turns', '3',
      '--output-format', 'json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin, pipe stdout/stderr
      timeout: 300000, // 5 min
    })

    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', (code: number) => {
      if (code !== 0) {
        console.error(`[proactive] Claude exited with code ${code}`)
        return resolve()
      }
      try {
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) return resolve()
        const data = JSON.parse(stdout.slice(jsonStart))
        const result = (data.result || '').trim()
        if (result) {
          console.log(`[proactive] ${mode} briefing generated (${result.length} chars)`)
          notify?.(`ROCA ${mode} Briefing`, result.slice(0, 200))
        }
      } catch (e) {
        console.error('[proactive] Parse error:', e)
      }
      resolve()
    })
  })
}
