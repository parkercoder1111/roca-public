// Claude calls for Scribe — cleanup, notes, and "ask anything". Runs on the
// user's Claude subscription via the local `claude -p` binary (NOT an API key).
//
//   claude --model <haiku|sonnet> --permission-mode acceptEdits
//          --setting-sources project,local -p        (prompt on stdin)
//
// `--setting-sources project,local` excludes the user-global CLAUDE.md, and we
// run from ~/scribe (no project .claude) so the transform stays clean.
import { spawn } from 'child_process'
import os from 'os'
import path from 'path'

const CLAUDE_BIN = process.env.SCRIBE_CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude')
const CLAUDE_CWD = path.join(os.homedir(), 'scribe')
const TIMEOUT_MS = 180_000

export type ClaudeModel = 'haiku' | 'sonnet'

export function runClaude(model: ClaudeModel, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      CLAUDE_BIN,
      ['--model', model, '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '-p'],
      { cwd: CLAUDE_CWD, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`claude -p (${model}) timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`claude -p (${model}) exited ${code}: ${err.slice(-400)}`))
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

// ── prompts ──

export function cleanupPrompt(rawTranscript: string): string {
  return (
    'You are cleaning up a raw meeting transcript captured from two SEPARATE audio channels:\n' +
    '  "Me"   = the local microphone — the person holding this device.\n' +
    '  "Them" = system audio — the other side of a call, or a video/app playing on the computer.\n\n' +
    'These are physically distinct streams, so the speaker of every line is already KNOWN from its ' +
    'channel. NEVER guess, swap, or re-attribute a speaker. Your job is formatting and de-duplication ' +
    'only.\n\n' +
    'DE-DUPLICATION RULE: when the computer plays sound through speakers (a video, or the other side of ' +
    'a call on speakerphone) and the user is not wearing headphones, that same sound bleeds into the ' +
    'microphone. So identical words show up on BOTH channels at nearly the same time. That is an echo, ' +
    'not two people talking. When a "Me" line and a "Them" line are near-identical and overlap, keep ONE ' +
    'copy and label it "Them:" — the computer/other-side is the true source and the "Me" copy is just mic ' +
    'bleed. Output that statement once.\n\n' +
    'When a statement appears on ONLY ONE channel, keep that channel\'s label: "Me:" for mic-only (the ' +
    'local person genuinely speaking while the other channel is silent / [BLANK_AUDIO]), "Them:" for ' +
    'system-only.\n\n' +
    'FORMAT — this is mandatory: EVERY output line MUST begin with "Me:" or "Them:". Do NOT drop the ' +
    'labels, even if the whole recording turns out to be one speaker. Merge each speaker\'s consecutive ' +
    'fragmented lines into a single labeled turn.\n\n' +
    'Then fix transcription errors, punctuation, and capitalization; remove filler words, false starts, ' +
    'and self-corrections; drop any "[BLANK_AUDIO]" markers. Do NOT summarize, add, or drop real content. ' +
    'Output ONLY the cleaned transcript — one "Me:" or "Them:" turn per line.\n\n' +
    rawTranscript
  )
}

export function notesPrompt(cleanedTranscript: string): string {
  return (
    'You are writing structured meeting notes from a cleaned transcript. Produce concise ' +
    'markdown:\n' +
    '- A first line that is a one-sentence summary of the meeting (no heading).\n' +
    '- Then themed "## Section" headings with bullet points capturing decisions, key points, ' +
    'and any numbers/figures mentioned.\n' +
    '- End with a "## Action Items" section, each bullet prefixed by the owner (e.g. "- Alex: ...").\n' +
    'Be faithful to the transcript; do not invent anything. Output ONLY the markdown notes.\n\n' +
    cleanedTranscript
  )
}

export function askPrompt(notesMd: string, transcript: string, question: string): string {
  return (
    'You are answering a question about a meeting, using its notes and transcript below. ' +
    'Be concise and specific, grounded in what was actually said. If the answer is not in ' +
    'the meeting, say so plainly.\n\n' +
    `<notes>\n${notesMd || '(notes not generated yet)'}\n</notes>\n\n` +
    `<transcript>\n${transcript}\n</transcript>\n\n` +
    `Question: ${question}`
  )
}

export const FOLLOW_UP_EMAIL_QUESTION =
  'Write a follow-up email summarizing this meeting and the agreed next steps. Keep it brief ' +
  'and professional. Use hyphens, never em dashes. Output only the email body.'
