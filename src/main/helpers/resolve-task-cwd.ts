import path from 'path'
import os from 'os'
import { getFolders, currentIsoWeek } from '../database'

/**
 * True when a task lives in the Development folder — the signal that its claude
 * is doing work on the ROCA codebase itself (runs in the repo, moves fast).
 */
export function isDevelopmentTask(task: { folder_id?: number | null }): boolean {
  if (!task.folder_id) return false
  try {
    const folder = getFolders(currentIsoWeek()).find(f => f.id === task.folder_id)
    return !!folder && folder.name === 'Development'
  } catch {
    return false
  }
}

/**
 * The working directory a task's claude should run in.
 *
 * Forked tasks open at the source's cwd so `claude --resume` finds the cloned
 * JSONL (Claude only searches the current cwd's project dir). Development-folder
 * tasks default to the ROCA codebase. Everything else returns undefined so the
 * caller can fall back to its own default.
 *
 * Shared by the terminal launch (`pty:start`) and the optical view's headless
 * launch so the two can't drift on where a task runs.
 */
export function resolveTaskCwd(task: { forked_source_cwd?: string | null; folder_id?: number | null }): string | undefined {
  if (task.forked_source_cwd) return task.forked_source_cwd
  if (isDevelopmentTask(task)) return path.join(os.homedir(), 'repos', 'roca')
  return undefined
}

/**
 * Whether a task's claude should launch with permissions bypassed
 * (`--dangerously-skip-permissions`). Both cases are fast-moving dev work where
 * a mid-run permission prompt just stalls the user:
 *   - Development-folder tasks (working on ROCA itself), and
 *   - [Bug]/[Feature] throwaway sessions (created with those title prefixes).
 *
 * This is the task-type policy only — the caller still gates it on a local host,
 * since claude-as-root on the VM rejects --dangerously-skip-permissions.
 */
export function shouldBypassPermissions(task: { title?: string; folder_id?: number | null }): boolean {
  if (task.title && /^\s*\[(bug|feature)\]/i.test(task.title)) return true
  return isDevelopmentTask(task)
}
