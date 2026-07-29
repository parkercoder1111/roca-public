import { ipcMain, shell, app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import type { IpcDeps } from './types'

export function registerSystemHandlers(deps: IpcDeps): void {
  // ── Environment ──
  ipcMain.handle('env:get', (_, key: string) => {
    const allowed = ['ELEVENLABS_API_KEY', 'OPENAI_API_KEY']
    return allowed.includes(key) ? process.env[key] || null : null
  })

  // Renamed in spirit: this used to call shell.openExternal but the app's
  // rule is "nothing leaves ROCA". Forward the URL back to the renderer
  // so it lands as a new top-level dynamic tab. Kept under the original
  // channel name so callers don't need to change.
  ipcMain.handle('shell:open-external', async (event, url: string) => {
    if (typeof url !== 'string') return false
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false
    event.sender.send('roca:open-url-in-new-tab', url)
    return true
  })

  // ── Debug ──
  ipcMain.handle('debug:write', (_, content: string) => {
    fs.writeFileSync('/tmp/roca-voice-debug.txt', content, 'utf8')
    return true
  })

  ipcMain.handle('error:write-log', async (_, content: string) => {
    const logPath = path.join(__dirname, '..', '..', '..', 'outputs', 'renderer-errors.log')
    const line = '\n--- ' + new Date().toISOString() + ' ---\n' + content + '\n'
    try {
      await fs.promises.appendFile(logPath, line)
    } catch (e) {
      console.error('[ROCA] error:write-log failed:', e)
    }
  })

  // Voice session diagnostics — append-only log + screenshots
  const voiceDiagDir = path.join(__dirname, '..', '..', '..', 'outputs', 'voice-diagnostics')
  ipcMain.handle('voice:log-session', (_, entry: {
    event: string; state: string; taskId: number | null; tab: string;
    error?: string; spokenText?: string; transcript?: string;
  }) => {
    if (!fs.existsSync(voiceDiagDir)) fs.mkdirSync(voiceDiagDir, { recursive: true })
    const ts = new Date().toISOString()
    const line = JSON.stringify({ ts, ...entry })
    fs.appendFileSync(path.join(voiceDiagDir, 'sessions.jsonl'), line + '\n')

    // Take screenshot on errors or session-end for review
    if (entry.event === 'error' || entry.event === 'session-end') {
      const screenshotFile = path.join(voiceDiagDir, `${ts.replace(/[:.]/g, '-')}_${entry.event}.png`)
      try {
        execSync(`screencapture -x "${screenshotFile}"`, { timeout: 5000 })
      } catch {}
    }
    return true
  })

  // Voice TTS playback trace — one JSONL line per boundary event in the
  // speak-the-reply path (enqueue → synth → play → end/error). Diagnoses the
  // intermittent "audio starts mid-paragraph" bug: reveals exactly which
  // sentence's audio is dropped and why. Read outputs/voice-diagnostics/tts-trace.jsonl.
  ipcMain.handle('voice:tts-trace', (_, entry: Record<string, unknown>) => {
    // userData (~/Library/Application Support/ROCA) — always writable in the
    // packaged app, unlike the bundle-relative outputs/ path used above.
    const traceDir = path.join(app.getPath('userData'), 'voice-diagnostics')
    if (!fs.existsSync(traceDir)) fs.mkdirSync(traceDir, { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    try { fs.appendFileSync(path.join(traceDir, 'tts-trace.jsonl'), line + '\n') } catch { /* non-fatal */ }
    return true
  })

  // ── Health ──
  ipcMain.handle('health', () => ({ status: 'ok', pid: process.pid }))

  // ── SSH config ──
  // Parses ~/.ssh/config into a flat list of host aliases the picker can show.
  // Multi-alias lines like `Host main remote` expand to one entry per
  // alias so each shows up individually. Wildcards (*, ?) are skipped since
  // they're patterns, not connectable hosts.
  ipcMain.handle('ssh:list-hosts', () => {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config')
    if (!fs.existsSync(sshConfigPath)) return []
    let text: string
    try { text = fs.readFileSync(sshConfigPath, 'utf8') } catch { return [] }

    const hosts: Array<{ alias: string; hostname?: string; user?: string }> = []
    let current: { aliases: string[]; hostname?: string; user?: string } | null = null

    const flush = () => {
      if (!current) return
      for (const alias of current.aliases) {
        if (alias.includes('*') || alias.includes('?')) continue
        hosts.push({ alias, hostname: current.hostname, user: current.user })
      }
      current = null
    }

    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const [keyRaw, ...rest] = line.split(/\s+/)
      const key = keyRaw.toLowerCase()
      const value = rest.join(' ')
      if (key === 'host') {
        flush()
        current = { aliases: rest }
      } else if (current && key === 'hostname') {
        current.hostname = value
      } else if (current && key === 'user') {
        current.user = value
      }
    }
    flush()
    return hosts
  })

  // Opens ~/.ssh/config in the user's default text editor so the picker's
  // "Add SSH host..." action has somewhere to go. Returns ok=false when the
  // file is missing (renderer can prompt to create it).
  ipcMain.handle('ssh:open-config', async () => {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config')
    if (!fs.existsSync(sshConfigPath)) {
      return { ok: false, path: sshConfigPath, reason: 'missing' as const }
    }
    const err = await shell.openPath(sshConfigPath)
    return { ok: err === '', path: sshConfigPath, error: err || undefined }
  })

  // IPC handler so desktop UI can show connection info
  ipcMain.handle('remote:info', () => {
    const nets = os.networkInterfaces()
    let localIp = 'localhost'
    for (const iface of Object.values(nets)) {
      for (const info of iface || []) {
        if (info.family === 'IPv4' && !info.internal) {
          localIp = info.address
          break
        }
      }
      if (localIp !== 'localhost') break
    }
    return {
      token: deps.remoteServer.getToken(),
      port: deps.remoteServer.getPort(),
      localIp,
    }
  })
}
