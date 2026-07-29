import path from 'path'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'

/** Find claude binary synchronously for scheduler use */
export function findClaudeBinarySync(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.claude', 'local', 'claude'),
  ]
  // Check nvm-installed node bins (Electron doesn't inherit shell PATH)
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse()
      for (const v of versions) {
        candidates.push(path.join(nvmDir, v, 'bin', 'claude'))
      }
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  try {
    const result = execSync('which claude 2>/dev/null').toString().trim()
    if (result && fs.existsSync(result)) return result
  } catch { /* ignore */ }
  return null
}
