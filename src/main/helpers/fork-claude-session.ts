import path from 'path'
import fs from 'fs'
import os from 'os'

// Claude Code persists each conversation as a JSONL file under
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// The encoding replaces both '/' and '.' with '-' (e.g. /Applications/ROCA.app
// becomes -Applications-ROCA-app). Missing the dot case silently breaks fork
// for any cwd containing a dot.
function projectDirForCwd(cwd: string): string {
  const encoded = cwd.replace(/[/.]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', encoded)
}

/**
 * Last-resort fallback for when the pane's live Claude can't be attributed
 * (PtyManager.getClaudeSessionId returned null — e.g. Claude has exited). Returns
 * the source session UUID that the forked task should `claude --resume <uuid>
 * --fork-session` from; Claude mints a fresh session ID for the fork itself.
 *
 * Only trustworthy when the cwd's project dir holds a single conversation. In a
 * shared dir ($HOME, where every non-repo task's Claude runs, or a repo dir shared
 * by many dev sessions) dozens of unrelated JSONLs pile up and "most recently
 * modified" is almost never this task's — silently forking it resumes a stranger's
 * conversation. So when the dir is ambiguous we return null and let the caller
 * surface an honest error ("open the task and send a message first") rather than
 * fork the wrong session.
 */
export function forkClaudeSession(sourceCwd: string): string | null {
  const dir = projectDirForCwd(sourceCwd)
  if (!fs.existsSync(dir)) return null
  const sessions = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))
  if (sessions.length !== 1) return null
  return sessions[0].replace(/\.jsonl$/, '')
}
