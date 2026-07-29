import { ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { readAgentFile } from '../agent-manager'

export function registerFilepathHandlers(): void {
  // ── FilePath — filesystem explorer ──
  ipcMain.handle('filepath:get-root', () => {
    const custom = process.env.ROCA_INTELLIGENCE_DIR
    let projectRoot: string
    let rocaDir: string
    if (custom && fs.existsSync(custom)) {
      rocaDir = custom
      projectRoot = path.dirname(custom)
    } else {
      projectRoot = process.env.ROCA_PROJECT_DIR || path.join(os.homedir(), 'repos', 'project')
      rocaDir = app.isPackaged
        ? path.join(process.resourcesPath, 'roca')
        : path.join(__dirname, '../../../roca')
    }
    return { projectRoot, rocaDir }
  })

  ipcMain.handle('filepath:list-dir', (_: any, dirPath: string) => {
    const PROJECT_DIR = process.env.ROCA_PROJECT_DIR || path.join(os.homedir(), 'repos', 'project')
    const ROCA_DIR = path.join(os.homedir(), 'repos', 'roca')
    const CLAUDE_DIR = path.join(os.homedir(), '.claude')
    const allowed = [PROJECT_DIR, ROCA_DIR, CLAUDE_DIR]
    const resolved = path.resolve(dirPath)
    if (!allowed.some(dir => resolved.startsWith(dir))) {
      return []
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return []
    const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.DS_Store', '.mypy_cache', '.pytest_cache', 'dist', '.turbo'])
    const CLAUDE_CODE_INTERNALS = new Set([
      'projects', 'sessions', 'tasks', 'todos', 'plans', 'plugins', 'commands',
      'file-history', 'paste-cache', 'shell-snapshots', 'session-env',
      'telemetry', 'cache', 'backups'
    ])
    const inClaudeRoot = resolved === CLAUDE_DIR
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const results: { name: string; path: string; isDirectory: boolean; size?: number; modifiedAt?: string; childCount?: number }[] = []
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.isDirectory()) continue
        if (inClaudeRoot && CLAUDE_CODE_INTERNALS.has(entry.name)) continue
        const fullPath = path.join(resolved, entry.name)
        try {
          const stat = fs.statSync(fullPath)
          let childCount: number | undefined
          if (entry.isDirectory()) {
            try {
              const children = fs.readdirSync(fullPath, { withFileTypes: true })
              childCount = children.filter(c => !SKIP.has(c.name) && !(c.name.startsWith('.') && c.isDirectory())).length
            } catch { childCount = undefined }
          }
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isFile() ? stat.size : undefined,
            modifiedAt: stat.mtime.toISOString(),
            childCount,
          })
        } catch { continue }
        if (results.length >= 500) break
      }
      results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return results
    } catch {
      return []
    }
  })

  ipcMain.handle('filepath:read-file', (_: any, filePath: string) => {
    return readAgentFile(filePath)
  })

  ipcMain.handle('filepath:save-file', (_: any, filePath: string, content: string) => {
    const PROJECT_DIR = process.env.ROCA_PROJECT_DIR || path.join(os.homedir(), 'repos', 'project')
    const ROCA_DIR = path.join(os.homedir(), 'repos', 'roca')
    const CLAUDE_DIR = path.join(os.homedir(), '.claude')
    const allowed = [PROJECT_DIR, ROCA_DIR, CLAUDE_DIR]
    const resolved = path.resolve(filePath)
    if (!allowed.some(dir => resolved.startsWith(dir))) {
      return { ok: false }
    }
    try {
      fs.writeFileSync(resolved, content, 'utf8')
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })
}
