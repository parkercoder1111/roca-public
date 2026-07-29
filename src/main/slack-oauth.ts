import { shell } from 'electron'
import http from 'http'
import crypto from 'crypto'
import { URL } from 'url'
import { getOAuthCredentials } from './slack-config'

// One-shot OAuth flow: start localhost server → open browser to Slack's authorize
// URL → Slack redirects back with ?code=... → exchange code via oauth.v2.access →
// return the user token. Server shuts down after first callback.

const REDIRECT_PORT = 53682
const REDIRECT_PATH = '/slack/callback'
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

const USER_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
  'search:read',
  'chat:write',
].join(',')

export async function runSlackOAuth(): Promise<string> {
  const { clientId, clientSecret } = getOAuthCredentials()
  if (!clientId || !clientSecret) {
    throw new Error('Slack Client ID and Secret not configured')
  }

  const state = crypto.randomBytes(16).toString('hex')

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, token?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try { server.close() } catch { /* ignore */ }
      if (err) reject(err)
      else if (token) resolve(token)
    }

    const timeout = setTimeout(() => {
      finish(new Error('OAuth timed out after 5 minutes'))
    }, OAUTH_TIMEOUT_MS)

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`)
        if (reqUrl.pathname !== REDIRECT_PATH) {
          res.writeHead(404); res.end('Not found'); return
        }

        const code = reqUrl.searchParams.get('code')
        const returnedState = reqUrl.searchParams.get('state')
        const slackError = reqUrl.searchParams.get('error')

        if (slackError) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(renderPage('Slack authorization denied', `Slack returned: ${escapeHtml(slackError)}. You can close this tab.`))
          finish(new Error(`Slack denied authorization: ${slackError}`))
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(renderPage('Missing code', 'Slack did not return an authorization code.'))
          finish(new Error('No authorization code in callback'))
          return
        }

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(renderPage('State mismatch', 'Possible CSRF — aborting. You can close this tab.'))
          finish(new Error('OAuth state mismatch'))
          return
        }

        // Exchange code for tokens
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: REDIRECT_URI,
        }).toString()

        const resp = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(20000),
        })
        const data = await resp.json() as { ok: boolean; error?: string; authed_user?: { access_token?: string; scope?: string } }

        if (!data.ok || !data.authed_user?.access_token) {
          const msg = data.error || 'oauth.v2.access returned no user token'
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(renderPage('Token exchange failed', escapeHtml(msg)))
          finish(new Error(msg))
          return
        }

        const userToken = data.authed_user.access_token
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(renderPage('ROCA connected to Slack', 'You can close this tab and return to ROCA.'))
        finish(null, userToken)
      } catch (err) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/html' })
          res.end(renderPage('Unexpected error', escapeHtml(err instanceof Error ? err.message : String(err))))
        } catch { /* headers may already be sent */ }
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })

    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        finish(new Error(`Port ${REDIRECT_PORT} is already in use. Close whatever is using it and try again.`))
      } else {
        finish(err)
      }
    })

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const authUrl = new URL('https://slack.com/oauth/v2/authorize')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('user_scope', USER_SCOPES)
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
      authUrl.searchParams.set('state', state)
      shell.openExternal(authUrl.toString()).catch(err => finish(err))
    })
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#f9f9fb;color:#1a1a1f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:480px;padding:32px 40px;background:white;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,0.08);text-align:center}
h1{font-size:18px;margin:0 0 8px;font-weight:600}
p{font-size:14px;color:#555;margin:0;line-height:1.5}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${body}</p></div></body></html>`
}
