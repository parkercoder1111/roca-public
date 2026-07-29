import fs from 'fs'
import os from 'os'
import path from 'path'

// Google OAuth token has moved between locations over time. Rather than
// hardcode one path, scan a candidate list and pick the first existing file.
// Order: explicit env-var override > current canonical (~/.claude/) > legacy.
const CANDIDATES = (): string[] => {
  const override = process.env.GOOGLE_TOKEN_PATH
  const list = override ? [override] : []
  list.push(path.join(os.homedir(), '.claude', 'token.json'))
  list.push(path.join(os.homedir(), '.roca', 'token.json'))
  return list
}

// Returns the first existing path, or the highest-priority candidate (for
// display / "where would I write it" purposes) if none exist.
export function googleTokenPath(): string {
  const list = CANDIDATES()
  for (const p of list) {
    try { if (fs.existsSync(p)) return p } catch { /* keep scanning */ }
  }
  return list[0]
}

// True iff we actually found a token file on disk.
export function googleTokenExists(): boolean {
  return CANDIDATES().some(p => { try { return fs.existsSync(p) } catch { return false } })
}
