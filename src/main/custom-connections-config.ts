import { app } from 'electron'
import fs from 'fs'
import path from 'path'

// ═══════════════════════════════════════════
//  CUSTOM CONNECTIONS STORE
//
//  User-defined integrations added via Settings → Add Connection. Three kinds:
//   - api: an API key + optional verifier URL (key value lives in api-keys.json
//          under cfg.custom[envVarName]; this file holds the metadata).
//   - mcp: an MCP server (the actual server lives in Claude's config, managed
//          via the `claude mcp` CLI — we only mirror display metadata here for
//          ordering / removal records).
//   - cli: a CLI binary probe (no persisted secret).
// ═══════════════════════════════════════════

const CONFIG_FILE = 'custom-connections.json'

export type CustomConnectionKind = 'api' | 'mcp' | 'cli'

export interface CustomApiConnection {
  id: string                  // stable random id
  kind: 'api'
  name: string                // display name
  envVarName: string          // e.g. OPENAI_API_KEY
  getKeyUrl?: string
  verify?: {
    url: string
    headerName: string        // e.g. "Authorization"
    headerTemplate: string    // e.g. "Bearer ${KEY}"
  }
}

export interface CustomMcpConnection {
  id: string
  kind: 'mcp'
  name: string                // matches the name passed to `claude mcp add`
  scope: 'user' | 'project'
}

export interface CustomCliConnection {
  id: string
  kind: 'cli'
  name: string
  binaryPaths: string[]       // first existing wins
  installUrl: string
  versionArgs: string[]       // defaults to ['--version'] but stored explicitly
}

export type CustomConnection =
  | CustomApiConnection
  | CustomMcpConnection
  | CustomCliConnection

interface Store {
  connections: CustomConnection[]
}

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function read(): Store {
  try {
    const p = configPath()
    if (!fs.existsSync(p)) return { connections: [] }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Store
    return { connections: Array.isArray(parsed.connections) ? parsed.connections : [] }
  } catch {
    return { connections: [] }
  }
}

function write(store: Store): void {
  const p = configPath()
  fs.writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* best-effort */ }
}

function randomId(): string {
  // Tiny stable id — collision-safe enough for a handful of user entries.
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function listCustomConnections(): CustomConnection[] {
  return read().connections
}

export function addCustomConnection(
  spec: Omit<CustomConnection, 'id'>,
): CustomConnection {
  const store = read()
  const conn = { ...spec, id: randomId() } as CustomConnection
  store.connections.push(conn)
  write(store)
  return conn
}

export function removeCustomConnection(id: string): boolean {
  const store = read()
  const before = store.connections.length
  store.connections = store.connections.filter(c => c.id !== id)
  if (store.connections.length === before) return false
  write(store)
  return true
}

export function findCustomConnection(id: string): CustomConnection | undefined {
  return read().connections.find(c => c.id === id)
}
