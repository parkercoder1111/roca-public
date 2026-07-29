import { app } from 'electron'
import fs from 'fs'
import path from 'path'

// ═══════════════════════════════════════════
//  API KEY STORAGE
//
//  Persistent store for API keys the user pastes in via Settings.
//
//  Two namespaces:
//   - `builtin` — the known integrations (crm, outreach, slack-bot). Each has
//     a fixed ENV_KEY mapping.
//   - `custom`  — user-defined keys keyed by env-var name (e.g. OPENAI_API_KEY).
//     Used by the "Add Connection" flow.
//
//  Both namespaces are written to api-keys.json (mode 0o600). hydrateEnv()
//  injects every saved key into process.env at startup, so existing consumers
//  (sync.ts, delegate.ts, child processes) keep using process.env without
//  refactor.
// ═══════════════════════════════════════════

const CONFIG_FILE = 'api-keys.json'

export type KeyId = 'crm' | 'outreach' | 'slack-bot'

const ENV_KEY: Record<KeyId, string> = {
  crm: 'CRM_API_KEY',
  outreach: 'OUTREACH_API_KEY',
  'slack-bot': 'SLACK_BOT_TOKEN',
}

// On-disk shape. We keep the old top-level KeyId fields for backwards
// compatibility (so an existing api-keys.json keeps working) and add a
// dedicated `custom` namespace for env-var-keyed user entries.
interface Config {
  crm?: string
  outreach?: string
  'slack-bot'?: string
  custom?: Record<string, string>
}

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function readConfig(): Config {
  try {
    const p = configPath()
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Config
  } catch {
    return {}
  }
}

function writeConfig(cfg: Config): void {
  const p = configPath()
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* best-effort */ }
}

// ── Built-in keys (unchanged public API) ─────────────────────────────────

export function getApiKey(id: KeyId): string {
  const cfg = readConfig()
  return cfg[id] || process.env[ENV_KEY[id]] || ''
}

export function setApiKey(id: KeyId, key: string): void {
  writeConfig({ ...readConfig(), [id]: key })
  process.env[ENV_KEY[id]] = key
}

export function clearApiKey(id: KeyId): void {
  const cfg = readConfig()
  delete cfg[id]
  writeConfig(cfg)
  delete process.env[ENV_KEY[id]]
}

export function envKeyName(id: KeyId): string {
  return ENV_KEY[id]
}

// ── Custom keys (env-var named, used by Add Connection) ─────────────────

export function getRawKey(envVarName: string): string {
  const cfg = readConfig()
  return cfg.custom?.[envVarName] || process.env[envVarName] || ''
}

export function setRawKey(envVarName: string, key: string): void {
  const cfg = readConfig()
  cfg.custom = { ...(cfg.custom ?? {}), [envVarName]: key }
  writeConfig(cfg)
  process.env[envVarName] = key
}

export function clearRawKey(envVarName: string): void {
  const cfg = readConfig()
  if (cfg.custom) {
    delete cfg.custom[envVarName]
    writeConfig(cfg)
  }
  delete process.env[envVarName]
}

export function listRawKeys(): Array<{ envVarName: string; suffix: string }> {
  const cfg = readConfig()
  return Object.entries(cfg.custom ?? {}).map(([envVarName, value]) => ({
    envVarName,
    suffix: value.slice(-4),
  }))
}

// ── Startup hydration ────────────────────────────────────────────────────

export function hydrateEnv(): void {
  const cfg = readConfig()
  for (const id of Object.keys(ENV_KEY) as KeyId[]) {
    const v = cfg[id]
    if (v) process.env[ENV_KEY[id]] = v
  }
  for (const [envVar, value] of Object.entries(cfg.custom ?? {})) {
    if (value) process.env[envVar] = value
  }
}
