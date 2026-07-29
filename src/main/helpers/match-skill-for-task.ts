import path from 'path'
import fs from 'fs'
import { getSkillsDir } from '../utils/read-roca-file'

/**
 * Match a task to the best ROCA skill file based on the journal's pattern table.
 * Returns the skill content or empty string if no match.
 */
export function matchSkillForTask(task: { title: string; notes?: string | null }): { name: string; content: string } | null {
  const text = `${task.title} ${task.notes || ''}`.toLowerCase()
  const skillsDir = getSkillsDir()
  if (!fs.existsSync(skillsDir)) return null

  // Pattern keywords → skill filename (from journal.md pattern table).
  // This is example config — customize the keyword→skill mapping to match
  // whatever skill files live in your skills directory.
  const patterns: [string[], string][] = [
    [['follow-up', 'followup'], 'email-followup'],
    [['cold email', 'first touch', 'outreach'], 'email-outreach'],
    [['reply', 'respond', 'draft email'], 'email-reply'],
    [['spreadsheet', 'google sheet', 'sheet update', 'tracker'], 'sheets-update'],
    [['how many', 'metrics', 'report', 'summary'], 'data-query'],
    [['research', 'look up', 'find info'], 'research-topic'],
    [['remind me', 'set reminder'], 'set-reminder'],
    [['meeting brief', 'prep for meeting', 'prep for call'], 'meeting-prep'],
  ]

  for (const [keywords, skillName] of patterns) {
    if (keywords.some(kw => text.includes(kw))) {
      const skillPath = path.join(skillsDir, `${skillName}.md`)
      if (fs.existsSync(skillPath)) {
        return { name: skillName, content: fs.readFileSync(skillPath, 'utf-8') }
      }
    }
  }
  return null
}
