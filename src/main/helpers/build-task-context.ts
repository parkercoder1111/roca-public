import path from 'path'
import { getUploadsForTask, getCachedDelegate, getDelegateMessages, getTaskSessions } from '../database'
import { getActiveWindowFilePath } from '../active-window'
import { getActiveContextFilePath } from '../active-context'
import { readRocaFile } from '../utils/read-roca-file'
import { getUploadDir } from '../utils/get-upload-dir'
import { matchSkillForTask } from './match-skill-for-task'

/**
 * Build task-specific context markdown.
 * Includes: task details, CRM enrichment, matched skill, delegate history,
 * and previous session summaries for conversation continuity.
 */
export function buildTaskContext(task: any, taskId: number, enrichmentSummary?: string): string {
  let md = ''

  // ROCA identity — injected so every session understands it's running inside ROCA
  const rocaPrompt = readRocaFile('roca-prompt.md')
  if (rocaPrompt) {
    md += `${rocaPrompt}\n\n---\n\n`
  }

  // Task details
  md += `# Current Task: ${task.title}\n\n`
  md += `**Status:** ${task.status} | **Priority:** ${task.priority} | **Source:** ${task.source}\n`
  if (task.company_name) md += `**Company:** ${task.company_name}\n`
  if (task.deal_name) md += `**Deal:** ${task.deal_name}\n`
  if (task.due_date) md += `**Due:** ${task.due_date}\n`
  md += `\n---\n\n`

  // Active window awareness — tell Claude where to find what the user is looking at
  md += `## Active Window\n\n`
  md += `The user's currently focused app/window is tracked at:\n`
  md += `\`${getActiveWindowFilePath()}\`\n\n`
  md += `Read this file when you need to know what the user is looking at (browser tab, spreadsheet, document, etc.). `
  md += `It updates every few seconds and contains the app name, window title, and URL (for browsers).\n\n`

  if (task.notes) {
    // Resolve relative /uploads/ paths in notes to absolute paths so Claude can read them
    const uploadsDir = getUploadDir()
    const resolvedNotes = task.notes.replace(
      /\(\/uploads\/([^)]+)\)/g,
      (_match: string, filename: string) => `(${path.join(uploadsDir, filename)})`
    )
    md += `## Notes\n\n${resolvedNotes}\n\n`
  }

  // Uploaded files — expose absolute paths so the terminal session can read them
  const uploads = getUploadsForTask(taskId)
  if (uploads.length > 0) {
    const uploadsDir = getUploadDir()
    md += `## Uploaded Files\n\n`
    md += `These files have been attached to this task. Use the absolute paths below to read or reference them.\n\n`
    for (const u of uploads) {
      const absPath = path.join(uploadsDir, u.stored_name)
      md += `- \`${absPath}\` — ${u.filename} (${u.mime_type}, ${(u.size / 1024).toFixed(1)} KB)\n`
    }
    md += `\n`
  }

  // CRM enrichment (company, person, deal, meetings from CRM)
  if (enrichmentSummary) {
    md += `## CRM Context\n\n${enrichmentSummary}\n\n---\n\n`
  }

  // Matched skill
  const skill = matchSkillForTask(task)
  if (skill) {
    md += `## Matched Skill: ${skill.name}\n\n${skill.content}\n\n---\n\n`
  }

  // Delegate analysis (from previous sessions)
  const cached = getCachedDelegate(taskId)
  if (cached?.plan) md += `## Analysis\n\n${cached.plan}\n\n`

  // Previous session history — most recent summaries for conversation continuity
  const sessions = getTaskSessions(taskId, 5)
  const sessionsWithSummary = sessions.filter(s => s.summary).reverse() // chronological
  if (sessionsWithSummary.length > 0) {
    md += `## Previous Sessions\n\n`
    for (const s of sessionsWithSummary) {
      const date = new Date(s.started_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
      md += `### Session (${date})\n\n${s.summary}\n\n`
    }
    md += `---\n\n`
  }

  // Conversation history (delegate messages)
  const msgs = getDelegateMessages(taskId)
  if (msgs && msgs.length > 0) {
    md += `## Conversation History\n\n`
    for (const m of msgs.slice(-20)) {
      md += `**${m.role === 'user' ? 'User' : 'ROCA'}:** ${m.content}\n\n`
    }
  }

  return md
}

/**
 * Build assistant context markdown (desktop-control-focused, no task).
 * Includes ROCA identity, desktop control capabilities, journal, and priorities.
 */
export function buildAssistantContext(): string {
  let md = ''

  const rocaPrompt = readRocaFile('roca-prompt.md')
  if (rocaPrompt) {
    md += `${rocaPrompt}\n\n---\n\n`
  }

  md += `# ROCA Assistant — Desktop Control Mode\n\n`
  md += `You are the user's hands-on desktop assistant running inside the ROCA app. You have full control over their Mac.\n\n`
  md += `## Capabilities\n\n`
  md += `- **AppleScript / osascript**: Control any macOS app (Maps, Calendar, Finder, Safari, etc.)\n`
  md += `- **Shell commands**: Full terminal access — run scripts, manage files, query APIs\n`
  md += `- **Application control**: Open, close, switch between apps via \`open -a\` or AppleScript\n`
  md += `- **System info**: Date/time, disk usage, network, running processes\n`
  md += `- **File operations**: Read, write, move, search files anywhere on the system\n`
  md += `- **Web browsing**: Use \`open\` to launch URLs, or curl for API calls\n`
  md += `- **Clipboard**: Read/write clipboard via \`pbcopy\`/\`pbpaste\`\n`
  md += `- **Active window**: Read \`${getActiveWindowFilePath()}\` to see what the user is currently looking at (app, window title, browser URL)\n`
  md += `- **Active ROCA context**: Read \`${getActiveContextFilePath()}\` to see what the user is currently viewing inside ROCA itself — current tab (email/week/filepath/slack), the open email thread (subject, sender, recipients, message excerpt), open file, or open Slack channel/thread. Check this file FIRST when the user says "this email", "this thread", "draft me a reply", "summarize this", or otherwise refers to what's in front of them in ROCA.\n\n`
  md += `When the user asks you to do something on their computer, just do it. Use the tools available — don't ask for confirmation on routine operations.\n\n`
  md += `---\n\n`

  const journal = readRocaFile('journal.md')
  if (journal) {
    md += `## Journal\n\n${journal}\n\n---\n\n`
  }

  const priorities = readRocaFile('priorities.md')
  if (priorities) {
    md += `## Current Priorities\n\n${priorities}\n\n`
  }

  return md
}
