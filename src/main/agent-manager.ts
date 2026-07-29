import { execSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const AGENTS_DIR = process.env.ROCA_AGENTS_DIR || path.join(os.homedir(), 'repos', 'agents')
const SCHEDULES_DIR = path.join(AGENTS_DIR, 'schedules')
const STATE_DIR = path.join(AGENTS_DIR, 'state')

// ── Agent roster ────────────────────────────────────────────────────────────
export interface AgentInfo {
  name: string
  label: string
  plist: string | null
  stateFile: string | null
  logFile: string | null
}

// Neutral example roster. Point ROCA_AGENTS_DIR at your own agents directory and
// swap these entries for your scheduled jobs (launchd labels + plist files).
const ROSTER: AgentInfo[] = [
  { name: 'Example Sync',   label: 'com.example.sync',   plist: 'com.example.sync.plist',   stateFile: 'example-sync-state.json',   logFile: 'outputs/example-sync/logs/launchd-stdout.log' },
  { name: 'Example Report', label: 'com.example.report', plist: 'com.example.report.plist', stateFile: 'example-report-state.json', logFile: null },
  { name: 'Example Audit',  label: 'com.example.audit',  plist: 'com.example.audit.plist',  stateFile: null,                        logFile: null },
]

// ── Agent file map — all files belonging to each agent ──────────────────────
// Paths are relative to AGENTS_DIR unless absolute
const ROCA_DIR = path.join(os.homedir(), 'repos', 'roca')

export interface AgentFileEntry {
  label: string       // display name in tree
  path: string        // absolute path
  type: 'file' | 'dir'
  category: 'runner' | 'script' | 'prompt' | 'skill' | 'state' | 'schedule' | 'output' | 'config'
}

function agentsPath(...parts: string[]): string {
  return path.join(AGENTS_DIR, ...parts)
}

const AGENT_FILE_MAP: Record<string, AgentFileEntry[]> = {
  'Example Sync': [
    { label: 'run-example-sync.sh', path: agentsPath('agents/example/run-example-sync.sh'), type: 'file', category: 'runner' },
    { label: 'example-sync.py', path: agentsPath('agents/example/example-sync.py'), type: 'file', category: 'script' },
    { label: 'README.md', path: agentsPath('agents/example/README.md'), type: 'file', category: 'config' },
    { label: 'example-sync.skill', path: agentsPath('skills/example-sync.skill'), type: 'file', category: 'skill' },
    { label: 'example-sync-state.json', path: agentsPath('state/example-sync-state.json'), type: 'file', category: 'state' },
    { label: 'com.example.sync.plist', path: agentsPath('schedules/com.example.sync.plist'), type: 'file', category: 'schedule' },
    { label: 'outputs/example-sync/', path: agentsPath('outputs/example-sync'), type: 'dir', category: 'output' },
  ],
  'Example Report': [
    { label: 'run-example-report.sh', path: agentsPath('agents/example/run-example-report.sh'), type: 'file', category: 'runner' },
    { label: 'README.md', path: agentsPath('agents/example/README.md'), type: 'file', category: 'config' },
    { label: 'example-report-prompt.md', path: agentsPath('skills/example-report-prompt.md'), type: 'file', category: 'prompt' },
    { label: 'example-report.skill', path: agentsPath('skills/example-report.skill'), type: 'file', category: 'skill' },
    { label: 'example-report-state.json', path: agentsPath('state/example-report-state.json'), type: 'file', category: 'state' },
    { label: 'com.example.report.plist', path: agentsPath('schedules/com.example.report.plist'), type: 'file', category: 'schedule' },
    { label: 'outputs/example-report/', path: agentsPath('outputs/example-report'), type: 'dir', category: 'output' },
  ],
  'Example Audit': [
    { label: 'run-example-audit.sh', path: agentsPath('agents/example/run-example-audit.sh'), type: 'file', category: 'runner' },
    { label: 'example-audit.py', path: agentsPath('agents/example/example-audit.py'), type: 'file', category: 'script' },
    { label: 'README.md', path: agentsPath('agents/example/README.md'), type: 'file', category: 'config' },
    { label: 'example-audit.skill', path: agentsPath('skills/example-audit.skill'), type: 'file', category: 'skill' },
    { label: 'com.example.audit.plist', path: agentsPath('schedules/com.example.audit.plist'), type: 'file', category: 'schedule' },
    { label: 'outputs/example-audit/', path: agentsPath('outputs/example-audit'), type: 'dir', category: 'output' },
  ],
}

export function getAgentFiles(agentName: string): AgentFileEntry[] {
  const entries = AGENT_FILE_MAP[agentName] ?? []
  // Only return files that actually exist
  return entries.filter(e => fs.existsSync(e.path))
}

export function readAgentFile(filePath: string): { ok: boolean; content: string; size: number } {
  // Security: only allow reading files under known safe directories
  const allowed = [AGENTS_DIR, ROCA_DIR, path.join(os.homedir(), '.claude')]
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

// ── Tool file map — files associated with each builtin integration ───────────
const TOOL_FILE_MAP: Record<string, AgentFileEntry[]> = {
  'CRM': [
    { label: 'crm-api.skill', path: agentsPath('skills/crm-api.skill'), type: 'file', category: 'skill' },
    { label: 'data-integrity-rules.md', path: agentsPath('skills/data-integrity-rules.md'), type: 'file', category: 'config' },
    { label: 'crm-company-intake.skill', path: agentsPath('skills/crm-company-intake.skill'), type: 'file', category: 'skill' },
    { label: 'query.py', path: agentsPath('agents/sdk/tools/crm/query.py'), type: 'file', category: 'script' },
    { label: 'create.py', path: agentsPath('agents/sdk/tools/crm/create.py'), type: 'file', category: 'script' },
    { label: 'update.py', path: agentsPath('agents/sdk/tools/crm/update.py'), type: 'file', category: 'script' },
    { label: 'bulk_create.py', path: agentsPath('agents/sdk/tools/crm/bulk_create.py'), type: 'file', category: 'script' },
    { label: 'bulk_update.py', path: agentsPath('agents/sdk/tools/crm/bulk_update.py'), type: 'file', category: 'script' },
    { label: 'find_duplicates.py', path: agentsPath('agents/sdk/tools/crm/find_duplicates.py'), type: 'file', category: 'script' },
    { label: 'list_domains.py', path: agentsPath('agents/sdk/tools/crm/list_domains.py'), type: 'file', category: 'script' },
    { label: 'crm-changelog.jsonl', path: agentsPath('state/crm-changelog.jsonl'), type: 'file', category: 'state' },
  ],
  'Outreach': [
    { label: 'outreach-api.skill', path: agentsPath('skills/outreach-api.skill'), type: 'file', category: 'skill' },
    { label: 'outreach-upload.skill', path: agentsPath('skills/outreach-upload.skill'), type: 'file', category: 'skill' },
    { label: 'campaign_stats.py', path: agentsPath('agents/sdk/tools/outreach/campaign_stats.py'), type: 'file', category: 'script' },
    { label: 'fetch_replies.py', path: agentsPath('agents/sdk/tools/outreach/fetch_replies.py'), type: 'file', category: 'script' },
    { label: 'lead_status.py', path: agentsPath('agents/sdk/tools/outreach/lead_status.py'), type: 'file', category: 'script' },
    { label: 'batch_upload.py', path: agentsPath('agents/sdk/tools/outreach/batch_upload.py'), type: 'file', category: 'script' },
    { label: 'pause_lead.py', path: agentsPath('agents/sdk/tools/outreach/pause_lead.py'), type: 'file', category: 'script' },
  ],
  'Gmail': [
    { label: 'gmail-drafts.skill', path: agentsPath('skills/gmail-drafts/SKILL.md'), type: 'file', category: 'skill' },
    { label: 'gmail-draft.py', path: agentsPath('skills/gmail-drafts/scripts/gmail-draft.py'), type: 'file', category: 'script' },
    { label: 'email-templates.md', path: agentsPath('outputs/templates/email-templates.md'), type: 'file', category: 'prompt' },
    { label: 'credentials.json', path: agentsPath('credentials.json'), type: 'file', category: 'config' },
    { label: 'token.json', path: agentsPath('token.json'), type: 'file', category: 'config' },
  ],
  'Google Sheets': [
    { label: 'google-sheets.skill', path: agentsPath('skills/google-sheets.skill'), type: 'file', category: 'skill' },
    { label: 'sheet_read.py', path: agentsPath('agents/sdk/tools/google/sheet_read.py'), type: 'file', category: 'script' },
    { label: 'sheet_write.py', path: agentsPath('agents/sdk/tools/google/sheet_write.py'), type: 'file', category: 'script' },
  ],
  'Google Drive': [
    { label: 'doc_read.py', path: agentsPath('agents/sdk/tools/google/doc_read.py'), type: 'file', category: 'script' },
  ],
  'Slack': [
    { label: 'slack-bot.py', path: agentsPath('agents/slack-bot/slack-bot.py'), type: 'file', category: 'script' },
    { label: 'slack-bot-prompt.md', path: agentsPath('agents/slack-bot/slack-bot-prompt.md'), type: 'file', category: 'prompt' },
    { label: 'slack-app-manifest.json', path: agentsPath('agents/slack-bot/slack-app-manifest.json'), type: 'file', category: 'config' },
    { label: 'notify-slack.sh', path: agentsPath('agents/shared/notify-slack.sh'), type: 'file', category: 'script' },
  ],
  'Apple Calendar': [
    { label: 'calendar.skill', path: agentsPath('skills/calendar.skill'), type: 'file', category: 'skill' },
    { label: 'calendar-event.sh', path: agentsPath('agents/shared/calendar-event.sh'), type: 'file', category: 'script' },
  ],
  'Workflow Fleet': [
    { label: 'agent-manager.ts', path: path.join(ROCA_DIR, 'src/main/agent-manager.ts'), type: 'file', category: 'script' },
    { label: 'schedules/', path: agentsPath('schedules'), type: 'dir', category: 'schedule' },
  ],
  'Memsearch': [
    { label: 'memsearch.db', path: agentsPath('memsearch.db'), type: 'file', category: 'state' },
    { label: 'sync_and_index.py', path: agentsPath('agents/sdk/tools/memsearch/sync_and_index.py'), type: 'file', category: 'script' },
    { label: 'incremental_index.py', path: agentsPath('agents/sdk/tools/memsearch/incremental_index.py'), type: 'file', category: 'script' },
  ],
  'Claude Code': [
    { label: 'CLAUDE.md', path: agentsPath('CLAUDE.md'), type: 'file', category: 'config' },
  ],
  'SQLite': [
    { label: 'database.ts', path: path.join(ROCA_DIR, 'src/main/database.ts'), type: 'file', category: 'script' },
  ],
  'Terminal (PTY)': [
    { label: 'pty-manager.ts', path: path.join(ROCA_DIR, 'src/main/pty-manager.ts'), type: 'file', category: 'script' },
    { label: 'task-terminal.tsx', path: path.join(ROCA_DIR, 'src/renderer/components/task-terminal.tsx'), type: 'file', category: 'script' },
  ],
}

export function getToolFiles(toolName: string): AgentFileEntry[] {
  const entries = TOOL_FILE_MAP[toolName] ?? []
  return entries.filter(e => fs.existsSync(e.path))
}

// ── Output directory map (relative to AGENTS_DIR) ───────────────────────────
const OUTPUT_DIR_MAP: Record<string, string> = {
  'Example Sync': 'outputs/example-sync',
  'Example Report': 'outputs/example-report',
  'Example Audit': 'outputs/example-audit',
}

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
      if (!label.startsWith('com.example')) continue
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
  return path.join(AGENTS_DIR, rel)
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
    logPath = path.join(AGENTS_DIR, agent.logFile)
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
