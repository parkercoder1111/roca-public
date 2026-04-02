// ═══════════════════════════════════════════
//  ROCA Remote — Client (WebSocket + HTTP fallback)
// ═══════════════════════════════════════════

type EventCallback = (data: any) => void

let ws: WebSocket | null = null
let authenticated = false
let pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let eventListeners = new Map<string, Set<EventCallback>>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let msgId = 0
let currentHost = ''
let currentToken = ''
let onConnectionChange: ((connected: boolean) => void) | null = null

// Transport mode: 'ws' or 'http'
let transport: 'ws' | 'http' = 'ws'
let eventSource: EventSource | null = null

// Auto-detect protocol based on how the page was loaded
const isSecure = typeof location !== 'undefined' && location.protocol === 'https:'
const httpProto = isSecure ? 'https' : 'http'
const wsProto = isSecure ? 'wss' : 'ws'

export function setConnectionCallback(cb: (connected: boolean) => void) {
  onConnectionChange = cb
}

export function isConnected(): boolean {
  if (transport === 'http') return authenticated
  return ws !== null && ws.readyState === WebSocket.OPEN && authenticated
}

export function getTransport(): string { return transport }

export function connect(host: string, token: string): Promise<void> {
  currentHost = host
  currentToken = token

  // Try WebSocket first with a 3s timeout, fall back to HTTP
  return new Promise((resolve, reject) => {
    const wsTimeout = setTimeout(() => {
      // WS didn't connect in time — try HTTP
      if (ws) { ws.close(); ws = null }
      connectHttp(host, token).then(resolve).catch(reject)
    }, 3000)

    try {
      if (ws) { ws.close(); ws = null }
      authenticated = false

      const wsUrl = `${wsProto}://${host}`
      ws = new WebSocket(wsUrl)

      ws.onopen = async () => {
        clearTimeout(wsTimeout)
        try {
          await rpc('auth', { token })
          transport = 'ws'
          authenticated = true
          onConnectionChange?.(true)
          localStorage.setItem('roca-host', host)
          localStorage.setItem('roca-token', token)
          localStorage.setItem('roca-transport', 'ws')
          resolve()
        } catch {
          reject(new Error('Authentication failed'))
        }
      }

      ws.onmessage = handleWsMessage

      ws.onerror = () => {
        clearTimeout(wsTimeout)
        if (ws) { ws.close(); ws = null }
        // Fall back to HTTP
        connectHttp(host, token).then(resolve).catch(reject)
      }

      ws.onclose = () => {
        if (transport !== 'ws') return
        authenticated = false
        onConnectionChange?.(false)
        for (const { reject } of pendingRequests.values()) reject(new Error('Connection lost'))
        pendingRequests.clear()
        if (currentHost && currentToken) {
          reconnectTimer = setTimeout(() => {
            connect(currentHost, currentToken).catch(() => {})
          }, 3000)
        }
      }
    } catch {
      clearTimeout(wsTimeout)
      connectHttp(host, token).then(resolve).catch(reject)
    }
  })
}

// Polling state
let pollInterval: ReturnType<typeof setInterval> | null = null
let lastScrollbackLen = 0

function startPolling() {
  if (pollInterval) return
  pollInterval = setInterval(async () => {
    if (!authenticated || !currentHost || !currentToken) return
    try {
      // Poll PTY statuses
      const statuses = await httpRpc('pty:statuses')
      const listeners = eventListeners.get('pty:statuses')
      if (listeners) for (const cb of listeners) cb(statuses)

      // Poll scrollback for any subscribed PTYs
      for (const [ptyId] of eventListeners) {
        if (!ptyId.startsWith('pty:data')) continue
      }
    } catch { /* ignore polling errors */ }
  }, 2000)
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
  lastScrollbackLen = 0
}

async function connectHttp(host: string, token: string): Promise<void> {
  const base = `${httpProto}://${host}`
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, method: 'week:current', params: {} }),
  })
  const data = await res.json()
  if (data.error === 'unauthorized') throw new Error('Invalid token')

  transport = 'http'
  authenticated = true
  onConnectionChange?.(true)
  localStorage.setItem('roca-host', host)
  localStorage.setItem('roca-token', token)
  localStorage.setItem('roca-transport', 'http')

  // Try SSE, but don't fail the connection if it doesn't work
  let sseWorking = false
  if (eventSource) { eventSource.close(); eventSource = null }

  try {
    eventSource = new EventSource(`${httpProto}://${host}/api/events?token=${encodeURIComponent(token)}`)

    eventSource.onmessage = (ev) => {
      sseWorking = true
      // If SSE works, stop polling
      stopPolling()
      try {
        const msg = JSON.parse(ev.data)
        if (msg.event) {
          const listeners = eventListeners.get(msg.event)
          if (listeners) for (const cb of listeners) cb(msg.data)
        }
      } catch { /* ignore */ }
    }

    eventSource.onerror = () => {
      // SSE failed — don't kill the connection, just fall back to polling
      if (eventSource) { eventSource.close(); eventSource = null }
      if (!sseWorking) {
        startPolling()
      }
    }
  } catch {
    // SSE not available — use polling
    startPolling()
  }

  // Start polling as a backup — will be stopped if SSE works
  setTimeout(() => {
    if (!sseWorking) startPolling()
  }, 3000)
}

function handleWsMessage(ev: MessageEvent) {
  let msg: any
  try { msg = JSON.parse(ev.data) } catch { return }

  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject } = pendingRequests.get(msg.id)!
    pendingRequests.delete(msg.id)
    if (msg.error) reject(new Error(msg.error))
    else resolve(msg.result)
    return
  }

  if (msg.event) {
    const listeners = eventListeners.get(msg.event)
    if (listeners) {
      for (const cb of listeners) cb(msg.data)
    }
  }
}

export function disconnect() {
  currentHost = ''
  currentToken = ''
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (ws) ws.close()
  ws = null
  if (eventSource) { eventSource.close(); eventSource = null }
  authenticated = false
  transport = 'ws'
  localStorage.removeItem('roca-host')
  localStorage.removeItem('roca-token')
  localStorage.removeItem('roca-transport')
}

export function rpc(method: string, params?: any): Promise<any> {
  if (transport === 'http') return httpRpc(method, params)
  return wsRpc(method, params)
}

function wsRpc(method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Not connected'))
    }
    const id = String(++msgId)
    pendingRequests.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        reject(new Error('Request timeout'))
      }
    }, 30000)
  })
}

async function httpRpc(method: string, params?: any): Promise<any> {
  const base = `${httpProto}://${currentHost}`
  const res = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: currentToken, method, params: params || {} }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.result
}

export function on(event: string, callback: EventCallback): () => void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set())
  }
  eventListeners.get(event)!.add(callback)
  return () => { eventListeners.get(event)?.delete(callback) }
}

// ── Convenience API methods ──

export const api = {
  getTasks: (opts?: any) => rpc('tasks:list', opts),
  getTask: (taskId: number) => rpc('tasks:get', { taskId }),
  toggleTask: (taskId: number) => rpc('tasks:toggle', { taskId }),
  updateStatus: (taskId: number, status: string) => rpc('tasks:update-status', { taskId, status }),
  updateFields: (taskId: number, fields: any) => rpc('tasks:update-fields', { taskId, fields }),
  createTask: (task: any) => rpc('tasks:create', task),
  getFolders: (opts?: any) => rpc('folders:list', opts),
  getCurrentWeek: () => rpc('week:current'),
  getWeekData: (week?: string) => rpc('week:get', { week }),
  getInboxCount: (week?: string) => rpc('inbox:count', { week }),
  getOpenUnfoldered: (opts?: any) => rpc('tasks:open-unfoldered', opts),

  // Uploads
  uploadFile: async (taskId: number, file: File): Promise<any> => {
    const base = `${httpProto}://${currentHost}`
    const res = await fetch(
      `${base}/api/upload?token=${encodeURIComponent(currentToken)}&taskId=${taskId}&filename=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      }
    )
    return res.json()
  },
  getUploadsForTask: async (taskId: number): Promise<any[]> => {
    const base = `${httpProto}://${currentHost}`
    const res = await fetch(
      `${base}/api/task-uploads?token=${encodeURIComponent(currentToken)}&taskId=${taskId}`
    )
    const data = await res.json()
    return data.uploads || []
  },
  getUploadUrl: (storedName: string): string => {
    return `${httpProto}://${currentHost}/api/uploads/${storedName}?token=${encodeURIComponent(currentToken)}`
  },

  // PTY
  startPty: (taskId: string) => rpc('pty:start', { taskId }),
  writePty: (ptyId: string, data: string) => rpc('pty:write', { ptyId, data }),
  getPtyScrollback: (ptyId: string) => rpc('pty:scrollback', { ptyId }),
  getPtyStatuses: () => rpc('pty:statuses'),
  killPty: (ptyId: string) => rpc('pty:kill', { ptyId }),
  subscribePty: async (ptyId: string) => {
    if (transport === 'http') {
      // Tell server to push this PTY's data to our SSE stream
      await fetch(`${httpProto}://${currentHost}/api/pty-subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: currentToken, ptyId }),
      })
      return { ok: true }
    }
    return rpc('pty:subscribe', { ptyId })
  },
  unsubscribePty: (ptyId: string) => rpc('pty:unsubscribe', { ptyId }),

  // Environment
  getEnv: (key: string) => rpc('env:get', { key }),
}
