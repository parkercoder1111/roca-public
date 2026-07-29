import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// ═══════════════════════════════════════════
//  MCP CONFIG — wraps the `claude mcp` CLI
//
//  We shell out instead of editing ~/.claude.json or .mcp.json directly so
//  the on-disk schema stays Claude's problem, not ours.
// ═══════════════════════════════════════════

export type McpScope = 'user' | 'project'

export interface McpServer {
  name: string
  scope: McpScope
  command: string
  args: string[]
  status: 'connected' | 'failed' | 'unknown'
}

export interface AddMcpServerSpec {
  name: string
  scope: McpScope
  command: string
  args: string[]
  env: Record<string, string>
}

// `claude mcp list` prints lines like:
//   name: command args here  ✓ Connected
//   name: command args here  ✗ Failed
// Exact format may shift between Claude versions; we accept any of those
// markers and fall back to 'unknown' if we can't tell.
function parseList(stdout: string, scope: McpScope): McpServer[] {
  const out: McpServer[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^([\w@.\-:/]+):\s*(.+?)(?:\s+([✓✗])\s*(\w+))?$/)
    if (!m) continue
    const [, name, rest, marker] = m
    const parts = rest.split(/\s+/)
    const command = parts[0] || ''
    const args = parts.slice(1)
    const status: McpServer['status'] = marker === '✓' ? 'connected' : marker === '✗' ? 'failed' : 'unknown'
    out.push({ name, scope, command, args, status })
  }
  return out
}

async function runClaudeMcp(args: string[]): Promise<string> {
  // Inherit PATH from the user shell where possible — claude is usually at
  // ~/.local/bin/claude or /opt/homebrew/bin/claude, which Electron's PATH
  // may not include.
  const env = {
    ...process.env,
    PATH: [
      `${process.env.HOME}/.local/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      process.env.PATH ?? '',
    ].join(':'),
  }
  const { stdout } = await execFileAsync('claude', args, { env, timeout: 10000 })
  return stdout
}

export async function listMcpServers(): Promise<McpServer[]> {
  const out: McpServer[] = []
  for (const scope of ['user', 'project'] as McpScope[]) {
    try {
      const stdout = await runClaudeMcp(['mcp', 'list', '--scope', scope])
      out.push(...parseList(stdout, scope))
    } catch {
      // Scope-specific failures (e.g. no project mcp.json) are non-fatal.
    }
  }
  return out
}

export async function addMcpServer(spec: AddMcpServerSpec): Promise<void> {
  const envFlags: string[] = []
  for (const [k, v] of Object.entries(spec.env)) {
    envFlags.push('--env', `${k}=${v}`)
  }
  await runClaudeMcp([
    'mcp', 'add',
    '--scope', spec.scope,
    ...envFlags,
    spec.name,
    '--',
    spec.command,
    ...spec.args,
  ])
}

export async function removeMcpServer(name: string, scope: McpScope): Promise<void> {
  await runClaudeMcp(['mcp', 'remove', '--scope', scope, name])
}

export async function isClaudeAvailable(): Promise<boolean> {
  try {
    await runClaudeMcp(['--version'])
    return true
  } catch {
    return false
  }
}
