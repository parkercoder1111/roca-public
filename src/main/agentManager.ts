import { execSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Project directory — defaults to the parent of ROCA_INTELLIGENCE_DIR if set,
// otherwise falls back to ~/repos/roca (the app's own repo).
const PROJECT_DIR = process.env.ROCA_INTELLIGENCE_DIR
  ? path.dirname(process.env.ROCA_INTELLIGENCE_DIR)
  : path.join(os.homedir(), 'repos', 'roca')
const SCHEDULES_DIR = path.join(PROJECT_DIR, 'schedules')
const STATE_DIR = path.join(PROJECT_DIR, 'state')

// ── Agent roster ────────────────────────────────────────────────────────────
export interface AgentInfo {
  name: string
  label: string
  plist: string | null
  stateFile: string | null
  logFile: string | null
}

// Agent roster — add your own agents here.
// Each entry maps a human-readable name to its launchd label, plist file, state file, and log file.
// Example:
//   { name: 'My Agent', label: 'com.roca.my-agent', plist: 'com.roca.my-agent.plist', stateFile: 'my-agent-state.json', logFile: null },
const ROSTER: AgentInfo[] = []

// ── Agent file map — all files belonging to each agent ──────────────────────
// Paths are relative to PROJECT_DIR unless absolute

export interface AgentFileEntry {
  label: string       // display name in tree
  path: string        // absolute path
  type: 'file' | 'dir'
  category: 'runner' | 'script' | 'prompt' | 'skill' | 'state' | 'schedule' | 'output' | 'config'
}

function projectPath(...parts: string[]): string {
  return path.join(PROJECT_DIR, ...parts)
}

// Agent file map — add entries for each agent's associated files.
// Files are resolved relative to PROJECT_DIR unless absolute paths are used.
// Only files that exist on disk are returned to the renderer.
const AGENT_FILE_MAP: Record<string, AgentFileEntry[]> = {}

export function getAgentFiles(agentName: string): AgentFileEntry[] {
  const entries = AGENT_FILE_MAP[agentName] ?? []
  // Only return files that actually exist
  return entries.filter(e => fs.existsSync(e.path))
}

export function readAgentFile(filePath: string): { ok: boolean; content: string; size: number } {
  // Security: only allow reading files under known safe directories
  const allowed = [PROJECT_DIR, path.join(os.homedir(), '.claude')]
  const resolved = path.resolve(filePath)
  if (!allowed.some(dir => resolved.startsWith(dir))) {
    return { ok: false, content: '(Access denied)', size: 0 }
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, content: '(File not found)', size: 0 }
  }
  try {
    const stat = fs.statSync(resolved)
    // Cap at 512KB to prevent loading huge files
    if (stat.size > 524288) {
      const partial = fs.readFileSync(resolved, { encoding: 'utf8', flag: 'r' }).slice(0, 524288)
      return { ok: true, content: partial + '\n\n… (truncated, file is ' + Math.round(stat.size / 1024) + 'KB)', size: stat.size }
    }
    return { ok: true, content: fs.readFileSync(resolved, 'utf8'), size: stat.size }
  } catch {
    return { ok: false, content: '(Could not read file)', size: 0 }
  }
}

// Tool file map — add entries for each tool integration's associated files.
// Users can populate this with their own tool-specific files.
const TOOL_FILE_MAP: Record<string, AgentFileEntry[]> = {}

export function getToolFiles(toolName: string): AgentFileEntry[] {
  const entries = TOOL_FILE_MAP[toolName] ?? []
  return entries.filter(e => fs.existsSync(e.path))
}

// Output directory map — maps agent names to their output directories.
// Paths are relative to PROJECT_DIR unless absolute.
const OUTPUT_DIR_MAP: Record<string, string> = {}

// ── Types returned to renderer ──────────────────────────────────────────────
export interface AgentStatus {
  name: string
  label: string
  running: boolean
  pid: number | null
  lastExitCode: number | null
  schedule: string | null
  stateFile: string | null
  alertOwner: boolean
  outputDir: string | null
}

// ── Parse launchctl list output ─────────────────────────────────────────────
function parseLaunchctlList(): Map<string, { pid: number | null; exitCode: number | null }> {
  const result = new Map<string, { pid: number | null; exitCode: number | null }>()
  try {
    const out = execSync('launchctl list', { timeout: 5000, encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const [pidStr, exitStr, label] = parts
      if (!label.startsWith('com.roca')) continue
      const parsedPid = parseInt(pidStr)
      const parsedExit = parseInt(exitStr)
      result.set(label, {
        pid: pidStr === '-' ? null : (isNaN(parsedPid) ? null : parsedPid),
        exitCode: exitStr === '-' ? null : (isNaN(parsedExit) ? null : parsedExit),
      })
    }
  } catch {
    // launchctl may not be available in test env — return empty map
  }
  return result
}

// ── Parse plist for schedule description ───────────────────────────────────
function parseSchedule(plistName: string | null): string | null {
  if (!plistName) return null
  const plistPath = path.join(SCHEDULES_DIR, plistName)
  if (!fs.existsSync(plistPath)) return null
  try {
    const xml = fs.readFileSync(plistPath, 'utf8')

    // StartInterval (seconds)
    const intervalMatch = xml.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/)
    if (intervalMatch) {
      const secs = parseInt(intervalMatch[1])
      if (secs < 120) return `Every ${secs}s`
      if (secs < 7200) return `Every ${Math.round(secs / 60)}m`
      return `Every ${Math.round(secs / 3600)}h`
    }

    // StartCalendarInterval — may be dict (single) or array (multiple)
    // Extract all Hour/Minute pairs
    const dictMatches = Array.from(xml.matchAll(/<dict>([\s\S]*?)<\/dict>/g))
    const times: string[] = []
    for (const m of dictMatches) {
      const block = m[1]
      const hourM = block.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/)
      const minM = block.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/)
      if (hourM) {
        const h = parseInt(hourM[1])
        const min = minM ? parseInt(minM[1]) : 0
        const ampm = h >= 12 ? 'pm' : 'am'
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
        times.push(`${h12}:${String(min).padStart(2, '0')}${ampm}`)
      }
    }
    if (times.length > 0) return `Daily ${times.join(', ')}`
  } catch {
    // ignore parse errors
  }
  return null
}

// ── Public API ──────────────────────────────────────────────────────────────

function resolveOutputDir(agentName: string): string | null {
  const rel = OUTPUT_DIR_MAP[agentName]
  if (!rel) return null
  if (path.isAbsolute(rel)) return rel
  return path.join(PROJECT_DIR, rel)
}

async function checkAlertOwner(agent: AgentInfo): Promise<boolean> {
  if (!agent.stateFile) return false
  const stateFilePath = path.join(STATE_DIR, agent.stateFile)
  if (!fs.existsSync(stateFilePath)) return false
  try {
    // 100KB cap: prevents accidental large-file reads on the 5s polling tick
    if (fs.statSync(stateFilePath).size >= 102400) return false
    const content = await fs.promises.readFile(stateFilePath, 'utf8')
    const data = JSON.parse(content)
    return data.ALERT_OWNER === true
  } catch {
    return false
  }
}

export async function listAgents(): Promise<AgentStatus[]> {
  const liveMap = parseLaunchctlList()
  return Promise.all(ROSTER.map(async agent => {
    const live = liveMap.get(agent.label)
    return {
      name: agent.name,
      label: agent.label,
      running: !!(live && live.pid !== null),
      pid: live?.pid ?? null,
      lastExitCode: live?.exitCode ?? null,
      schedule: parseSchedule(agent.plist),
      stateFile: agent.stateFile,
      alertOwner: await checkAlertOwner(agent),
      outputDir: resolveOutputDir(agent.name),
    }
  }))
}

export function openAgentOutput(agentLabel: string): { ok: boolean; path: string | null } {
  const agent = ROSTER.find(a => a.label === agentLabel)
  if (!agent) return { ok: false, path: null }
  const dir = resolveOutputDir(agent.name)
  if (!dir) return { ok: false, path: null }
  return { ok: true, path: dir }
}

export function getAgentState(agentName: string): Record<string, unknown> | null {
  const agent = ROSTER.find(a => a.name.toLowerCase() === agentName.toLowerCase())
  if (!agent?.stateFile) return null
  const stateFilePath = path.join(STATE_DIR, agent.stateFile)
  if (!fs.existsSync(stateFilePath)) return null
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
  } catch {
    return null
  }
}

export function tailAgentLog(agentLabel: string, lines = 50): string {
  const agent = ROSTER.find(a => a.label === agentLabel)

  // Try the explicit log path from plist first
  let logPath: string | null = null
  if (agent?.logFile) {
    logPath = path.join(PROJECT_DIR, agent.logFile)
  }

  // Fallback: look in ~/Library/Logs/ using the ROSTER label (prevents path injection)
  if ((!logPath || !fs.existsSync(logPath)) && agent) {
    const libLog = path.join(os.homedir(), 'Library', 'Logs', `${agent.label}.log`)
    if (fs.existsSync(libLog)) logPath = libLog
  }

  // Fallback: find any plist stdout log
  if (!logPath && agent?.plist) {
    const plistPath = path.join(SCHEDULES_DIR, agent.plist)
    if (fs.existsSync(plistPath)) {
      try {
        const xml = fs.readFileSync(plistPath, 'utf8')
        const m = xml.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/)
        if (m) {
          const candidate = m[1]
          if (fs.existsSync(candidate)) logPath = candidate
        }
      } catch {}
    }
  }

  if (!logPath) return '(No log file found)'
  try {
    return execFileSync('tail', ['-n', String(lines), logPath], { timeout: 3000, encoding: 'utf8' })
  } catch {
    return `(Could not read log: ${logPath})`
  }
}

function launchctlAction(agentLabel: string, action: 'load' | 'unload'): { ok: boolean; error?: string } {
  const plistName = ROSTER.find(a => a.label === agentLabel)?.plist
  if (!plistName) return { ok: false, error: 'Unknown agent' }
  const plistPath = path.join(SCHEDULES_DIR, plistName)
  try {
    execSync(`launchctl ${action} "${plistPath}"`, { timeout: 5000 })
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export function startAgent(agentLabel: string): { ok: boolean; error?: string } {
  return launchctlAction(agentLabel, 'load')
}

export function stopAgent(agentLabel: string): { ok: boolean; error?: string } {
  return launchctlAction(agentLabel, 'unload')
}
