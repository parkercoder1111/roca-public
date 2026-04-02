import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { app } from 'electron'
import type { PtyManager } from './ptyManager'
import { saveUpload, getUploadsForTask } from './database'

// ═══════════════════════════════════════════
//  ROCA Remote Server
//  Exposes tasks + PTY over WebSocket + HTTP fallback for mobile client
// ═══════════════════════════════════════════

const PORT = 19274  // ROCA on numpad
const TOKEN_FILE = 'remote-token.json'
import { ALLOWED_EXTENSIONS, MAX_UPLOAD_SIZE } from '../shared/constants'

interface RpcResponse {
  id: string
  result?: any
  error?: string
}

interface RpcEvent {
  event: string
  data: any
}

type RpcHandler = (params: any) => any | Promise<any>
type WebhookHandler = (payload: any) => any | Promise<any>

// HTTP SSE client for PTY streaming
interface SseClient {
  res: http.ServerResponse
  ptySubscriptions: Set<string>
}

export class RemoteServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private token: string = ''
  private clients = new Set<WebSocket>()
  private handlers = new Map<string, RpcHandler>()
  private webhookHandlers = new Map<string, { handler: WebhookHandler; secret?: string }>()
  private ptySubscriptions = new Map<string, Set<WebSocket>>() // ptyId → WS clients
  private sseClients = new Set<SseClient>()
  private ssePtySubscriptions = new Map<string, Set<SseClient>>() // ptyId → SSE clients
  private ptyManager: PtyManager | null = null
  private statusInterval: NodeJS.Timeout | null = null

  constructor() {
    this.token = this.loadOrCreateToken()
  }

  getToken(): string { return this.token }
  getPort(): number { return PORT }

  handle(method: string, handler: RpcHandler) {
    this.handlers.set(method, handler)
  }

  /** Register an HTTP webhook endpoint: POST /webhook/:name */
  webhook(name: string, handler: WebhookHandler, secret?: string) {
    this.webhookHandlers.set(name, { handler, secret })
  }

  setPtyManager(mgr: PtyManager) {
    this.ptyManager = mgr
  }

  /** Broadcast PTY data to subscribed clients (WS + SSE) */
  broadcastPtyData(ptyId: string, data: string) {
    // WebSocket clients
    const wsSubs = this.ptySubscriptions.get(ptyId)
    if (wsSubs && wsSubs.size > 0) {
      const msg = JSON.stringify({ event: 'pty:data', data: { ptyId, data } } satisfies RpcEvent)
      for (const ws of wsSubs) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg)
      }
    }
    // SSE clients
    const sseSubs = this.ssePtySubscriptions.get(ptyId)
    if (sseSubs && sseSubs.size > 0) {
      const payload = JSON.stringify({ event: 'pty:data', data: { ptyId, data } })
      for (const client of sseSubs) {
        try { client.res.write(`data: ${payload}\n\n`) } catch { /* client gone */ }
      }
    }
  }

  /** Broadcast PTY exit to subscribed clients (WS + SSE) */
  broadcastPtyExit(ptyId: string, exitCode: number) {
    // WebSocket clients
    const wsSubs = this.ptySubscriptions.get(ptyId)
    if (wsSubs && wsSubs.size > 0) {
      const msg = JSON.stringify({ event: 'pty:exit', data: { ptyId, exitCode } } satisfies RpcEvent)
      for (const ws of wsSubs) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg)
      }
    }
    this.ptySubscriptions.delete(ptyId)
    // SSE clients
    const sseSubs = this.ssePtySubscriptions.get(ptyId)
    if (sseSubs && sseSubs.size > 0) {
      const payload = JSON.stringify({ event: 'pty:exit', data: { ptyId, exitCode } })
      for (const client of sseSubs) {
        try { client.res.write(`data: ${payload}\n\n`) } catch { /* client gone */ }
      }
    }
    this.ssePtySubscriptions.delete(ptyId)
  }

  start() {
    const mobileDir = this.getMobileDir()

    this.server = http.createServer((req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

      const url = new URL(req.url || '/', `http://${req.headers.host}`)

      // ── API Routes ──

      if (url.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', app: 'roca-remote' }))
        return
      }

      // ── Webhook endpoints: POST /webhook/:name ──
      if (url.pathname.startsWith('/webhook/') && req.method === 'POST') {
        const webhookName = url.pathname.slice('/webhook/'.length)
        const entry = this.webhookHandlers.get(webhookName)
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown webhook' }))
          return
        }

        // Verify secret if configured
        if (entry.secret) {
          const authHeader = req.headers['authorization'] || ''
          const provided = authHeader.replace(/^Bearer\s+/i, '')
          if (provided !== entry.secret) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'unauthorized' }))
            return
          }
        }

        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body)
            const result = await entry.handler(payload)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result || { ok: true }))
          } catch (e: any) {
            console.error(`[webhook:${webhookName}] Error:`, e)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message || String(e) }))
          }
        })
        return
      }

      // HTTP RPC endpoint (fallback for when WebSocket doesn't work)
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const msg = JSON.parse(body)

            // Auth check
            if (msg.token !== this.token) {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'unauthorized' }))
              return
            }

            // Handle PTY subscribe/unsubscribe — no-op for HTTP (SSE handles streaming)
            if (msg.method === 'pty:subscribe' || msg.method === 'pty:unsubscribe') {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ result: { ok: true } }))
              return
            }

            const handler = this.handlers.get(msg.method)
            if (!handler) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: `unknown method: ${msg.method}` }))
              return
            }

            const result = await handler(msg.params || {})
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ result }))
          } catch (e: any) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message || String(e) }))
          }
        })
        return
      }

      // SSE event stream (fallback for WebSocket PTY streaming)
      if (url.pathname === '/api/events') {
        const authToken = url.searchParams.get('token')
        if (authToken !== this.token) {
          res.writeHead(401); res.end('unauthorized'); return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
        res.write(':ok\n\n')

        const client: SseClient = { res, ptySubscriptions: new Set() }
        this.sseClients.add(client)

        req.on('close', () => {
          this.sseClients.delete(client)
          for (const ptyId of client.ptySubscriptions) {
            this.ssePtySubscriptions.get(ptyId)?.delete(client)
          }
        })
        return
      }

      // SSE PTY subscribe (called by client to start receiving PTY data)
      if (url.pathname === '/api/pty-subscribe' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const msg = JSON.parse(body)
            if (msg.token !== this.token) {
              res.writeHead(401, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'unauthorized' }))
              return
            }
            const ptyId = msg.ptyId
            if (ptyId) {
              // Subscribe all SSE clients with matching token to this PTY
              for (const client of this.sseClients) {
                client.ptySubscriptions.add(ptyId)
                if (!this.ssePtySubscriptions.has(ptyId)) {
                  this.ssePtySubscriptions.set(ptyId, new Set())
                }
                this.ssePtySubscriptions.get(ptyId)!.add(client)
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ result: { ok: true } }))
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'bad request' }))
          }
        })
        return
      }

      // ── File upload (multipart-free: raw body + query params) ──
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const authToken = url.searchParams.get('token')
        if (authToken !== this.token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }

        const taskId = parseInt(url.searchParams.get('taskId') || '', 10)
        const filename = url.searchParams.get('filename') || 'upload.jpg'
        const mimeType = req.headers['content-type'] || 'application/octet-stream'

        if (!taskId || isNaN(taskId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'taskId required' }))
          return
        }

        const ext = path.extname(filename).toLowerCase()
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `File type ${ext} not allowed` }))
          return
        }

        const chunks: Buffer[] = []
        let totalSize = 0
        req.on('data', (chunk: Buffer) => {
          totalSize += chunk.length
          if (totalSize <= MAX_UPLOAD_SIZE) chunks.push(chunk)
        })
        req.on('end', () => {
          if (totalSize > MAX_UPLOAD_SIZE) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'File too large (max 10 MB)' }))
            return
          }

          const buf = Buffer.concat(chunks)
          const storedName = `${crypto.randomBytes(16).toString('hex')}${ext}`
          const uploadDir = this.getUploadDir()
          fs.writeFileSync(path.join(uploadDir, storedName), buf)

          const uploadId = saveUpload(taskId, filename, storedName, mimeType, buf.length)
          const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(ext)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: true,
            upload_id: uploadId,
            filename,
            stored_name: storedName,
            url: `/api/uploads/${storedName}`,
            is_image: isImage,
            size: buf.length,
          }))
        })
        return
      }

      // ── Serve uploaded files ──
      if (url.pathname.startsWith('/api/uploads/') && req.method === 'GET') {
        const authToken = url.searchParams.get('token')
        if (authToken !== this.token) {
          res.writeHead(401); res.end('unauthorized'); return
        }
        const storedName = url.pathname.slice('/api/uploads/'.length)
        if (!storedName || storedName.includes('..') || storedName.includes('/')) {
          res.writeHead(400); res.end('bad request'); return
        }
        const filePath = path.join(this.getUploadDir(), storedName)
        if (!fs.existsSync(filePath)) {
          res.writeHead(404); res.end('not found'); return
        }
        const ext = path.extname(storedName)
        const mimeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
          '.pdf': 'application/pdf',
        }
        const content = fs.readFileSync(filePath)
        res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' })
        res.end(content)
        return
      }

      // ── Get uploads for task ──
      if (url.pathname === '/api/task-uploads' && req.method === 'GET') {
        const authToken = url.searchParams.get('token')
        if (authToken !== this.token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const taskId = parseInt(url.searchParams.get('taskId') || '', 10)
        if (!taskId || isNaN(taskId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'taskId required' }))
          return
        }
        const uploads = getUploadsForTask(taskId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ uploads }))
        return
      }

      // ── Static files ──

      let filePath = url.pathname === '/' ? '/index.html' : url.pathname
      filePath = path.join(mobileDir, filePath)

      if (!filePath.startsWith(mobileDir)) {
        res.writeHead(403); res.end(); return
      }

      if (!fs.existsSync(filePath)) {
        filePath = path.join(mobileDir, 'index.html')
      }

      const ext = path.extname(filePath)
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
      }

      try {
        const content = fs.readFileSync(filePath)
        const headers: Record<string, string> = {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        }
        // Prevent caching HTML so phone always loads latest JS bundle
        if (ext === '.html') {
          headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        }
        res.writeHead(200, headers)
        res.end(content)
      } catch {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    // ── WebSocket (still works for desktop browser / localhost) ──

    this.wss = new WebSocketServer({ server: this.server })

    this.wss.on('connection', (ws) => {
      let authenticated = false

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          ws.send(JSON.stringify({ event: 'auth:fail', data: { reason: 'timeout' } }))
          ws.close()
        }
      }, 5000)

      ws.on('message', async (raw) => {
        let msg: any
        try { msg = JSON.parse(raw.toString()) } catch { return }

        if (!authenticated) {
          if (msg.method === 'auth' && msg.params?.token === this.token) {
            authenticated = true
            clearTimeout(authTimeout)
            this.clients.add(ws)
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true } } satisfies RpcResponse))
            return
          } else {
            ws.send(JSON.stringify({ id: msg.id || '0', error: 'unauthorized' } satisfies RpcResponse))
            return
          }
        }

        if (msg.method === 'pty:subscribe') {
          const ptyId = msg.params?.ptyId
          if (ptyId) {
            if (!this.ptySubscriptions.has(ptyId)) this.ptySubscriptions.set(ptyId, new Set())
            this.ptySubscriptions.get(ptyId)!.add(ws)
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }))
          }
          return
        }
        if (msg.method === 'pty:unsubscribe') {
          const ptyId = msg.params?.ptyId
          if (ptyId) this.ptySubscriptions.get(ptyId)?.delete(ws)
          ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }))
          return
        }

        const handler = this.handlers.get(msg.method)
        if (!handler) {
          ws.send(JSON.stringify({ id: msg.id, error: `unknown method: ${msg.method}` } satisfies RpcResponse))
          return
        }

        try {
          const result = await handler(msg.params || {})
          ws.send(JSON.stringify({ id: msg.id, result } satisfies RpcResponse))
        } catch (e: any) {
          ws.send(JSON.stringify({ id: msg.id, error: e.message || String(e) } satisfies RpcResponse))
        }
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        this.clients.delete(ws)
        for (const subs of this.ptySubscriptions.values()) subs.delete(ws)
      })
    })

    this.server.listen(PORT, '0.0.0.0', () => {
      console.log(`[RemoteServer] Listening on port ${PORT}`)
      console.log(`[RemoteServer] Token: ${this.token}`)
    })

    // Broadcast PTY statuses every 2s to WS + SSE clients
    this.statusInterval = setInterval(() => {
      if (!this.ptyManager) return
      const hasClients = this.clients.size > 0 || this.sseClients.size > 0
      if (!hasClients) return

      const statuses = this.ptyManager.getStatuses()

      // WS
      if (this.clients.size > 0) {
        const msg = JSON.stringify({ event: 'pty:statuses', data: statuses } satisfies RpcEvent)
        for (const ws of this.clients) {
          if (ws.readyState === WebSocket.OPEN) ws.send(msg)
        }
      }
      // SSE
      if (this.sseClients.size > 0) {
        const payload = JSON.stringify({ event: 'pty:statuses', data: statuses })
        for (const client of this.sseClients) {
          try { client.res.write(`data: ${payload}\n\n`) } catch { /* gone */ }
        }
      }
    }, 2000)
  }

  stop() {
    if (this.statusInterval) clearInterval(this.statusInterval)
    for (const ws of this.clients) ws.close()
    for (const client of this.sseClients) { try { client.res.end() } catch {} }
    this.wss?.close()
    this.server?.close()
  }

  private getMobileDir(): string {
    const candidates = [
      path.join(process.resourcesPath, 'mobile'),
      path.join(__dirname, '../../../dist/mobile'),
      path.join(process.env.HOME || '', 'repos/roca/dist/mobile'),
    ]
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir
    }
    return candidates[0] // fallback even if missing
  }

  private getUploadDir(): string {
    const dir = path.join(app.getPath('userData'), 'uploads')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private loadOrCreateToken(): string {
    const tokenPath = path.join(app.getPath('userData'), TOKEN_FILE)
    try {
      if (fs.existsSync(tokenPath)) {
        const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
        if (data.token) return data.token
      }
    } catch { /* regenerate */ }

    const token = crypto.randomBytes(3).toString('hex').toUpperCase()
    fs.writeFileSync(tokenPath, JSON.stringify({ token, createdAt: new Date().toISOString() }))
    return token
  }
}
