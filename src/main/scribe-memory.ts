// Flow each meeting into memory as a per-meeting note.
// Writes a per-meeting markdown file to ~/.claude/memory/scribe/notes/ plus a
// by-day pointer. These files are untracked, so they survive a Mac-side
// `git reset --hard` that only reverts tracked files, and can ride any
// file-sync you configure to a remote host. A downstream summary cron + a
// SessionStart hook can then inject/distill them.
import fs from 'fs'
import os from 'os'
import path from 'path'

const MEMORY_DIR = process.env.SCRIBE_MEMORY_DIR || path.join(os.homedir(), '.claude', 'memory', 'scribe')

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'meeting'
  )
}

export function writeMeetingMemory(a: {
  id: number
  title: string
  startedAt: string
  notesMd: string
  cleanedTranscript: string
}): string {
  const notesDir = path.join(MEMORY_DIR, 'notes')
  const byDayDir = path.join(MEMORY_DIR, 'by-day')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.mkdirSync(byDayDir, { recursive: true })

  const date = (a.startedAt || '').slice(0, 10) || 'undated'
  const filename = `${date}_${slugify(a.title)}__${a.id}.md`
  const filepath = path.join(notesDir, filename)

  const body =
    [
      '---',
      `title: ${a.title}`,
      `date: ${a.startedAt}`,
      `recording_id: ${a.id}`,
      'source: scribe',
      '---',
      '',
      `# ${a.title}`,
      '',
      '## Notes',
      a.notesMd.trim(),
      '',
      '## Transcript',
      a.cleanedTranscript.trim(),
      '',
    ].join('\n')
  fs.writeFileSync(filepath, body)

  const summaryLine =
    a.notesMd
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 140) || a.title
  const pointer = `- **${a.title}** (rec ${a.id}) — ${summaryLine} → notes/${filename}\n`
  fs.appendFileSync(path.join(byDayDir, `${date}.md`), pointer)

  return filepath
}
