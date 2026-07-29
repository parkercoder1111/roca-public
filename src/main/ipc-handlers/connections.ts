import { ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import * as gmail from '../gmail'
import { googleTokenPath, googleTokenExists } from '../google-token-path'
import * as slack from '../slack'
import { getApiKey, setApiKey, clearApiKey, envKeyName, type KeyId, setRawKey, clearRawKey, getRawKey } from '../api-keys-config'
import {
  listCustomConnections,
  addCustomConnection,
  removeCustomConnection,
  findCustomConnection,
  type CustomConnection,
  type CustomApiConnection,
  type CustomMcpConnection,
  type CustomCliConnection,
} from '../custom-connections-config'
import { listMcpServers, addMcpServer, removeMcpServer, isClaudeAvailable, type McpServer, type AddMcpServerSpec } from '../mcp-config'

const execFileAsync = promisify(execFile)

// Env-driven API bases for the built-in probes. Point these at your own
// service by setting the matching env vars; left blank they simply report the
// connection as unconfigured until a base + key are supplied.
const CRM_BASE = process.env.CRM_API_BASE || ''
const OUTREACH_BASE = process.env.OUTREACH_API_BASE || ''
const MEETING_NOTES_BASE = process.env.MEETING_NOTES_API_BASE || ''

// ═══════════════════════════════════════════
//  CONNECTIONS — unified status, setup, and verification
//
//  Each integration knows:
//   - how to report live status (calls the actual API, not just env-var
//     presence — we want the user to see "✓ Connected as <account>")
//   - how to be configured from inside the app (paste a key → verify →
//     save persistently)
//   - where to deep-link for getting credentials
//   - how to disconnect cleanly
// ═══════════════════════════════════════════

export type ConnectionStatus = 'connected' | 'disconnected' | 'unverified'

// Built-in IDs are fixed; custom IDs are the `c_<...>` strings minted by
// custom-connections-config. The union is a string so renderer code stays
// permissive.
export type ConnectionId = string

export interface ConnectionItem {
  id: ConnectionId
  name: string
  category: 'CRM' | 'Google Workspace' | 'Messaging' | 'Outreach' | 'Meetings' | 'Developer' | 'Custom'
  status: ConnectionStatus
  account?: string
  details?: string
  disconnectable?: boolean
  isCustom?: boolean
  setup:
    | { kind: 'api-key'; keyId: KeyId; envKey: string; placeholder: string; getKeyUrl: string; docsUrl?: string; help: string }
    | { kind: 'slack-oauth'; getKeyUrl: string; help: string }
    | { kind: 'google-oauth'; tokenPath: string; getKeyUrl: string; help: string }
    | { kind: 'external-app'; appName: string; downloadUrl: string; help: string }
    | { kind: 'cli-tool'; binaryPath?: string; version?: string; installUrl: string; help: string }
    | { kind: 'custom-api'; envVarName: string; getKeyUrl?: string; verify?: { url: string; headerName: string; headerTemplate: string }; help: string }
    | { kind: 'custom-cli'; binaryPath?: string; version?: string; installUrl: string; help: string }
}

// ───────────────────────────────────────────────────────────────
//  Live API verification
//
//  Each verify function returns either a confirmation (with an account
//  label to show the user) or an error string. We use these in two
//  places: building the live status display, and validating user input
//  before save.
// ───────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean
  account?: string
  details?: string
  error?: string
}

async function verifyCrm(key: string): Promise<VerifyResult> {
  if (!key) return { ok: false, error: 'No API key' }
  if (!CRM_BASE) {
    // No base configured — accept the key but mark it unverified so the row
    // still surfaces. Set CRM_API_BASE to enable a live probe.
    return { ok: true, account: 'Saved (unverified)', details: `api-key …${key.slice(-4)}` }
  }
  try {
    // Probe a lightweight list endpoint on the configured CRM base.
    const resp = await fetch(
      `${CRM_BASE}/objects/task/resources?page[limit]=1`,
      {
        headers: { Authorization: `api-key ${key}` },
        signal: AbortSignal.timeout(8000),
      },
    )
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'Invalid API key (401/403)' }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return { ok: false, error: `${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}` }
    }
    return { ok: true, account: 'CRM workspace', details: `api-key …${key.slice(-4)}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' }
  }
}

async function verifyOutreach(key: string): Promise<VerifyResult> {
  if (!key) return { ok: false, error: 'No API key' }
  if (!OUTREACH_BASE) {
    // No base configured — accept the key but mark it unverified. Set
    // OUTREACH_API_BASE to enable a live probe against your outreach provider.
    return { ok: true, account: 'Saved (unverified)', details: `api-key …${key.slice(-4)}` }
  }
  try {
    // Probe a lightweight account/team endpoint on the configured base.
    const resp = await fetch(`${OUTREACH_BASE}/team`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'Invalid API key (401/403)' }
    if (!resp.ok) return { ok: false, error: `${resp.status} ${resp.statusText}` }
    const data = await resp.json().catch(() => ({} as any))
    const account = data?.name || data?.teamName || 'Outreach account'
    return { ok: true, account, details: `api-key …${key.slice(-4)}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' }
  }
}

async function verifySlackBotToken(token: string): Promise<VerifyResult> {
  if (!token) return { ok: false, error: 'No bot token' }
  if (!token.startsWith('xoxb-')) return { ok: false, error: 'Expected a bot token starting with xoxb-' }
  try {
    const resp = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    const data = await resp.json().catch(() => ({} as any))
    if (!data?.ok) return { ok: false, error: data?.error || `${resp.status} ${resp.statusText}` }
    return {
      ok: true,
      account: `${data.user ?? 'bot'} @ ${data.team ?? 'workspace'}`,
      details: `bot token …${token.slice(-4)}`,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' }
  }
}

async function verifyCustomApi(
  envVarName: string,
  verify: { url: string; headerName: string; headerTemplate: string } | undefined,
  key: string,
): Promise<VerifyResult> {
  if (!key) return { ok: false, error: 'No API key' }
  if (!verify?.url) {
    // No probe configured — call it unverified-but-saved.
    return { ok: true, account: 'Saved (unverified)', details: `${envVarName} …${key.slice(-4)}` }
  }
  try {
    const headerValue = verify.headerTemplate.replace(/\$\{KEY\}/g, key)
    const resp = await fetch(verify.url, {
      headers: { [verify.headerName]: headerValue },
      signal: AbortSignal.timeout(8000),
    })
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'Invalid API key (401/403)' }
    if (!resp.ok) return { ok: false, error: `${resp.status} ${resp.statusText}` }
    return { ok: true, account: envVarName, details: `…${key.slice(-4)}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' }
  }
}

const KEY_VERIFIERS: Record<KeyId, (key: string) => Promise<VerifyResult>> = {
  crm: verifyCrm,
  outreach: verifyOutreach,
  'slack-bot': verifySlackBotToken,
}

// ───────────────────────────────────────────────────────────────
//  Per-connection status builders
// ───────────────────────────────────────────────────────────────

async function getCrmStatus(): Promise<ConnectionItem> {
  const key = getApiKey('crm')
  const v = key ? await verifyCrm(key) : { ok: false, error: 'Not configured yet' }
  const status: ConnectionStatus = v.ok
    ? (v.account === 'Saved (unverified)' ? 'unverified' : 'connected')
    : 'disconnected'
  return {
    id: 'crm',
    name: 'CRM',
    category: 'CRM',
    status,
    account: v.ok ? v.account : undefined,
    details: v.ok ? v.details : (key ? `Key set but verification failed: ${v.error}` : 'No API key yet'),
    disconnectable: !!key,
    setup: {
      kind: 'api-key',
      keyId: 'crm',
      envKey: envKeyName('crm'),
      placeholder: 'paste CRM API key',
      getKeyUrl: '',
      help:
        'Paste your CRM API key here. Set CRM_API_BASE to your CRM API root so ROCA can ' +
        'verify the key against your workspace before saving.',
    },
  }
}

async function getGoogleStatus(): Promise<ConnectionItem> {
  const tokenPath = googleTokenPath()
  const tokenExists = googleTokenExists()
  let profile: { displayName: string; email: string } | null = null
  if (tokenExists) {
    try { profile = await gmail.gmailGetProfile() } catch { /* token may be broken */ }
  }
  const connected = !!profile
  return {
    id: 'google-workspace',
    name: 'Google Workspace',
    category: 'Google Workspace',
    status: connected ? 'connected' : 'disconnected',
    account: profile?.email,
    details: connected
      ? 'Gmail, Sheets, Calendar, Drive (shared OAuth token)'
      : tokenExists
        ? `Token at ${tokenPath} appears expired or invalid — re-authorize`
        : 'Not authorized yet',
    disconnectable: tokenExists,
    setup: {
      kind: 'google-oauth',
      tokenPath,
      getKeyUrl: 'https://console.cloud.google.com/apis/credentials',
      help:
        'Google Workspace shares one OAuth token for Gmail, Sheets, Calendar and Drive. ' +
        'Re-authorize by running the Google Tasks CLI auth flow from your agents repo, ' +
        'which writes a fresh token.json that ROCA reads on next launch.',
    },
  }
}

async function getSlackStatus(): Promise<ConnectionItem> {
  let s: Awaited<ReturnType<typeof slack.slackGetConnectionStatus>> | null = null
  try { s = await slack.slackGetConnectionStatus() } catch { s = null }
  const connected = !!s?.connected
  return {
    id: 'slack',
    name: 'Slack',
    category: 'Messaging',
    status: connected ? 'connected' : 'disconnected',
    account: s?.displayName || undefined,
    details: connected
      ? `${s?.team ?? 'workspace'} · ${s?.tokenKind === 'user' ? 'user token' : 'bot token'}`
      : 'Not connected',
    disconnectable: connected,
    setup: {
      kind: 'slack-oauth',
      getKeyUrl: 'https://api.slack.com/apps',
      help:
        'Connect with Slack OAuth so ROCA can read your DMs and channels as you. ' +
        'For bot-only posting, see the SLACK_BOT_TOKEN row under Messaging.',
    },
  }
}

async function getOutreachStatus(): Promise<ConnectionItem> {
  const key = getApiKey('outreach')
  const v = key ? await verifyOutreach(key) : { ok: false, error: 'Not configured yet' }
  const status: ConnectionStatus = v.ok
    ? (v.account === 'Saved (unverified)' ? 'unverified' : 'connected')
    : 'disconnected'
  return {
    id: 'outreach',
    name: 'Outreach',
    category: 'Outreach',
    status,
    account: v.ok ? v.account : undefined,
    details: v.ok ? v.details : (key ? `Key set but verification failed: ${v.error}` : 'No API key yet'),
    disconnectable: !!key,
    setup: {
      kind: 'api-key',
      keyId: 'outreach',
      envKey: envKeyName('outreach'),
      placeholder: 'paste Outreach API key',
      getKeyUrl: '',
      help:
        'Paste your outreach-provider API key here. Set OUTREACH_API_BASE to your provider\'s ' +
        'API root so ROCA can verify the key against your account before saving.',
    },
  }
}

async function getMeetingNotesStatus(): Promise<ConnectionItem> {
  // Optional local credential file for a meeting-notes desktop app. Point
  // MEETING_NOTES_CRED_PATH at the app's session file to enable detection.
  const credPath = process.env.MEETING_NOTES_CRED_PATH || ''
  const exists = !!credPath && fs.existsSync(credPath)
  let hasToken = false
  if (exists) {
    try {
      const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
      hasToken = !!(data.tokens || data.access_token)
    } catch { hasToken = false }
  }
  return {
    id: 'meeting_notes',
    name: 'Meeting Notes',
    category: 'Meetings',
    status: hasToken ? 'connected' : 'disconnected',
    account: hasToken ? 'Meeting Notes desktop app' : undefined,
    details: hasToken
      ? 'Meeting docs sync via desktop app session'
      : exists ? 'Installed but not signed in' : 'Meeting Notes desktop app not detected',
    disconnectable: false,
    setup: {
      kind: 'external-app',
      appName: 'Meeting Notes',
      downloadUrl: process.env.MEETING_NOTES_API_BASE || '',
      help:
        'Meeting-notes auth lives inside the meeting-notes desktop app. Install it, sign in, ' +
        'and ROCA will pick up the new session token automatically. Set MEETING_NOTES_CRED_PATH ' +
        'to the app\'s session file so ROCA can detect it.',
    },
  }
}

async function getClaudeCodeStatus(): Promise<ConnectionItem> {
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
  const binaryPath = candidates.find(p => { try { return fs.existsSync(p) } catch { return false } })

  let version: string | undefined
  if (binaryPath) {
    try {
      const { stdout } = await execFileAsync(binaryPath, ['--version'], { timeout: 3000 })
      version = stdout.trim().split('\n')[0]
    } catch { /* version probe failed */ }
  }

  const connected = !!binaryPath
  return {
    id: 'claude-code',
    name: 'Claude Code',
    category: 'Developer',
    status: connected ? 'connected' : 'disconnected',
    account: version || undefined,
    details: binaryPath
      ? `Powers terminal sessions · ${binaryPath}`
      : 'claude CLI not found on PATH — terminals will fail to spawn',
    disconnectable: false,
    setup: {
      kind: 'cli-tool',
      binaryPath,
      version,
      installUrl: 'https://docs.claude.com/en/docs/claude-code/quickstart',
      help:
        'Claude Code is a system-wide CLI installed via npm. Run ' +
        '`npm install -g @anthropic-ai/claude-code` in a terminal, then restart ROCA.',
    },
  }
}

async function getTerminalStatus(): Promise<ConnectionItem> {
  const shell = process.env.SHELL || ''
  const shellExists = !!shell && (() => { try { return fs.existsSync(shell) } catch { return false } })()

  // Probe whether the shell's interactive PATH includes `claude`. -l runs the
  // login shell so ~/.zprofile / ~/.zshrc are sourced; -c "which claude"
  // returns the resolved path or exits non-zero.
  let shellPathHasClaude = false
  let resolvedClaudePath: string | undefined
  if (shellExists) {
    try {
      const { stdout } = await execFileAsync(shell, ['-lc', 'which claude'], { timeout: 5000 })
      const line = stdout.split('\n').find(l => l.trim().length > 0)?.trim()
      if (line && line.startsWith('/')) {
        shellPathHasClaude = true
        resolvedClaudePath = line
      }
    } catch { /* `which` exited non-zero or shell errored */ }
  }

  const allOk = shellExists && shellPathHasClaude
  const status: ConnectionStatus = allOk
    ? 'connected'
    : (shellExists ? 'unverified' : 'disconnected')

  return {
    id: 'terminal',
    name: 'Terminal',
    category: 'Developer',
    status,
    account: allOk ? `${shell.split('/').pop()} · claude on PATH` : shell ? shell.split('/').pop() : undefined,
    details: !shellExists
      ? `$SHELL=${shell || '(unset)'} — shell binary not found, terminal panes can't spawn`
      : !shellPathHasClaude
        ? 'claude not on shell PATH — terminals will fail to spawn from Finder launches. Open ROCA via `npm run install-app` from a terminal, or add ~/.local/bin to PATH in ~/.zshrc.'
        : `Spawning via ${shell}; claude resolved to ${resolvedClaudePath ?? 'unknown'}`,
    disconnectable: false,
    setup: {
      kind: 'cli-tool',
      binaryPath: resolvedClaudePath,
      version: undefined,
      installUrl: 'https://docs.claude.com/en/docs/claude-code/quickstart',
      help:
        'Terminal panes use node-pty + your default shell ($SHELL) to spawn ' +
        'Claude Code. If `which claude` fails inside your shell, terminals ' +
        'will fail to start even though the binary exists on disk.',
    },
  }
}

async function getCustomConnectionStatus(c: CustomConnection): Promise<ConnectionItem> {
  if (c.kind === 'api') {
    const key = getRawKey(c.envVarName)
    const v = key
      ? await verifyCustomApi(c.envVarName, c.verify, key)
      : { ok: false, error: 'No key yet' } as VerifyResult
    const status: ConnectionStatus = v.ok
      ? (v.account === 'Saved (unverified)' ? 'unverified' : 'connected')
      : 'disconnected'
    return {
      id: c.id,
      name: c.name,
      category: 'Custom',
      status,
      account: v.ok ? v.account : undefined,
      details: v.ok ? v.details : (key ? `Key set but verification failed: ${v.error}` : 'No API key yet'),
      disconnectable: !!key,
      isCustom: true,
      setup: {
        kind: 'custom-api',
        envVarName: c.envVarName,
        getKeyUrl: c.getKeyUrl,
        verify: c.verify,
        help: `Custom API integration. Key is stored in api-keys.json under ${c.envVarName} and injected into process.env at startup.`,
      },
    }
  }
  if (c.kind === 'cli') {
    const binaryPath = c.binaryPaths.find(p => { try { return fs.existsSync(p) } catch { return false } })
    let version: string | undefined
    if (binaryPath) {
      try {
        const args = c.versionArgs.length > 0 ? c.versionArgs : ['--version']
        const { stdout } = await execFileAsync(binaryPath, args, { timeout: 3000 })
        version = stdout.trim().split('\n')[0]
      } catch { /* probe failed */ }
    }
    return {
      id: c.id,
      name: c.name,
      category: 'Custom',
      status: binaryPath ? 'connected' : 'disconnected',
      account: version,
      details: binaryPath ? `Found at ${binaryPath}` : `Not found in: ${c.binaryPaths.join(', ')}`,
      disconnectable: true,
      isCustom: true,
      setup: {
        kind: 'custom-cli',
        binaryPath,
        version,
        installUrl: c.installUrl,
        help: `Custom CLI integration. ROCA probes ${c.binaryPaths.join(', ')} on each refresh.`,
      },
    }
  }
  // MCP rows surface in the MCP section, not the Integrations list. Return a
  // minimal stub for completeness — the renderer filters these out before
  // grouping.
  return {
    id: c.id,
    name: c.name,
    category: 'Custom',
    status: 'unverified',
    isCustom: true,
    setup: { kind: 'custom-api', envVarName: '', help: '' },
  }
}

async function listConnections(): Promise<ConnectionItem[]> {
  const builtIn = await Promise.all([
    getCrmStatus(),
    getGoogleStatus(),
    getSlackStatus(),
    getMeetingNotesStatus(),
    getOutreachStatus(),
    getClaudeCodeStatus(),
    getTerminalStatus(),
  ])
  const custom = await Promise.all(
    listCustomConnections()
      .filter(c => c.kind !== 'mcp')           // MCP servers render in their own section
      .map(getCustomConnectionStatus),
  )
  return [...builtIn, ...custom]
}

async function disconnect(id: ConnectionId): Promise<{ ok: boolean; error?: string }> {
  try {
    // Custom-connection IDs start with `c_`.
    if (id.startsWith('c_')) {
      const conn = findCustomConnection(id)
      if (!conn) return { ok: false, error: 'Custom connection not found' }
      if (conn.kind === 'api') clearRawKey(conn.envVarName)
      removeCustomConnection(id)
      return { ok: true }
    }
    switch (id) {
      case 'slack':
        await slack.slackDisconnect()
        return { ok: true }
      case 'google-workspace': {
        const p = googleTokenPath()
        if (fs.existsSync(p)) fs.unlinkSync(p)
        return { ok: true }
      }
      case 'crm': clearApiKey('crm'); return { ok: true }
      case 'outreach': clearApiKey('outreach'); return { ok: true }
      case 'meeting_notes':
        return { ok: false, error: 'Meeting Notes auth lives inside the meeting-notes desktop app — sign out from there.' }
      case 'claude-code':
        return { ok: false, error: 'Claude Code is system-wide. Uninstall with `npm uninstall -g @anthropic-ai/claude-code`.' }
      case 'terminal':
        return { ok: false, error: 'Terminal uses your default shell — there is nothing to disconnect.' }
      default:
        return { ok: false, error: `Unknown connection id: ${id}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Save an API key after verifying it with the upstream service. Refuses to
// persist a key that fails verification so we never end up with a saved
// key that doesn't work.
async function saveKey(keyId: KeyId, key: string): Promise<VerifyResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: 'Empty key' }
  const verifier = KEY_VERIFIERS[keyId]
  const result = await verifier(trimmed)
  if (!result.ok) return result
  setApiKey(keyId, trimmed)
  return result
}

async function testKey(keyId: KeyId, key: string): Promise<VerifyResult> {
  const verifier = KEY_VERIFIERS[keyId]
  return verifier(key.trim())
}

// ═══════════════════════════════════════════
//  MESSAGING — credentials your agents use to send messages
// ═══════════════════════════════════════════

export interface MessagingChannelToken {
  channel: 'slack' | 'email'
  label: string
  status: 'configured' | 'unconfigured'
  details: string
  // For tokens we can manage in-app, pointer to the matching connection so
  // the renderer can pop the same setup modal as the Integrations row.
  managedBy?: ConnectionId
  envKey?: string
  getKeyUrl?: string
  instructions: string
}

async function listMessagingChannelTokens(): Promise<MessagingChannelToken[]> {
  const botToken = getApiKey('slack-bot')
  let userTokenStatus: 'configured' | 'unconfigured' = 'unconfigured'
  let userTokenDetails = 'Not connected'
  try {
    const s = await slack.slackGetConnectionStatus()
    if (s.connected && s.tokenKind === 'user') {
      userTokenStatus = 'configured'
      userTokenDetails = `${s.team ?? 'workspace'} · ${s.displayName ?? 'user token'}`
    } else if (s.connected) {
      userTokenDetails = 'Only a bot token is active — connect a user token to send DMs as you'
    }
  } catch { /* slackGetConnectionStatus failed */ }

  const googleTokenExists = fs.existsSync(googleTokenPath())
  let gmailProfile: { displayName: string; email: string } | null = null
  if (googleTokenExists) {
    try { gmailProfile = await gmail.gmailGetProfile() } catch { /* token broken */ }
  }
  const gmailConfigured = !!gmailProfile

  const botVerify = botToken ? await verifySlackBotToken(botToken) : null

  return [
    {
      channel: 'slack',
      label: 'Slack user token',
      status: userTokenStatus,
      details: userTokenDetails,
      managedBy: 'slack',
      getKeyUrl: 'https://api.slack.com/apps',
      instructions: 'Set up via Integrations → Slack. Lets bots reply as you and read your DMs.',
    },
    {
      channel: 'slack',
      label: 'Slack bot token',
      status: botVerify?.ok ? 'configured' : 'unconfigured',
      details: botVerify?.ok
        ? `${botVerify.account} · ${botVerify.details}`
        : botToken
          ? `Token set but verification failed: ${botVerify?.error}`
          : 'No bot token yet — bots can\'t post as a bot user',
      envKey: envKeyName('slack-bot'),
      getKeyUrl: 'https://api.slack.com/apps',
      instructions:
        'Create a Slack app at api.slack.com/apps → OAuth & Permissions → install to workspace, ' +
        'then paste the xoxb- token here.',
    },
    {
      channel: 'email',
      label: 'Gmail (agent mail)',
      status: gmailConfigured ? 'configured' : 'unconfigured',
      details: gmailConfigured
        ? `${gmailProfile!.email} — shared OAuth token for all email bots`
        : 'No Google Workspace token — connect it in Integrations first',
      managedBy: 'google-workspace',
      getKeyUrl: 'https://console.cloud.google.com/apis/credentials',
      instructions:
        'Email bots send mail via Google Workspace. Configure under Integrations → Google Workspace.',
    },
  ]
}

// ═══════════════════════════════════════════
//  HOOKS — Claude Code hooks from ~/.claude/settings.json
// ═══════════════════════════════════════════

export interface HookEntry {
  event: string
  matcher: string
  command: string
  type: string
  label: string
}

function listHooks(): HookEntry[] {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) return []
  let raw: any
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
  } catch {
    return []
  }
  const hooks = raw?.hooks
  if (!hooks || typeof hooks !== 'object') return []

  const out: HookEntry[] = []
  for (const [event, configs] of Object.entries(hooks)) {
    if (!Array.isArray(configs)) continue
    for (const cfg of configs as any[]) {
      const matcher = typeof cfg?.matcher === 'string' ? cfg.matcher : '*'
      const hookArr = Array.isArray(cfg?.hooks) ? cfg.hooks : []
      for (const h of hookArr) {
        const command = typeof h?.command === 'string' ? h.command : ''
        const type = typeof h?.type === 'string' ? h.type : 'command'
        const m = command.match(/([^/\s]+\.(?:sh|py|js|ts))/)
        const label = m ? m[1] : command.split(' ').slice(0, 2).join(' ')
        out.push({ event, matcher, command, type, label })
      }
    }
  }
  return out
}

// Reverse lookup of ENV_KEY for collision detection. Built once at module load.
const BUILTIN_ENV_KEYS: Record<string, string> = {
  crm: 'CRM_API_KEY',
  outreach: 'OUTREACH_API_KEY',
  'slack-bot': 'SLACK_BOT_TOKEN',
}

export interface AddCustomApiInput {
  kind: 'api'
  name: string
  envVarName: string
  apiKey: string
  getKeyUrl?: string
  verify?: { url: string; headerName: string; headerTemplate: string }
}

export interface AddCustomCliInput {
  kind: 'cli'
  name: string
  binaryPaths: string[]
  installUrl: string
  versionArgs: string[]
}

export type AddCustomConnectionInput = AddCustomApiInput | AddCustomCliInput

async function addCustom(input: AddCustomConnectionInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    if (input.kind === 'api') {
      const env = input.envVarName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      if (!env) return { ok: false, error: 'Env var name required' }
      if (Object.values(BUILTIN_ENV_KEYS).includes(env)) {
        return { ok: false, error: `${env} is already used by a built-in integration. Pick a different name.` }
      }
      setRawKey(env, input.apiKey.trim())
      const conn = addCustomConnection({
        kind: 'api',
        name: input.name.trim(),
        envVarName: env,
        getKeyUrl: input.getKeyUrl,
        verify: input.verify,
      } as Omit<CustomApiConnection, 'id'>)
      return { ok: true, id: conn.id }
    }
    // cli
    const conn = addCustomConnection({
      kind: 'cli',
      name: input.name.trim(),
      binaryPaths: input.binaryPaths,
      installUrl: input.installUrl,
      versionArgs: input.versionArgs,
    } as Omit<CustomCliConnection, 'id'>)
    return { ok: true, id: conn.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerConnectionsHandlers(): void {
  ipcMain.handle('connections:list', () => listConnections())
  ipcMain.handle('connections:disconnect', (_, id: ConnectionId) => disconnect(id))
  ipcMain.handle('connections:save-key', (_, keyId: KeyId, key: string) => saveKey(keyId, key))
  ipcMain.handle('connections:test-key', (_, keyId: KeyId, key: string) => testKey(keyId, key))
  ipcMain.handle('connections:open-external', (_, url: string) => shell.openExternal(url))
  ipcMain.handle('connections:list-hooks', () => listHooks())
  ipcMain.handle('connections:list-messaging-tokens', () => listMessagingChannelTokens())
  ipcMain.handle('connections:add-custom', (_, input: AddCustomConnectionInput) => addCustom(input))
  ipcMain.handle('connections:list-mcp', async (): Promise<{ available: boolean; servers: McpServer[] }> => {
    const available = await isClaudeAvailable()
    if (!available) return { available, servers: [] }
    try { return { available, servers: await listMcpServers() } }
    catch { return { available, servers: [] } }
  })
  ipcMain.handle('connections:add-mcp', async (_, spec: AddMcpServerSpec): Promise<{ ok: boolean; error?: string }> => {
    try {
      await addMcpServer(spec)
      // Also record in custom-connections.json so the row survives reinstalls.
      addCustomConnection({ kind: 'mcp', name: spec.name, scope: spec.scope } as Omit<CustomMcpConnection, 'id'>)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('connections:remove-mcp', async (_, name: string, scope: 'user' | 'project'): Promise<{ ok: boolean; error?: string }> => {
    try {
      await removeMcpServer(name, scope)
      // Also remove any matching custom-connections.json record.
      const stub = listCustomConnections().find(c => c.kind === 'mcp' && c.name === name)
      if (stub) removeCustomConnection(stub.id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
