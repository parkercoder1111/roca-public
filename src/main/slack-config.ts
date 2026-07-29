import { app } from 'electron'
import fs from 'fs'
import path from 'path'

// Persisted Slack user-token storage. Env vars still work, but a user-provided
// xoxp- token entered in the UI takes precedence so the user can connect without
// editing ~/.zshrc and restarting the app.

const CONFIG_FILE = 'slack-config.json'

interface SlackConfig {
  userToken?: string
  clientId?: string
  clientSecret?: string
}

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function readConfig(): SlackConfig {
  try {
    const p = configPath()
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as SlackConfig
  } catch {
    return {}
  }
}

function writeConfig(cfg: SlackConfig): void {
  const p = configPath()
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* best-effort */ }
}

export function getStoredUserToken(): string | undefined {
  return readConfig().userToken
}

export function setStoredUserToken(token: string): void {
  writeConfig({ ...readConfig(), userToken: token })
}

export function clearStoredUserToken(): void {
  const cfg = readConfig()
  delete cfg.userToken
  writeConfig(cfg)
}

export function getOAuthCredentials(): { clientId?: string; clientSecret?: string } {
  const cfg = readConfig()
  return { clientId: cfg.clientId, clientSecret: cfg.clientSecret }
}

export function setOAuthCredentials(clientId: string, clientSecret: string): void {
  writeConfig({ ...readConfig(), clientId, clientSecret })
}

export function hasOAuthCredentials(): boolean {
  const { clientId, clientSecret } = getOAuthCredentials()
  return !!(clientId && clientSecret)
}
