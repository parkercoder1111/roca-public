import fs from 'fs'
import { spawn } from 'child_process'
import { getDb, ACTIVE_STATUSES } from '../database'
import type { Task } from '../../shared/types'
import { findClaudeBinarySync } from '../utils/find-claude-binary'

export async function runOrganize(week: string, dryRun: boolean): Promise<any> {
  // Get open tasks
  const db = getDb()
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
  type OrganizerTask = Pick<Task, 'id' | 'title' | 'source' | 'source_id' | 'notes' | 'priority' | 'company_name' | 'deal_name' | 'status'>
  const tasks = db.prepare(
    `SELECT id, title, source, source_id, notes, priority, company_name, deal_name, status
     FROM tasks WHERE week = ? AND status IN (${placeholders}) ORDER BY source, id`
  ).all(week, ...ACTIVE_STATUSES) as OrganizerTask[]

  if (tasks.length < 2) {
    return { actions: [], stats: {} }
  }

  // Build summary — include notes for consolidation context
  const lines = tasks.map((t) => {
    const company = t.company_name ? ` (${t.company_name})` : ''
    const notes = t.notes ? `\n    Notes: ${t.notes.slice(0, 300)}${t.notes.length > 300 ? '...' : ''}` : ''
    return `  #${t.id} [${t.source}] ${t.title}${company}${notes}`
  })

  const prompt = `You are a task organizer for a productivity app called ROCA. Sources:
- manual: user-created tasks (most intentional -- preserve these)
- crm: CRM tasks
- voice_notes: AI-extracted action items from voice-notes meeting transcripts
- meeting_notes: AI-extracted action items from meeting-notes transcripts
- organized: previously organized tasks
- google_tasks, recurring: other synced sources

YOUR JOB: Clean up the task list. You can do THREE things:

1. CLOSE exact duplicates (same task, different wording)
2. CONSOLIDATE related tasks about the same project/company into ONE task with organized notes
3. KEEP tasks that are distinct

CONSOLIDATION is the key feature. When you see 5 meeting-notes-generated tasks all about the same deal (model updates, LOI, diligence, offer letters), consolidate them into ONE task with a clean title and notes organized by workstream. Extract action items from all the fragments into numbered sections in the notes.

TASKS:
${lines.join('\n')}

OUTPUT FORMAT -- respond with ONLY a JSON object:
{
  "actions": [
    {
      "type": "keep",
      "id": 123,
      "new_title": "optional cleaner title or null",
      "reason": "why"
    },
    {
      "type": "close",
      "id": 456,
      "reason": "duplicate of #123"
    },
    {
      "type": "consolidate",
      "close_ids": [456, 789, 101],
      "keep_id": 123,
      "new_title": "Project Name — consolidated task title",
      "new_notes": "Organized notes with numbered workstreams extracted from all closed tasks",
      "reason": "5 related tasks merged into one"
    }
  ]
}

RULES:
1. CONSOLIDATE when 3+ tasks share the same company, deal, or project
2. When consolidating, keep the manual task (or oldest). Close the fragments (meeting_notes/voice_notes).
3. Organize consolidated notes by workstream with numbered sections and bullet points
4. Extract concrete action items from fragment notes into the consolidated notes
5. CLOSE a task if it's a pure duplicate of another
6. Source priority for keeping: manual > crm > organized > meeting_notes > voice_notes
7. Do NOT create brand new tasks -- consolidation always keeps one existing task and closes the rest
8. If tasks look fine, return an empty actions array
9. Be decisive -- a clean task list with 5 clear tasks beats 15 fragments

Output ONLY valid JSON, no markdown fences, no explanation.`

  try {
    const claudeBin = findClaudeBinarySync()
    if (!claudeBin) throw new Error('Claude CLI not found')
    const env: Record<string, string> = { ...process.env as Record<string, string>, CLAUDECODE: '' }
    env.PATH = `/usr/local/bin:${env.PATH || '/usr/bin:/bin'}`

    // Pipe prompt via stdin — avoids arg escaping issues
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn(claudeBin, ['--print'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Organize timed out (120s)')) }, 120000)
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', (code: number) => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`Claude exited ${code}: ${stderr.slice(0, 300)}`))
        else resolve(stdout.trim())
      })
      proc.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
      proc.stdin.write(prompt)
      proc.stdin.end()
    })

    let cleaned = output
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.includes('\n') ? cleaned.split('\n').slice(1).join('\n') : cleaned
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3)
      cleaned = cleaned.trim()
    }

    const plan = JSON.parse(cleaned)
    const actions = plan.actions || []
    const stats = { kept: 0, closed: 0, renamed: 0, consolidated: 0 }
    const tasksById = new Map<number, any>()
    for (const t of tasks) tasksById.set(t.id, t)

    // Apply actions
    for (const action of actions) {
      const actionType = action.type
      if (actionType === 'keep') {
        const task = tasksById.get(action.id)
        if (!task) continue
        const newTitle = action.new_title
        if (!dryRun && newTitle && newTitle !== task.title) {
          db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(newTitle, action.id)
          stats.renamed++
        }
        stats.kept++
      } else if (actionType === 'close') {
        const task = tasksById.get(action.id)
        if (!task) continue
        if (!dryRun) {
          const reason = action.reason || ''
          db.prepare(
            "UPDATE tasks SET status = 'done', completed_at = ?, notes = ? WHERE id = ?"
          ).run(
            new Date().toISOString(),
            `[Dedup: ${reason}]\n${task.notes || ''}`,
            action.id
          )
        }
        stats.closed++
      } else if (actionType === 'consolidate') {
        const keepTask = tasksById.get(action.keep_id)
        if (!keepTask) continue
        const closeIds: number[] = action.close_ids || []
        if (!dryRun) {
          // Update the kept task with consolidated title and notes
          const newTitle = action.new_title || keepTask.title
          const newNotes = action.new_notes || keepTask.notes || ''
          db.prepare('UPDATE tasks SET title = ?, notes = ?, source = ? WHERE id = ?')
            .run(newTitle, newNotes, 'organized', action.keep_id)
          // Close the fragment tasks
          for (const cid of closeIds) {
            const fragTask = tasksById.get(cid)
            if (!fragTask) continue
            db.prepare(
              "UPDATE tasks SET status = 'done', completed_at = ?, notes = ? WHERE id = ?"
            ).run(
              new Date().toISOString(),
              `[Consolidated into #${action.keep_id}]\n${fragTask.notes || ''}`,
              cid
            )
          }
        }
        stats.consolidated++
        stats.closed += closeIds.length
      }
    }

    return { actions, stats }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e)
    console.error('[organizer] Error:', errMsg)
    // Write debug log for diagnosis
    try {
      fs.writeFileSync('/tmp/roca-organize-error.log',
        `${new Date().toISOString()}\n${errMsg}\n${e instanceof Error ? (e.stack || '') : ''}\n`)
    } catch { /* ignore */ }
    return { actions: [], stats: {}, error: errMsg }
  }
}
